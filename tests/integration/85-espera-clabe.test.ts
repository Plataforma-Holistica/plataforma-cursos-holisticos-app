import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { clabeCheckDigit } from "@/domain/fiscal/clabe";
import { readTeacherStanding } from "@/services/teachers/records";
import { createTaxCipher } from "@/services/teachers/tax-cipher";
import { createTaxProfile, type TaxStore } from "@/services/teachers/tax-profile";
import { askTaxForPayout, askTaxMine, askTaxSave, askTaxState } from "@/services/teachers/tax-records";

import { claimedUser, clearThrottle, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { actAs, connect, financePerson, retire, waitBehind } from "./helpers/finance";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// La espera antes de que rija una CLABE nueva, contra la base y con el cifrado de verdad (T-409; decisiones de Sergio del 2026-11-01). La base no puede comparar dos
// CLABE: lo cifrado no se repite. Aquí se prueba que el servicio abre la vigente, compara y dice bien si cambió, y que falla cerrado. Cada condición de la base se rompe en
// `66_espera_clabe.test.sql`. Lo fiscal va en una transacción del dueño que se revierte, como en la integración 83.

const emails: string[] = [];
afterAll(async () => {
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
});

function keyEntry(version: number, raw: Buffer = randomBytes(32)): string {
  return `${version}:${raw.toString("base64")}:${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}
const firstKey = keyEntry(1);
const cipher = createTaxCipher(() => ({ keys: firstKey, active: "1" }));
const withClabe = (first17: string) => `${first17}${clabeCheckDigit(first17)}`;
const CLABE_A = withClabe("01218000123456789");
const CLABE_B = withClabe("01218000987654321");
const FORM = { rfc: "GODE561231GR8", regime: "626", legalName: "Elena Gómez Díaz", password: "no-se-comprueba-aqui" };

/** Otra cuenta con los mismos últimos cuatro: con solo comparar esos se saltaría la espera. */
function sameEnding(clabe: string): string {
  const tail = clabe.slice(14, 17);
  for (let i = 0; i < 100_000; i += 1) {
    const candidate = withClabe(`012180${String(i).padStart(8, "0")}${tail}`);
    if (candidate !== clabe && candidate.slice(-4) === clabe.slice(-4)) return candidate;
  }
  throw new Error("No se encontró otra CLABE con esa terminación.");
}

async function person() {
  await clearThrottle();
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const entered = await testServices().signIn(jar, who, freshOrigin());
  if (entered.kind !== "entered") throw new Error(`La persona de prueba no entró: ${entered.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, claims: check.claims };
}

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

async function asPersonServer<T>(owner: Client, claims: VerifiedClaims, work: (tx: Tx) => Promise<T>): Promise<T> {
  await asServer(owner, claims.userId, claims.sessionId ?? randomUUID());
  try {
    return await work(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

function serviceOn(owner: Client, who: { claims: VerifiedClaims }, reported: string[] = [], withCipher = cipher) {
  const store: TaxStore = {
    state: (claims) => asPersonServer(owner, claims, askTaxState),
    mine: (claims) => asPersonServer(owner, claims, askTaxMine),
    save: (claims, row) => asPersonServer(owner, claims, (tx) => askTaxSave(tx, row)),
    forPayout: (claims, payout) => asPersonServer(owner, claims, (tx) => askTaxForPayout(tx, payout)),
  };
  return createTaxProfile({
    store,
    cipher: withCipher,
    confirmPassword: () => Promise.resolve({ kind: "confirmed", claims: who.claims }),
    standing: (claims) => asPersonServer(owner, claims, (tx) => readTeacherStanding(tx, null)),
    checkSession: () => Promise.resolve({ kind: "pass", claims: who.claims } as never),
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
}

async function teacher(owner: Client, who: { id: string }): Promise<string> {
  await asSystem(owner);
  const { rows } = await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id", [who.id]);
  await owner.query("select set_config('app.actor_id', $1, true)", [who.id]);
  await owner.query("insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')", [who.id]);
  await asOwner(owner);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("No se creó el maestro.");
  return id;
}

const lastRow = async (owner: Client, id: string) =>
  (
    await owner.query<{ version: number; changed: Date; effective: Date }>(
      "select version, clabe_changed_at as changed, clabe_effective_from as effective from private.teacher_tax_profiles where teacher_id = $1 order by version desc limit 1",
      [id],
    )
  ).rows[0];

/** Hace madurar la última versión: el libro no admite cambios, salvo apagando sus disparadores. */
async function age(owner: Client, id: string) {
  await owner.query("set local session_replication_role = replica");
  await owner.query(
    `update private.teacher_tax_profiles set clabe_changed_at = now() - interval '100 hours', clabe_effective_from = now() - interval '28 hours'
     where teacher_id = $1 and version = (select max(version) from private.teacher_tax_profiles where teacher_id = $1)`,
    [id],
  );
  await owner.query("set local session_replication_role = origin");
}

const jar = memoryJar();

describe("el servicio dice si la CLABE cambió", () => {
  it("la primera captura espera, y el maestro ve desde cuándo rige", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner, ana);
      expect(await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 0 }, freshOrigin())).toEqual({ kind: "saved" });
      const row = await lastRow(owner, id);
      const state = await service.taxProfileState(ana.claims);
      expect(state?.clabeWaitsUntil).toBe(row?.effective.toISOString());
      expect(state?.clabeRecapture).toBe(false);
    });
  });

  it("con la misma CLABE y otro RFC no reinicia nada, aunque se vuelva a sellar", async () => {
    const ana = await person();
    const reported: string[] = [];
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner, ana, reported);
      await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 0 }, freshOrigin());
      await age(owner, id);
      const before = await lastRow(owner, id);
      expect(await service.saveTaxProfile(jar, { ...FORM, rfc: "ROCA800101AB1", clabe: CLABE_A, seen: 1 }, freshOrigin())).toEqual({ kind: "saved" });
      const after = await lastRow(owner, id);
      expect(after?.version).toBe(2);
      expect(after?.effective).toEqual(before?.effective);
      expect((await service.taxProfileState(ana.claims))?.clabeWaitsUntil).toBeNull();
    });
    expect(reported).toEqual([]);
  });

  it("con otra CLABE espera", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner, ana);
      await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 0 }, freshOrigin());
      await age(owner, id);
      await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_B, seen: 1 }, freshOrigin());
      expect((await lastRow(owner, id))?.effective.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it("con otra CLABE de los mismos últimos cuatro, también: se compara la cuenta entera", async () => {
    const ana = await person();
    const other = sameEnding(CLABE_A);
    expect(other).not.toBe(CLABE_A);
    expect(other.slice(-4)).toBe(CLABE_A.slice(-4));
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner, ana);
      await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 0 }, freshOrigin());
      await age(owner, id);
      expect(await service.saveTaxProfile(jar, { ...FORM, clabe: other, seen: 1 }, freshOrigin())).toEqual({ kind: "saved" });
      expect((await lastRow(owner, id))?.effective.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it("si lo vigente no abre, cuenta como cambio y se reporta: falla cerrado", async () => {
    const ana = await person();
    const reported: string[] = [];
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      await serviceOn(owner, ana).saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 0 }, freshOrigin());
      await age(owner, id);
      const otherKey = createTaxCipher(() => ({ keys: keyEntry(1), active: "1" }));
      const service = serviceOn(owner, ana, reported, otherKey);
      expect(await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 1 }, freshOrigin())).toEqual({ kind: "saved" });
      expect((await lastRow(owner, id))?.effective.getTime()).toBeGreaterThan(Date.now());
    });
    expect(reported).toEqual(["tax_profile_unreadable"]);
  });

  it("rotar la llave durante la espera no la reinicia: se compara lo abierto", async () => {
    const ana = await person();
    const reported: string[] = [];
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      await serviceOn(owner, ana).saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 0 }, freshOrigin());
      const before = await lastRow(owner, id);
      const rotated = createTaxCipher(() => ({ keys: `${firstKey},${keyEntry(2)}`, active: "2" }));
      const service = serviceOn(owner, ana, reported, rotated);
      expect(await service.saveTaxProfile(jar, { ...FORM, rfc: "ROCA800101AB1", clabe: CLABE_A, seen: 1 }, freshOrigin())).toEqual({ kind: "saved" });
      expect((await lastRow(owner, id))?.effective).toEqual(before?.effective);
    });
    expect(reported).toEqual([]);
  });

  it("una versión vista que ya no es la vigente no se guarda: otra entró en medio", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner, ana);
      await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 0 }, freshOrigin());
      await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_B, seen: 1 }, freshOrigin());
      expect(await service.saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 1 }, freshOrigin())).toEqual({ kind: "changed" });
      expect((await lastRow(owner, id))?.version).toBe(2);
    });
  });
});

describe("la lectura de finanzas", () => {
  it("las respuestas de la base las entiende el servicio: detenida, en espera, anulada y vigente", async () => {
    const ana = await person();
    const finance = await financePerson(emails);
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      await serviceOn(owner, ana).saveTaxProfile(jar, { ...FORM, clabe: CLABE_A, seen: 0 }, freshOrigin());
      await owner.query("set local session_replication_role = replica");
      const payout = (
        await owner.query<{ id: string }>(
          "insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents) values (202610, $1, gen_random_uuid(), 100, 100, 100) returning id",
          [id],
        )
      ).rows[0]!.id;
      const request = (
        await owner.query<{ id: string }>(
          "insert into private.teacher_suspension_requests (teacher_id, anomaly_alert_id, reason, proposed_by, proposed_at) values ($1, gen_random_uuid(), 'prueba', $2, now()) returning id",
          [id, finance.person.id],
        )
      ).rows[0]!.id;
      await owner.query("set local session_replication_role = origin");
      await actAs(owner, finance);
      const read = () => askTaxForPayout(txOn(owner), payout);

      const row = await lastRow(owner, id);
      expect(await read()).toEqual({ outcome: "clabe_held" });

      await owner.query("set local session_replication_role = replica");
      await owner.query("delete from private.teacher_suspension_requests where id = $1", [request]);
      await owner.query("set local session_replication_role = origin");
      expect(await read()).toEqual({ outcome: "clabe_waiting", until: row?.effective.toISOString() });

      await owner.query("update private.account_security set password_changed_at = clock_timestamp() where profile_id = $1", [ana.id]);
      expect(await read()).toEqual({ outcome: "clabe_recapture" });

      await age(owner, id);
      expect((await read()).outcome).toBe("ok");
    });
  });
});

describe("guardar mientras se confirma un fraude, de verdad", () => {
  it("si guardar entra primero, confirmar espera, y esa CLABE queda anulada", async () => {
    const ana = await person();
    const content = await financePerson(emails, "content");
    const proposer = await person();
    const seal = (length: number) => Buffer.from(`010001${"ab".repeat(12 + length + 16)}`, "hex");
    const owner = await connect();
    const saver = await connect();
    const confirmer = await connect();
    let id = "";
    try {
      await owner.query("grant app_service to postgres with set true, inherit false");
      await owner.query("begin");
      await owner.query("select set_config('app.actor_kind', 'system', true)");
      id = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status, suspended_at, suspension_reason) values ($1, 'suspended', now(), 'prueba') returning id::text", [ana.id])).rows[0]!.id;
      await owner.query("set local session_replication_role = replica");
      const request = (
        await owner.query<{ id: string }>(
          "insert into private.teacher_suspension_requests (teacher_id, anomaly_alert_id, reason, proposed_by, proposed_at) values ($1, gen_random_uuid(), 'prueba', $2, now()) returning id::text",
          [id, proposer.id],
        )
      ).rows[0]!.id;
      await owner.query("commit");

      await saver.query("begin");
      await asServer(saver, ana.id, ana.claims.sessionId ?? randomUUID());
      const saved = await saver.query<{ answer: string }>("select private.tax_profile_save($1, 0, $2, $3, '612', 'person', $4, '7771', 1, true) as answer", [id, seal(13), seal(20), seal(18)]);
      expect(saved.rows[0]?.answer).toBe("saved");

      await confirmer.query("begin");
      await actAs(confirmer, content);
      const confirming = confirmer.query<{ answer: string }>("select private.decide_fraud_suspension($1, true, null, 'Aviso.') as answer", [request]);
      await waitBehind(owner, saver, 1);
      await saver.query("commit");
      expect((await confirming).rows[0]?.answer).toBe("confirmed");
      await retire(confirmer, content);
      await confirmer.query("commit");

      const { rows } = await owner.query<{ standing: string }>(
        `select private.tax_clabe_standing(x.teacher_id, x.clabe_changed_at, x.clabe_effective_from) as standing
         from private.teacher_tax_profiles x where x.teacher_id = $1 order by x.version desc limit 1`,
        [id],
      );
      expect(rows[0]?.standing).toBe("dead");
    } finally {
      await saver.query("rollback").catch(() => undefined);
      await confirmer.query("rollback").catch(() => undefined);
      await owner.query("begin");
      await owner.query("set local session_replication_role = replica");
      if (id !== "") {
        await owner.query("delete from private.teacher_suspension_requests where teacher_id = $1", [id]);
        await owner.query("delete from private.teacher_tax_profiles where teacher_id = $1", [id]);
        await owner.query("delete from public.teachers where id = $1", [id]);
      }
      await owner.query("commit");
      await owner.query("revoke app_service from postgres");
      await Promise.all([owner.end(), saver.end(), confirmer.end()]);
    }
  });
});
