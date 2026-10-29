import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { asServer, ServerActor, Tx } from "@/adapters/supabase/db";
import { toDatabaseError } from "@/adapters/supabase/errors";
import type { SqlQuery } from "@/adapters/supabase/sql";

import { LEGAL_DOC_TYPES, PUBLISH_ANSWERS } from "./admin";
import { documentsOf, publishedOf, READ_ANSWERS, versionOf } from "./admin-records";
import { createLegalStore } from "./admin-store";

// Las consultas de PA-89 y lo que el almacén hace alrededor: a nombre de quién abre cada transacción, qué
// reintenta y cómo entiende lo que contestó la base. Contra la base de verdad corren en
// `tests/integration/59-textos-legales.test.ts`.

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const ID = "b0000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(64);
const VERSION_ROW = {
  id: ID,
  version: 1,
  title: "Términos",
  effective_from: "2026-10-28T18:00:00+00:00",
  published_at: "2026-10-28T18:00:00+00:00",
  body_sha256: SHA,
  is_draft: false,
  state: "current",
};
const RAW_DOCUMENTS = {
  fresh_code: true,
  today: "2026-10-28",
  documents: LEGAL_DOC_TYPES.map((doc_type) => ({ doc_type, last_version: doc_type === "terms" ? 1 : null, versions: doc_type === "terms" ? [VERSION_ROW] : [] })),
};

interface Sent {
  text: string;
  values: readonly unknown[];
}

function runnerWith(rows: unknown[], failures: unknown[] = []) {
  const opened: ServerActor[] = [];
  const sent: Sent[] = [];
  const pending = [...failures];
  const tx: Tx = {
    query<Row>(query: SqlQuery, row: ZodType<Row>): Promise<Row[]> {
      sent.push({ text: query.text.replace(/\s+/g, " ").trim(), values: query.values });
      return Promise.resolve(rows.map((each) => row.parse(each)));
    },
    execute: () => Promise.reject(new Error("Estas consultas no ejecutan sentencias.")),
  };
  const run = (async (actor: ServerActor, fn: (tx: Tx) => Promise<unknown>) => {
    opened.push(actor);
    if (pending.length > 0) throw pending.shift();
    return fn(tx);
  }) as typeof asServer;
  return { run, opened, sent };
}

const lockConflict = (code: string) => toDatabaseError({ code, severity: "ERROR" });

describe("lo que la base contesta, leído", () => {
  it("la tabla de PA-89: los nueve tipos en su orden, cada versión con su forma", () => {
    const read = documentsOf(RAW_DOCUMENTS);
    expect(read?.documents.map((each) => each.docType)).toEqual([...LEGAL_DOC_TYPES]);
    expect(read?.documents[0]).toEqual({
      docType: "terms",
      lastVersion: 1,
      versions: [{ id: ID, version: 1, title: "Términos", effectiveFrom: VERSION_ROW.effective_from, publishedAt: VERSION_ROW.published_at, bodySha256: SHA, isDraft: false, state: "current" }],
    });
    expect(read?.freshCode).toBe(true);
    expect(read?.today).toBe("2026-10-28");
    expect(documentsOf(null)).toBeNull();
  });

  it("otra forma lanza: un campo de más, un estado que no se conoce, los tipos en otro orden o sin uno", () => {
    const first = RAW_DOCUMENTS.documents[0];
    expect(() => documentsOf({ ...RAW_DOCUMENTS, extra: 1 })).toThrow();
    expect(() => documentsOf({ ...RAW_DOCUMENTS, documents: [{ ...first, versions: [{ ...VERSION_ROW, state: "otra" }] }, ...RAW_DOCUMENTS.documents.slice(1)] })).toThrow();
    expect(() => documentsOf({ ...RAW_DOCUMENTS, documents: [...RAW_DOCUMENTS.documents].reverse() })).toThrow();
    expect(() => documentsOf({ ...RAW_DOCUMENTS, documents: RAW_DOCUMENTS.documents.slice(1) })).toThrow();
    expect(() => documentsOf({ ...RAW_DOCUMENTS, today: "28/10/2026" })).toThrow();
  });

  it("una versión con su texto, sin documento si no existe, nula sin configuración", () => {
    const document = { ...VERSION_ROW, doc_type: "terms", body: "Texto" } as Record<string, unknown>;
    delete document.is_draft;
    delete document.state;
    expect(versionOf({ fresh_code: false, document })?.document).toMatchObject({ id: ID, docType: "terms", body: "Texto", bodySha256: SHA });
    expect(versionOf({ fresh_code: true, document: null })).toEqual({ document: null });
    expect(versionOf(null)).toBeNull();
    expect(() => versionOf({ fresh_code: true, document: { ...document, extra: 1 } })).toThrow();
  });

  it("publicar: cada respuesta de la lista, y ninguna más", () => {
    expect([...READ_ANSWERS].sort()).toEqual([...PUBLISH_ANSWERS].sort());
    expect(publishedOf({ answer: "published", id: ID, version: 2, effective_from: "2026-10-28T18:00:00+00:00" })).toEqual({
      answer: "published",
      id: ID,
      version: 2,
      effectiveFrom: "2026-10-28T18:00:00+00:00",
    });
    expect(publishedOf({ answer: "changed", version: 3 })).toEqual({ answer: "changed", version: 3 });
    expect(publishedOf({ answer: "changed", version: null })).toEqual({ answer: "changed", version: null });
    expect(publishedOf({ answer: "past" })).toEqual({ answer: "past" });
    expect(() => publishedOf({ answer: "otra" })).toThrow();
    expect(() => publishedOf({ answer: "published", version: 2, effective_from: "x" })).toThrow();
    expect(() => publishedOf({ answer: "published", id: ID, version: 0, effective_from: "x" })).toThrow();
    expect(() => publishedOf({ answer: "past", extra: 1 })).toThrow();
    expect(() => publishedOf(null)).toThrow();
  });
});

describe("el almacén", () => {
  it("lee la tabla como servidor, a nombre de las claims", async () => {
    const runner = runnerWith([{ read: RAW_DOCUMENTS }]);
    const read = await createLegalStore(runner.run).documents(claims);
    expect(read?.documents).toHaveLength(9);
    expect(runner.opened).toEqual([{ claims, reason: "legal_documents_admin" }]);
    expect(runner.sent).toEqual([{ text: "select private.legal_documents_admin() as read", values: [] }]);
  });

  it("lee una versión por su identificador", async () => {
    const runner = runnerWith([{ read: { fresh_code: true, document: null } }]);
    expect(await createLegalStore(runner.run).version(claims, ID)).toEqual({ document: null });
    expect(runner.opened).toEqual([{ claims, reason: "legal_document_admin" }]);
    expect(runner.sent).toEqual([{ text: "select private.legal_document_admin($1::uuid) as read", values: [ID] }]);
  });

  it("publica con lo que se le pasa, cada valor como parámetro", async () => {
    const runner = runnerWith([{ read: { answer: "past" } }]);
    const input = { docType: "terms" as const, title: "Términos", body: "Texto", day: "2026-10-28", seenVersion: null };
    expect(await createLegalStore(runner.run).publish(claims, input)).toEqual({ answer: "past" });
    expect(runner.opened).toEqual([{ claims, reason: "legal_publish" }]);
    expect(runner.sent[0]?.values).toEqual(["terms", "Términos", "Texto", "2026-10-28", null]);
    expect(runner.sent[0]?.text).toMatch(/^select private\.publish_legal_document\(\$1::text, \$2::text, \$3::text, \$4::date, \$5::integer\) as read$/);
  });

  it("un choque de candados al publicar se intenta una vez más; la segunda vez, se lanza", async () => {
    const input = { docType: "terms" as const, title: "T", body: "B", day: "2026-10-28", seenVersion: 1 };
    const retried = runnerWith([{ read: { answer: "changed", version: 2 } }], [lockConflict("40P01")]);
    expect(await createLegalStore(retried.run).publish(claims, input)).toEqual({ answer: "changed", version: 2 });
    expect(retried.opened).toHaveLength(2);
    const twice = runnerWith([{ read: { answer: "past" } }], [lockConflict("55P03"), lockConflict("55P03")]);
    await expect(createLegalStore(twice.run).publish(claims, input)).rejects.toThrow();
    expect(twice.opened).toHaveLength(2);
  });

  it("leer no se reintenta", async () => {
    const runner = runnerWith([{ read: RAW_DOCUMENTS }], [lockConflict("40P01")]);
    await expect(createLegalStore(runner.run).documents(claims)).rejects.toThrow();
    expect(runner.opened).toHaveLength(1);
  });
});
