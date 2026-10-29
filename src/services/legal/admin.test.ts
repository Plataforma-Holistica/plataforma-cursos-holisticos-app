import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, CodeGiven, TeamCheck, TeamStanding } from "@/services/account/team";

import { bodyFingerprint, createLegalAdmin, type LegalDocuments, type LegalStore, type Published } from "./admin";

// Los textos legales desde administración (PA-89), con todo lo de fuera simulado: a quién se le pregunta
// qué, en qué orden, y qué se decide con cada respuesta. Contra la base de verdad, en
// `tests/integration/59-textos-legales.test.ts` y `supabase/tests/56_textos_legales.test.sql`.

const ME = "a0000000-0000-4000-8000-000000000001";
const VERSION = "b0000000-0000-4000-8000-000000000002";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const DOCUMENTS: LegalDocuments = { freshCode: true, today: "2026-10-28", documents: [] };
const BODY = "# Reembolsos\n\nTexto.";
const SHA = bodyFingerprint(BODY);
const INPUT = { docType: "refund_policy", title: "  Reembolsos ", body: BODY, day: "2026-10-28", seenVersion: 1, seenSha: SHA };

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["config"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

function adminWith(
  setup: {
    check?: TeamCheck;
    published?: Published | "throws";
    documents?: LegalDocuments | null | "throws";
    version?: { document: unknown } | null | "throws";
    given?: CodeGiven;
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const store = {
    documents: vi.fn(() => {
      calls.push("documents");
      if (setup.documents === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.documents === undefined ? DOCUMENTS : setup.documents);
    }),
    version: vi.fn((_claims: VerifiedClaims, id: string) => {
      calls.push(`version ${id}`);
      if (setup.version === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.version === undefined ? { document: null } : setup.version);
    }),
    publish: vi.fn((_claims: VerifiedClaims, input: unknown) => {
      calls.push(`publish ${JSON.stringify(input)}`);
      if (setup.published === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.published ?? { answer: "published", id: VERSION, version: 2, effectiveFrom: "2026-10-28T18:00:00Z" });
    }),
  } as unknown as LegalStore & { [key: string]: ReturnType<typeof vi.fn> };
  const teamStanding = vi.fn(() => {
    calls.push("guarda");
    return Promise.resolve(setup.check ?? teamCheck());
  });
  const giveSecondFactorCode = vi.fn((_jar: unknown, code: string) => {
    calls.push(`código ${code}`);
    return Promise.resolve(setup.given ?? ({ kind: "verified" } as CodeGiven));
  });
  const service = createLegalAdmin(
    {
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { teamStanding, giveSecondFactorCode, store },
  );
  return { ...service, calls, reported, store };
}

const reader = { get: () => undefined };
const publishCalls = (service: ReturnType<typeof adminWith>) => (service.store.publish as unknown as ReturnType<typeof vi.fn>).mock.calls;
const jar = { get: () => undefined, set: () => undefined };

describe("publicar", () => {
  it("la guarda va primero, y solo pasa quien tiene configuración", async () => {
    for (const check of [teamCheck(standingOf(["content", "finance"])), { kind: "signed_out" } as unknown as TeamCheck]) {
      const service = adminWith({ check });
      expect(await service.publishLegalVersion(reader, INPUT)).toEqual({ kind: "refused" });
      expect(service.calls).toEqual(["guarda"]);
    }
    const unknown = adminWith({ check: { kind: "unavailable" } as TeamCheck });
    expect(await unknown.publishLegalVersion(reader, INPUT)).toEqual({ kind: "unavailable" });
    expect(unknown.calls).toEqual(["guarda"]);
  });

  it("lo que pasa la guarda va a la base ya revisado: el título en NFC y sin espacios, la versión vista", async () => {
    const service = adminWith();
    expect(await service.publishLegalVersion(reader, INPUT)).toEqual({
      kind: "answered",
      answer: "published",
      id: VERSION,
      version: 2,
      effectiveFrom: "2026-10-28T18:00:00Z",
    });
    expect(service.calls).toEqual([
      "guarda",
      `publish ${JSON.stringify({ docType: "refund_policy", title: "Reembolsos", body: BODY, day: "2026-10-28", seenVersion: 1 })}`,
    ]);
  });

  it("quien no vio ninguna versión manda nula", async () => {
    const service = adminWith();
    await service.publishLegalVersion(reader, { ...INPUT, seenVersion: null });
    expect(publishCalls(service)[0]?.[1]).toMatchObject({ seenVersion: null });
  });

  it("los retornos de carro del formulario no cambian la huella: se publica el texto con saltos de línea", async () => {
    const service = adminWith();
    const result = await service.publishLegalVersion(reader, { ...INPUT, body: BODY.replace(/\n/g, "\r\n") });
    expect(result.kind).toBe("answered");
    expect(publishCalls(service)[0]?.[1]).toMatchObject({ body: BODY });
  });

  it.each([
    ["un tipo que no existe", { docType: "inventado" }],
    ["sin tipo", { docType: undefined }],
    ["un título en blanco", { title: "  " }],
    ["un título que no es texto", { title: 3 }],
    ["un texto vacío", { body: "\n" }],
    ["un texto con un carácter de control", { body: "a\u0001b" }],
    ["un día sin forma", { day: "28/10/2026" }],
    ["una versión vista negativa", { seenVersion: -1 }],
    ["una versión vista que no es entera", { seenVersion: 1.5 }],
    ["una versión vista como texto", { seenVersion: "1" }],
    ["sin versión vista", { seenVersion: undefined }],
    ["una huella sin forma", { seenSha: "abc" }],
    ["una huella en mayúsculas", { seenSha: SHA.toUpperCase() }],
  ])("%s no llega a la base: malformed", async (_name, change) => {
    const service = adminWith();
    expect(await service.publishLegalVersion(reader, { ...INPUT, ...change })).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("un texto distinto del de la vista previa no se publica", async () => {
    const service = adminWith();
    expect(await service.publishLegalVersion(reader, { ...INPUT, body: `${BODY} Otra frase.` })).toEqual({ kind: "preview_stale" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("cada respuesta de la base se dice tal cual", async () => {
    for (const published of [
      { answer: "changed", version: 3 },
      { answer: "changed", version: null },
      { answer: "past" },
      { answer: "invalid" },
      { answer: "forbidden" },
      { answer: "needs_fresh_code" },
    ] as Published[]) {
      const service = adminWith({ published });
      expect(await service.publishLegalVersion(reader, INPUT)).toEqual({ kind: "answered", ...published });
      expect(service.reported).toEqual([]);
    }
  });

  it("si la base dice que falta la zona del periodo, se dice y se reporta", async () => {
    const service = adminWith({ published: { answer: "unavailable" } });
    expect(await service.publishLegalVersion(reader, INPUT)).toEqual({ kind: "answered", answer: "unavailable" });
    expect(service.reported).toEqual(["legal_change_unavailable"]);
  });

  it("sin respuesta, o con una que no se entiende, es «no se supo» y se reporta", async () => {
    const service = adminWith({ published: "throws" });
    expect(await service.publishLegalVersion(reader, INPUT)).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(["legal_change_unavailable"]);
  });
});

describe("leer", () => {
  it("los textos, para la sección que ya pasó su guarda", async () => {
    expect(await adminWith().legalDocuments(claims)).toEqual({ kind: "documents", documents: DOCUMENTS });
  });

  it("una lectura nula es «no se supo», sin reporte; una que falla, se reporta", async () => {
    const empty = adminWith({ documents: null });
    expect(await empty.legalDocuments(claims)).toEqual({ kind: "unavailable" });
    expect(empty.reported).toEqual([]);
    const failing = adminWith({ documents: "throws" });
    expect(await failing.legalDocuments(claims)).toEqual({ kind: "unavailable" });
    expect(failing.reported).toEqual(["legal_documents_unavailable"]);
  });

  it("una versión: por un identificador con forma, y lo que no existe es not_found", async () => {
    const text = { id: VERSION, docType: "terms", version: 1, title: "T", body: "B", effectiveFrom: "x", publishedAt: "y", bodySha256: SHA };
    expect(await adminWith({ version: { document: text } }).legalVersion(claims, VERSION)).toEqual({ kind: "version", text });
    expect(await adminWith().legalVersion(claims, VERSION)).toEqual({ kind: "not_found" });
    const unshaped = adminWith();
    expect(await unshaped.legalVersion(claims, VERSION.toUpperCase())).toEqual({ kind: "not_found" });
    expect(unshaped.calls).toEqual([]);
    expect(await adminWith({ version: null }).legalVersion(claims, VERSION)).toEqual({ kind: "unavailable" });
    const failing = adminWith({ version: "throws" });
    expect(await failing.legalVersion(claims, VERSION)).toEqual({ kind: "unavailable" });
    expect(failing.reported).toEqual(["legal_documents_unavailable"]);
  });
});

describe("dar el código otra vez", () => {
  it("verificado, comprueba lo reciente con la lectura de los textos", async () => {
    const service = adminWith();
    expect(await service.giveLegalCode(jar, "123456")).toEqual({ kind: "verified" });
    expect(service.calls).toEqual(["guarda", "código 123456", "guarda", "documents"]);
  });

  it("sin configuración no se verifica nada", async () => {
    const service = adminWith({ check: teamCheck(standingOf(["content"])) });
    expect(await service.giveLegalCode(jar, "123456")).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each(["wrong_code", "throttled", "unavailable"] as const)("%s se dice tal cual", async (kind) => {
    expect(await adminWith({ given: { kind } as CodeGiven }).giveLegalCode(jar, "123456")).toEqual({ kind });
  });

  it("cualquier otra respuesta del código: decide la página", async () => {
    expect(await adminWith({ given: { kind: "not_member" } as unknown as CodeGiven }).giveLegalCode(jar, "123456")).toEqual({ kind: "refused" });
  });

  it("si aun así el código no es reciente, es configuración: not_available, reportado", async () => {
    const service = adminWith({ documents: { ...DOCUMENTS, freshCode: false } });
    expect(await service.giveLegalCode(jar, "123456")).toEqual({ kind: "not_available" });
    expect(service.reported).toEqual(["legal_change_unavailable"]);
    const failing = adminWith({ documents: "throws" });
    expect(await failing.giveLegalCode(jar, "123456")).toEqual({ kind: "not_available" });
    expect(failing.reported).toEqual(["legal_change_unavailable"]);
    expect(await adminWith({ documents: null }).giveLegalCode(jar, "123456")).toEqual({ kind: "refused" });
  });
});
