import { describe, expect, it } from "vitest";

import { REQUIRED_DOC_TYPES } from "@/services/account/gate";
import type { FailureCode } from "@/services/error-reporting/server";
import { createLegalTexts, PUBLIC_DOC_TYPES, slugOfDocType } from "@/services/legal/texts";

import { currentTextIds } from "./helpers/account";
import { ownerQuery } from "./helpers/users";

// Leer un texto legal para pintarlo (RF-903, RF-108; diseño PA-07), contra la base local,
// que tiene los tres borradores (versión 0). Qué pregunta y cuánto recuerda el servicio,
// sin base, está en src/services/legal/texts.test.ts.

function legal(isLocal: boolean) {
  const reported: FailureCode[] = [];
  const texts = createLegalTexts({
    isLocal: () => isLocal,
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
  return { ...texts, reported };
}

describe("el texto vigente de un tipo público", () => {
  it("en local, el borrador: título, versión, vigencia y el cuerpo tal como está en la base", async () => {
    const ids = await currentTextIds();
    for (const [docType, id] of Object.entries(ids)) {
      const [stored] = await ownerQuery<{ title: string; body: string; version: number; effective: Date }>(
        "select title, body, version, effective_from as effective from public.legal_documents where id = $1::uuid",
        [id],
      );
      if (!stored) throw new Error("Falta el texto en la base.");
      const read = await legal(true).currentLegalText(docType);
      if (read.kind !== "found") throw new Error(`No se leyó ${docType}.`);
      expect(read.text).toEqual({
        docType,
        documentId: id,
        title: stored.title,
        body: stored.body,
        version: stored.version,
        effectiveFrom: stored.effective.toISOString(),
      });
    }
  });

  it("fuera de local un borrador no es un texto vigente: no se encuentra", async () => {
    const service = legal(false);
    expect(await service.currentLegalText("terms")).toEqual({ kind: "not_found" });
    expect(service.reported).toEqual([]);
  });

  it("un tipo público sin ningún texto no se encuentra, y no es un fallo", async () => {
    const service = legal(true);
    expect(await service.currentLegalText("refund_policy")).toEqual({ kind: "not_found" });
    expect(service.reported).toEqual([]);
  });
});

describe("la lista de tipos públicos", () => {
  it("es la misma que deja leer sin sesión la política de la base", async () => {
    const [policy] = await ownerQuery<{ qual: string }>(
      "select qual from pg_policies where schemaname = 'public' and tablename = 'legal_documents' and policyname = 'legal_documents_public_select'",
    );
    if (!policy) throw new Error("La base no tiene la política de lectura pública de los textos legales.");
    const inPolicy = [...policy.qual.matchAll(/'([a-z_]+)'::(?:public\.)?legal_doc_type/g)].map((match) => match[1]);
    expect(inPolicy.length).toBeGreaterThan(0);
    expect([...inPolicy].sort()).toEqual([...PUBLIC_DOC_TYPES].sort());
  });

  it("todo texto que una cuenta tiene que aceptar es público y tiene su página: nadie acepta lo que no puede leer", () => {
    for (const docType of REQUIRED_DOC_TYPES) {
      expect(PUBLIC_DOC_TYPES, docType).toContain(docType);
      expect(slugOfDocType(docType), docType).not.toBeNull();
    }
  });
});
