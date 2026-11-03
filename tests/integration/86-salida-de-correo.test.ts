import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createMailpitSender } from "@/adapters/mailpit/send";
import type { Tx } from "@/adapters/supabase/db";
import { mailCopy } from "@/app/_lib/mail-copy";
import type { MailSender, SendResult } from "@/domain/mail/mail";
import { dispatchMail, sweepMail } from "@/services/mail/mail";
import { createMailOutbox, type MailStore } from "@/services/mail/outbox";
import { askMailClaim, askMailHealth, askMailRejected, askMailSent } from "@/services/mail/records";

import { connect } from "./helpers/finance";
import { lastMailTo, linksIn, mailsTo } from "./helpers/mailbox";
import { asOwner, asSystem, reverted } from "./helpers/team";
import { ownerQuery } from "./helpers/users";

// La salida de correo contra la base y el buzón locales (T-604; decisión 7 de Sergio del 2026-11-02). Que la fecha cuente desde el envío lo prueba `67_salida_de_correo.test.sql`, en cada borde: aquí, que
// el servicio reclame, mande y anote de verdad, que lo que no salió no quede como enviado, y que dos a la vez no tomen la misma fila. Lo que se confirma lleva el prefijo `it-86-` y se quita al final.

const CLEAN_UP = `do $$ begin
  set local session_replication_role = replica;
  delete from private.mail_outbox where idempotency_key like 'CO-27:it-86-%';
end $$`;
afterAll(async () => {
  await ownerQuery(CLEAN_UP);
});

const INSERT = "insert into private.mail_outbox (idempotency_key, template, recipient, params) values ($1, 'CO-27', $2, $3::jsonb)";
const HOURS = JSON.stringify({ hours: 72 });

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

/** Como lo corre la aplicación: con el rol del servidor, como sistema. Vuelve al dueño para que la prueba mire. */
function storeOn(owner: Client): MailStore {
  const system = async <T,>(work: (tx: Tx) => Promise<T>): Promise<T> => {
    await asSystem(owner);
    await owner.query("select set_config('role', 'app_service', true)");
    try {
      return await work(txOn(owner));
    } finally {
      await asOwner(owner);
    }
  };
  return {
    claim: (limit) => system((tx) => askMailClaim(tx, limit)),
    sent: (id) => system((tx) => askMailSent(tx, id)),
    rejected: (id, attempt) => system((tx) => askMailRejected(tx, id, attempt)),
    health: () => system(askMailHealth),
  };
}

function outboxOn(owner: Client, send: MailSender, reported: string[] = []) {
  return createMailOutbox({
    store: storeOn(owner),
    sender: () => send,
    from: () => "Avisos <avisos@plataforma.local>",
    site: () => "https://plataforma.ejemplo.test",
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
}

const rowOf = async (owner: Client, key: string) =>
  (await owner.query<{ sent_at: Date | null; failed_at: Date | null; attempts: number }>("select sent_at, failed_at, attempts from private.mail_outbox where idempotency_key = $1", [key])).rows[0];

const replying = (result: SendResult): MailSender => () => Promise.resolve(result);
const newKey = () => `CO-27:it-86-${randomUUID()}`;

describe("mandar lo que toca", () => {
  it("cae en el buzón, con sus enlaces y sin nada de la cuenta, y queda anotado", async () => {
    const to = `it-86-${randomUUID()}@prueba.test`;
    const key = newKey();
    await reverted(async (owner) => {
      await owner.query(INSERT, [key, to, HOURS]);
      await outboxOn(owner, createMailpitSender({ url: process.env.MAILPIT_URL ?? "http://127.0.0.1:54324" })).dispatchMail(mailCopy);
      const row = await rowOf(owner, key);
      expect(row?.sent_at).toBeInstanceOf(Date);
      expect(row?.attempts).toBe(1);
    });
    const mail = await lastMailTo(to);
    expect(mail.subject).toBe("Se guardó una CLABE nueva en tu cuenta");
    expect(mail.text).toContain("72 horas");
    expect(linksIn(mail)).toEqual(["https://plataforma.ejemplo.test/recuperar", "https://plataforma.ejemplo.test/portal/datos-fiscales"]);
  });

  it("si el proveedor falla, no queda como enviado: vence y se vuelve a tomar", async () => {
    const key = newKey();
    const reported: string[] = [];
    await reverted(async (owner) => {
      await owner.query(INSERT, [key, "reintento@prueba.test", HOURS]);
      await outboxOn(owner, replying("retry"), reported).dispatchMail(mailCopy);
      expect((await rowOf(owner, key))?.sent_at).toBeNull();
      expect(reported).toContain("mail_retry");
      // Apartado, nadie lo toma: a un proveedor caído no se le insiste.
      await outboxOn(owner, replying("sent")).dispatchMail(mailCopy);
      expect((await rowOf(owner, key))?.sent_at).toBeNull();
      await owner.query("update private.mail_outbox set claimed_until = now() - interval '1 second' where idempotency_key = $1", [key]);
      await outboxOn(owner, replying("sent")).dispatchMail(mailCopy);
      const row = await rowOf(owner, key);
      expect(row?.sent_at).toBeInstanceOf(Date);
      expect(row?.attempts).toBe(2);
    });
  });

  it("un buzón que no contesta es «no se supo», no un error", async () => {
    const key = newKey();
    await reverted(async (owner) => {
      await owner.query(INSERT, [key, "cerrado@prueba.test", HOURS]);
      await outboxOn(owner, createMailpitSender({ url: "http://127.0.0.1:9" })).dispatchMail(mailCopy);
      expect((await rowOf(owner, key))?.sent_at).toBeNull();
    });
  });

  it("un rechazo se deja de intentar, y el barrido lo dice", async () => {
    const key = newKey();
    const reported: string[] = [];
    await reverted(async (owner) => {
      await owner.query(INSERT, [key, "rechazo@prueba.test", HOURS]);
      expect(await outboxOn(owner, replying("rejected"), reported).sweepMail(mailCopy)).toBe(true);
      expect((await rowOf(owner, key))?.failed_at).toBeInstanceOf(Date);
      expect(reported).toEqual(expect.arrayContaining(["mail_rejected", "mail_failed"]));
    });
  });

  it("una fila sin forma se deja de intentar, sin llamar a nadie", async () => {
    const key = newKey();
    let calls = 0;
    await reverted(async (owner) => {
      await owner.query(INSERT, [key, "forma@prueba.test", "{}"]);
      const counting: MailSender = () => {
        calls += 1;
        return Promise.resolve("sent");
      };
      await outboxOn(owner, counting).dispatchMail(mailCopy);
      expect((await rowOf(owner, key))?.failed_at).toBeInstanceOf(Date);
    });
    expect(calls).toBe(0);
  });
});

describe("con la aplicación armada de verdad", () => {
  it("el servicio llega a la base como sistema, y en local va al buzón", async () => {
    const to = `it-86-${randomUUID()}@prueba.test`;
    const key = newKey();
    await ownerQuery(INSERT, [key, to, HOURS]);
    await dispatchMail(mailCopy);
    await lastMailTo(to);
    const rows = await ownerQuery<{ sent: boolean }>("select sent_at is not null as sent from private.mail_outbox where idempotency_key = $1", [key]);
    expect(rows[0]?.sent).toBe(true);
    expect(await sweepMail(mailCopy)).toBe(true);
    expect((await mailsTo(to)).length).toBe(1);
  });
});

describe("dos a la vez", () => {
  it("no toman la misma fila, con dos conexiones de verdad", async () => {
    const key = newKey();
    await ownerQuery(INSERT, [key, "carrera@prueba.test", HOURS]);
    const [one, two] = await Promise.all([connect(), connect()]);
    try {
      await one.query("begin");
      const first = await one.query<{ idempotency_key: string }>("select idempotency_key from private.mail_claim(100)");
      expect(first.rows.map((row) => row.idempotency_key)).toContain(key);
      // Con la primera todavía abierta: la salta, sin esperarla.
      await two.query("begin");
      const second = await two.query<{ idempotency_key: string }>("select idempotency_key from private.mail_claim(100)");
      expect(second.rows.map((row) => row.idempotency_key)).not.toContain(key);
      await two.query("rollback");
      await one.query("commit");
      const rows = await ownerQuery<{ attempts: number }>("select attempts from private.mail_outbox where idempotency_key = $1", [key]);
      expect(rows[0]?.attempts).toBe(1);
    } finally {
      await one.end();
      await two.end();
    }
  });
});
