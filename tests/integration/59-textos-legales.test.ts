import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { asServer as runAsServer, Tx } from "@/adapters/supabase/db";
import { matchAccepted } from "@/services/account/forms";
import { evaluateGate, REQUIRED_DOC_TYPES } from "@/services/account/gate";
import { currentTexts } from "@/services/account/records";
import { createLegalStore } from "@/services/legal/admin-store";

import { claimedUser } from "./helpers/account";
import { actAs, connect, financePerson, retire, waitBehind, type Finance } from "./helpers/finance";
import { asOwner, asServer, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// PA-89 (T-110) contra la base local, con alguien de configuración de verdad (`helpers/finance`, con su
// capacidad): lo que una transacción revertida no puede mostrar, que dos publicaciones a la vez del mismo
// texto van una tras otra y la segunda se entera de que cambió; y, en transacciones que se revierten, que
// publicar unos términos vigentes le vuelve a pedir el consentimiento a una alumna (el criterio de T-110)
// y que un formulario abierto con el texto de antes ya no vale.
//
// Publicar es un libro que no se borra: lo que esta prueba confirma lo quita al terminar con las guardias
// apagadas (`session_replication_role = replica`), como la 58. La auditoría se queda. Usa el anexo de
// licencia, que ninguna otra prueba de integración publica.

let owner: Client;
let config: Finance;
// La carrera necesita a otra persona: la misma, en dos conexiones, esperaría su propia fila de capacidad.
let rival: Finance;
let student: string;
const emails: string[] = [];
const published: string[] = [];

const today = async (client: Client) =>
  (await client.query<{ day: string }>("select ((now() at time zone 'America/Mexico_City')::date)::text as day")).rows[0]!.day;

/** El almacén de la aplicación sobre una transacción del dueño, como servidor a nombre de esa persona, sin confirmar. */
function storeOn(client: Client, person: Finance) {
  const tx: Tx = {
    query: async (query, row) => (await client.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await client.query(query.text, [...query.values])).rowCount ?? 0,
  };
  const run = (async (_actor: unknown, work: (tx: Tx) => Promise<unknown>) => {
    await asServer(client, person.person.id, person.sessionId);
    try {
      return await work(tx);
    } finally {
      // Si la transacción ya abortó, volver al dueño también falla: que se vea el error de la base, no ese.
      await asOwner(client).catch(() => undefined);
    }
  }) as unknown as typeof runAsServer;
  return { store: createLegalStore(run), tx };
}

const claims = (person: Finance) => ({ userId: person.person.id, aal: "aal2", sessionId: person.sessionId, issuedAt: 0 }) as never;

beforeAll(async () => {
  owner = await connect();
  const taken = await owner.query("select 1 from public.legal_documents where doc_type = 'license_annex'");
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay un anexo de licencia en la base local: pnpm db:reset");
  config = await financePerson(emails, "config");
  rival = await financePerson(emails, "config");
  // Las conexiones del dueño toman el rol del servidor; se le quita al terminar (como la 54).
  await owner.query("grant app_service to postgres with set true, inherit false");
  const account = await claimedUser();
  emails.push(account.email);
  await completeAccountAsOwner(account.id);
  student = account.id;
});

afterAll(async () => {
  await owner.query("begin");
  await owner.query("set local session_replication_role = replica");
  await owner.query("delete from public.legal_documents where id = any($1::uuid[])", [published]);
  await owner.query("commit");
  await owner.query("revoke app_service from postgres");
  await owner.end();
  await deleteTestUsersByEmail(emails);
});

describe("dos publicaciones a la vez", () => {
  it("la segunda espera el candado del texto, ve la versión de la primera y contesta changed", async () => {
    const first = await connect();
    const second = await connect();
    try {
      const day = await today(owner);
      for (const [client, person] of [[first, config], [second, rival]] as const) {
        await client.query("begin");
        await actAs(client, person);
      }
      const publish = (client: Client, person: Finance) =>
        storeOn(client, person).store.publish(claims(person), { docType: "license_annex", title: "Anexo", body: "Texto del anexo.", day, seenVersion: null });

      const one = await publish(first, config);
      expect(one).toMatchObject({ answer: "published", version: 1 });
      if (one.answer === "published") published.push(one.id);
      const waiting = publish(second, rival);
      await waitBehind(owner, first, 1);
      await retire(first, config);
      await first.query("commit");
      expect(await waiting).toEqual({ answer: "changed", version: 1 });
      expect((await owner.query("select 1 from public.legal_documents where doc_type = 'license_annex'")).rowCount).toBe(1);
    } finally {
      await second.query("rollback").catch(() => undefined);
      await first.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
    }
  });
});

describe("publicar y volver a pedir el consentimiento", () => {
  it("unos términos que rigen ya le vuelven a pedir el consentimiento a una alumna que aceptó los de antes", async () => {
    const view = await reverted(async (client) => {
      await actAs(client, config);
      const { store, tx } = storeOn(client, config);
      const last = (await client.query<{ v: number | null }>("select max(version) as v from public.legal_documents where doc_type = 'terms'")).rows[0]!.v;
      const result = await store.publish(claims(config), { docType: "terms", title: "Términos", body: "Términos publicados.", day: await today(client), seenVersion: last });
      expect(result).toMatchObject({ answer: "published", version: (last ?? 0) + 1 });
      return evaluateGate(tx, student, true);
    }, false);
    expect(view).toEqual({
      kind: "incomplete",
      variant: "updated_texts",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
    });
  });

  it("unos con fecha futura no le piden nada todavía", async () => {
    const view = await reverted(async (client) => {
      await actAs(client, config);
      const { store, tx } = storeOn(client, config);
      const last = (await client.query<{ v: number | null }>("select max(version) as v from public.legal_documents where doc_type = 'terms'")).rows[0]!.v;
      const tomorrow = (await client.query<{ day: string }>("select ((now() at time zone 'America/Mexico_City')::date + 1)::text as day")).rows[0]!.day;
      expect(await store.publish(claims(config), { docType: "terms", title: "Términos", body: "Por venir.", day: tomorrow, seenVersion: last })).toMatchObject({ answer: "published" });
      return evaluateGate(tx, student, true);
    }, false);
    expect(view).toEqual({ kind: "pass" });
  });

  it("un formulario abierto con los términos de antes ya no vale cuando rigen los nuevos", async () => {
    const match = await reverted(async (client) => {
      const { store, tx } = storeOn(client, config);
      const before = await currentTexts(tx, true);
      await actAs(client, config);
      const last = (await client.query<{ v: number | null }>("select max(version) as v from public.legal_documents where doc_type = 'terms'")).rows[0]!.v;
      await store.publish(claims(config), { docType: "terms", title: "Términos", body: "Otros términos.", day: await today(client), seenVersion: last });
      const after = await currentTexts(tx, true);
      const accepted = before.flatMap((text) => (text.documentId === null ? [] : [text.documentId]));
      return matchAccepted(after, REQUIRED_DOC_TYPES, accepted);
    }, false);
    expect(match).toEqual({ kind: "stale" });
  });

  it("publicar no se puede en repeatable read: la comparación de la versión vista necesita ver lo confirmado", async () => {
    await reverted(async (client) => {
      await client.query("rollback");
      await client.query("begin isolation level repeatable read");
      await actAs(client, config);
      const { store } = storeOn(client, config);
      await expect(store.publish(claims(config), { docType: "license_annex", title: "A", body: "B", day: await today(client), seenVersion: 1 })).rejects.toMatchObject({ code: "25000" });
    }, false);
  });
});
