import { describe, expect, it } from "vitest";

import { LEGAL_DOC_TYPES } from "@/services/legal/admin";
import type { LegalDocuments, LegalVersion } from "@/services/legal/legal-admin";

import { acceptedPublishedNotice, legalView } from "./rows";

// Lo que PA-89 pinta de la base, ya en palabras (T-110).

const version = (over: Partial<LegalVersion>): LegalVersion => ({
  id: "b0000000-0000-4000-8000-000000000001",
  version: 1,
  title: "Términos",
  effectiveFrom: "2026-10-28T18:00:00Z",
  publishedAt: "2026-10-28T18:00:00Z",
  bodySha256: "0".repeat(64),
  isDraft: false,
  state: "current",
  ...over,
});

function documentsWith(versions: Partial<Record<(typeof LEGAL_DOC_TYPES)[number], LegalVersion[]>>, freshCode = true): LegalDocuments {
  return {
    freshCode,
    today: "2026-10-28",
    documents: LEGAL_DOC_TYPES.map((docType) => {
      const list = versions[docType] ?? [];
      return { docType, lastVersion: list[0]?.version ?? null, versions: list };
    }),
  };
}

describe("la vista de PA-89", () => {
  it("los nueve, con su nombre y lo que rige", () => {
    const view = legalView(
      documentsWith({
        terms: [
          version({ id: "b0000000-0000-4000-8000-000000000003", version: 3, title: "Términos 3", state: "scheduled", effectiveFrom: "2026-12-01T06:00:00Z" }),
          version({ id: "b0000000-0000-4000-8000-000000000002", version: 2, state: "superseded", effectiveFrom: "2027-01-01T06:00:00Z" }),
          version({ version: 1 }),
        ],
        course_history_consent: [version({ version: 0, isDraft: true })],
      }),
    );
    expect(view.documents.map((each) => each.name)).toEqual([
      "Términos y condiciones",
      "Aviso de privacidad del alumno",
      "Aviso de privacidad del maestro",
      "Política de comunidad",
      "Política de reembolsos",
      "Contrato del maestro",
      "Anexo de licencia",
      "Consentimiento del historial de cursos",
      "Consentimiento del cobro recurrente",
    ]);
    const [terms] = view.documents;
    expect(terms?.current).toBe("Vigente: versión 1, desde el 28 de octubre de 2026.");
    expect(terms?.scheduled).toEqual(["Programada: versión 3, desde el 1 de diciembre de 2026."]);
    expect(terms?.lastVersion).toBe(3);
    expect(terms?.lastTitle).toBe("Términos 3");
    expect(terms?.versions.map((each) => each.stateText)).toEqual(["Programada", "Reemplazada: no rige", "Vigente"]);
    expect(terms?.versions[2]?.href).toBe("/admin/textos-legales/b0000000-0000-4000-8000-000000000001");
    expect(view.documents[7]?.current).toBe("Vigente: un borrador sin validez legal (versión 0), que solo existe en la base local.");
    expect(view.documents[7]?.versions[0]?.stateText).toBe("Vigente · Borrador");
    expect(view.documents[1]?.current).toBe("Todavía no tiene ninguna versión.");
    expect(view.documents[1]?.lastTitle).toBe("Aviso de privacidad del alumno");
    expect(view.canChange).toBe(true);
    expect(view.today).toBe("2026-10-28");
  });

  it("varias programadas, de la más próxima a la más lejana", () => {
    const view = legalView(
      documentsWith({
        refund_policy: [
          version({ version: 3, state: "scheduled", effectiveFrom: "2027-02-01T06:00:00Z" }),
          version({ version: 2, state: "scheduled", effectiveFrom: "2027-01-01T06:00:00Z" }),
        ],
      }),
    );
    expect(view.documents[4]?.scheduled).toEqual([
      "Programada: versión 2, desde el 1 de enero de 2027.",
      "Programada: versión 3, desde el 1 de febrero de 2027.",
    ]);
  });

  it("el aviso de lo publicado se acepta solo con algo publicado hace un momento", () => {
    const read = documentsWith({ terms: [version({ publishedAt: "2026-10-28T18:00:00Z" })] });
    expect(acceptedPublishedNotice(read, "2026-10-28T18:00:30Z", 60)).toBe(true);
    expect(acceptedPublishedNotice(read, "2026-10-28T18:01:00Z", 60)).toBe(true);
    expect(acceptedPublishedNotice(read, "2026-10-28T18:01:01Z", 60)).toBe(false);
    expect(acceptedPublishedNotice(read, "2026-10-28T17:59:59Z", 60)).toBe(false);
    expect(acceptedPublishedNotice(documentsWith({}), "2026-10-28T18:00:30Z", 60)).toBe(false);
  });
});
