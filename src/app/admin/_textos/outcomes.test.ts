import { describe, expect, it } from "vitest";

import { PUBLISH_ANSWERS } from "@/services/legal/admin";
import type { VersionPublished } from "@/services/legal/legal-admin";

import { checkDraft, legalButton, legalCodeOutcome, publishOutcome, readLegalForm, type LegalDraft } from "./outcomes";

// La tabla de PA-89 (T-110): qué se pidió, qué se revisa antes de llamar a nadie y qué se pinta con cada
// respuesta. Cada respuesta de la base tiene su caso.

const SHA = "0".repeat(64);

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

const FIELDS: [string, string][] = [
  ["title", "Términos"],
  ["body", "Texto"],
  ["day", "2026-10-28"],
];
const DRAFT: LegalDraft = { docType: "terms", seen: 1, title: "Términos", body: "Texto", day: "2026-10-28" };

describe("lo que llega", () => {
  it.each([
    [legalButton.new("terms", 1), { step: "new", docType: "terms", seen: 1 }],
    [legalButton.new("recurring_charge_consent", null), { step: "new", docType: "recurring_charge_consent", seen: null }],
    [legalButton.new("refund_policy", 0), { step: "new", docType: "refund_policy", seen: 0 }],
    [legalButton.preview("terms", 1), { step: "preview", draft: DRAFT }],
    [legalButton.edit("terms", 1), { step: "edit", draft: DRAFT }],
    [legalButton.publish("terms", 1, SHA), { step: "publish", draft: DRAFT, sha: SHA }],
    [legalButton.cancel(), { step: "cancel" }],
  ])("%s", (value, request) => {
    expect(readLegalForm(form([["do", value], ...FIELDS]))).toEqual(request);
  });

  it.each([
    ["sin botón", []],
    ["dos botones", [["do", "cancel"], ["do", "cancel"]]],
    ["un verbo que no existe", [["do", "borrar:terms:1"]]],
    ["un tipo que no existe", [["do", "new:inventado:1"]]],
    ["sin versión vista", [["do", "new:terms"]]],
    ["una versión vista con cero a la izquierda", [["do", "new:terms:01"]]],
    ["una versión vista negativa", [["do", "new:terms:-1"]]],
    ["publicar sin huella", [["do", "publish:terms:1"]]],
    ["publicar con una huella sin forma", [["do", "publish:terms:1:abc"]]],
    ["una huella donde no va", [["do", `preview:terms:1:${SHA}`]]],
    ["de más", [["do", `publish:terms:1:${SHA}:x`]]],
    ["cancelar con algo más", [["do", "cancel:terms"]]],
    ["un botón desmedido", [["do", `new:terms:${"1".repeat(200)}`]]],
  ] as [string, [string, string][]][])("%s: nada", (_name, entries) => {
    expect(readLegalForm(form(entries))).toEqual({ step: "none" });
  });

  it("lo que no es un formulario cuenta como vacío", () => {
    expect(readLegalForm(null)).toEqual({ step: "none" });
    expect(readLegalForm({ do: "cancel" })).toEqual({ step: "none" });
  });

  it("un campo que falta llega vacío, y uno desmedido llega cortado", () => {
    const request = readLegalForm(form([["do", legalButton.preview("terms", null)], ["title", "t".repeat(5_000)]]));
    expect(request).toEqual({ step: "preview", draft: { docType: "terms", seen: null, title: "t".repeat(2_001), body: "", day: "" } });
  });
});

describe("lo que se revisa antes de llamar a nadie", () => {
  it("lo escrito con forma sale como se publica", () => {
    expect(checkDraft({ ...DRAFT, title: " Términos ", body: "Uno\r\nDos" }, "2026-10-28")).toEqual({
      ok: true,
      draft: { ...DRAFT, title: "Términos", body: "Uno\nDos" },
    });
  });

  it("cada campo dice lo suyo, todos a la vez", () => {
    expect(checkDraft({ ...DRAFT, title: null, body: " ", day: "2026-10-27" }, "2026-10-28")).toEqual({
      ok: false,
      problems: { title: "required", body: "required", day: "past" },
    });
    expect(checkDraft({ ...DRAFT, title: "a\u0007", body: "a\u0001", day: "2026-13-01" }, "2026-10-28")).toEqual({
      ok: false,
      problems: { title: "invalid", body: "invalid", day: "invalid" },
    });
    expect(checkDraft({ ...DRAFT, day: "" }, "2026-10-28")).toEqual({ ok: false, problems: { day: "required" } });
    expect(checkDraft({ ...DRAFT, day: "2028-01-01" }, "2026-10-28")).toEqual({ ok: false, problems: { day: "too_far" } });
  });
});

describe("lo que se pinta con cada respuesta", () => {
  const TO_PAGE = { kind: "leave", to: "/admin/textos-legales", notice: null };

  it("cada respuesta de la base tiene su caso", () => {
    const outcomes = Object.fromEntries(
      PUBLISH_ANSWERS.map((answer) => {
        const result = (
          answer === "published"
            ? { kind: "answered", answer, id: "b0000000-0000-4000-8000-000000000002", version: 2, effectiveFrom: "x" }
            : answer === "changed"
              ? { kind: "answered", answer, version: 4 }
              : { kind: "answered", answer }
        ) as VersionPublished;
        return [answer, publishOutcome(result, 1)];
      }),
    );
    expect(outcomes).toEqual({
      forbidden: TO_PAGE,
      needs_fresh_code: { kind: "preview", failure: "needs_code", refresh: true },
      invalid: { kind: "preview", failure: "unavailable", refresh: false },
      past: { kind: "compose", seen: 1, problems: { day: "past" }, changed: false, refresh: false },
      unavailable: { kind: "failed", reason: "no_zone", refresh: false },
      changed: { kind: "compose", seen: 4, problems: {}, changed: true, refresh: true },
      published: { kind: "leave", to: "/admin/textos-legales", notice: "legal_published" },
    });
  });

  it("lo que dice el servicio antes de la base", () => {
    expect(publishOutcome({ kind: "refused" }, 1)).toEqual(TO_PAGE);
    expect(publishOutcome({ kind: "unavailable" }, 1)).toEqual({ kind: "preview", failure: "unavailable", refresh: false });
    expect(publishOutcome({ kind: "malformed" }, 1)).toEqual({ kind: "preview", failure: "unavailable", refresh: false });
    expect(publishOutcome({ kind: "preview_stale" }, 1)).toEqual({ kind: "preview", failure: "stale", refresh: false });
    // «No se supo» nunca se pinta como hecho, y la lista pudo cambiar.
    expect(publishOutcome({ kind: "unknown" }, 1)).toEqual({ kind: "failed", reason: "unknown", refresh: true });
  });

  it("dar el código: la tabla compartida, con esta página", () => {
    expect(legalCodeOutcome({ kind: "verified" })).toEqual(TO_PAGE);
    expect(legalCodeOutcome({ kind: "refused" })).toEqual(TO_PAGE);
    expect(legalCodeOutcome({ kind: "wrong_code" })).toEqual({ kind: "failed", reason: "wrong_code" });
  });
});
