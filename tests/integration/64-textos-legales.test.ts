import { describe, expect, it } from "vitest";

import { isLinkToken } from "@/services/account/account";
import { createLegalTexts, docTypeOfSlug, LEGAL_SLUGS, slugOfDocType } from "@/services/legal/texts";
import type { FailureCode } from "@/services/error-reporting/server";

import { currentTextIds } from "./helpers/account";
import { ownerQuery } from "./helpers/users";

// Leer un texto legal para pintarlo (RF-903, RF-108; diseño PA-07), contra la base local,
// que tiene los tres borradores (versión 0).

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
      expect(read.text).toMatchObject({ docType, documentId: id, title: stored.title, body: stored.body, version: stored.version });
      expect(new Date(read.text.effectiveFrom).getTime()).toBe(stored.effective.getTime());
    }
  });

  it("fuera de local un borrador no es un texto vigente: no se encuentra", async () => {
    const service = legal(false);
    expect(await service.currentLegalText("terms")).toEqual({ kind: "not_found" });
    expect(service.reported).toEqual([]);
  });

  it.each(["license_annex", "teacher_privacy_notice", "no_existe", "", "terms; drop table x", "TERMS"])(
    "un tipo que no es público, o que no existe, no se encuentra ni llega a la base: %s",
    async (docType) => {
      const service = legal(true);
      expect(await service.currentLegalText(docType)).toEqual({ kind: "not_found" });
      expect(service.reported).toEqual([]);
    },
  );

  it("un tipo público sin ningún texto no se encuentra", async () => {
    expect(await legal(true).currentLegalText("refund_policy")).toEqual({ kind: "not_found" });
  });
});

describe("la dirección de cada texto", () => {
  it("cada dirección lleva a un tipo público, y de vuelta", () => {
    expect(Object.keys(LEGAL_SLUGS).sort()).toEqual(["historial-de-cursos", "privacidad", "terminos"]);
    for (const [slug, docType] of Object.entries(LEGAL_SLUGS)) {
      expect(docTypeOfSlug(slug)).toBe(docType);
      expect(slugOfDocType(docType)).toBe(slug);
    }
  });

  it.each(["", "terms", "Terminos", "terminos/", "__proto__", "constructor", "toString"])(
    "una dirección que no está en la lista no lleva a nada: %s",
    (slug) => {
      expect(docTypeOfSlug(slug)).toBeNull();
    },
  );

  it("un tipo sin dirección no tiene enlace", () => {
    expect(slugOfDocType("refund_policy")).toBeNull();
    expect(slugOfDocType("__proto__")).toBeNull();
  });
});

describe("la forma de un enlace de correo", () => {
  it.each(["a".repeat(8), "a".repeat(56), "Ab0_-xyz", "a".repeat(256)])("puede ser un enlace: %s", (token) => {
    expect(isLinkToken(token)).toBe(true);
  });

  it.each(["", "a".repeat(7), "a".repeat(257), "abc def gh", "abcdefg/", "abcdefg.", "abcdefg%", "abcdefgñ", "../../etc", "a".repeat(8) + "\n"])(
    "no puede ser un enlace: %s",
    (token) => {
      expect(isLinkToken(token)).toBe(false);
    },
  );
});
