import { describe, expect, it } from "vitest";

import { docTypeOfSlug, isPublicDocType, LEGAL_SLUGS, PUBLIC_DOC_TYPES, slugOfDocType } from "./slugs";

describe("la dirección de cada texto legal", () => {
  it("cada dirección lleva a un tipo público, y de vuelta", () => {
    expect(Object.keys(LEGAL_SLUGS).sort()).toEqual(["historial-de-cursos", "privacidad", "terminos"]);
    for (const [slug, docType] of Object.entries(LEGAL_SLUGS)) {
      expect(docTypeOfSlug(slug)).toBe(docType);
      expect(slugOfDocType(docType)).toBe(slug);
      expect(isPublicDocType(docType)).toBe(true);
    }
  });

  it.each(["", "terms", "Terminos", "terminos/", " terminos", "__proto__", "constructor", "toString"])(
    "una dirección que no está en la lista no lleva a nada: %j",
    (slug) => {
      expect(docTypeOfSlug(slug)).toBeNull();
    },
  );

  it("un tipo sin dirección no tiene enlace", () => {
    expect(slugOfDocType("refund_policy")).toBeNull();
    expect(slugOfDocType("__proto__")).toBeNull();
    expect(slugOfDocType("")).toBeNull();
  });
});

describe("qué tipos se leen sin sesión", () => {
  it("los seis públicos, y ninguno más", () => {
    for (const docType of PUBLIC_DOC_TYPES) expect(isPublicDocType(docType)).toBe(true);
    for (const docType of ["license_annex", "teacher_agreement", "teacher_privacy_notice", "", "TERMS", "terms ", "__proto__", "constructor"]) {
      expect(isPublicDocType(docType)).toBe(false);
    }
  });
});
