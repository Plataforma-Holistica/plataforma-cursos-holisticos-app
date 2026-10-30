import { describe, expect, it } from "vitest";

import type { DraftChange } from "@/services/drafts/editor";

import { changeOutcome, type DraftAnswer } from "./change";

// Lo que contesta un cambio al borrador, traducido para cualquier pantalla del portal (T-402).

const BACK = "/portal/cursos/c0000000-0000-4000-8000-000000000001";
const claims = { userId: "u" } as never;

describe("changeOutcome", () => {
  it.each<[DraftChange<DraftAnswer>, ReturnType<typeof changeOutcome>]>([
    [{ kind: "created", id: "x" }, { kind: "done", answer: "created", id: "x" }],
    [{ kind: "saved" }, { kind: "done", answer: "saved", id: null }],
    [{ kind: "moved" }, { kind: "done", answer: "moved", id: null }],
    [{ kind: "deleted" }, { kind: "done", answer: "deleted", id: null }],
    [{ kind: "changed" }, { kind: "failed", reason: "changed" }],
    [{ kind: "not_found" }, { kind: "failed", reason: "gone" }],
    // El dominio ya pasó: lo que la base rechaza es un formulario alterado o una posición fuera de rango.
    [{ kind: "invalid" }, { kind: "failed", reason: "unavailable" }],
    [{ kind: "practice_inactive" }, { kind: "failed", reason: "practice_inactive" }],
    [{ kind: "level_inactive" }, { kind: "failed", reason: "level_inactive" }],
    // Quien ya no puede editar: decide la página, con su guarda y su estado.
    [{ kind: "suspended" }, { kind: "leave", to: BACK, notice: null, closeSession: false }],
    [{ kind: "not_teacher" }, { kind: "leave", to: BACK, notice: null, closeSession: false }],
    [{ kind: "not_editable" }, { kind: "leave", to: BACK, notice: null, closeSession: false }],
    [{ kind: "unknown" }, { kind: "failed", reason: "unavailable" }],
    [{ kind: "session", check: { kind: "anonymous" } }, { kind: "leave", to: `/entrar?volver=${encodeURIComponent(BACK)}`, notice: null, closeSession: false }],
    [
      { kind: "session", check: { kind: "incomplete", claims, variant: "complete_account", missing: { name: true, adultDeclaration: false, documents: [] } } },
      { kind: "leave", to: `/consentimientos?volver=${encodeURIComponent(BACK)}`, notice: null, closeSession: false },
    ],
    [{ kind: "session", check: { kind: "suspended" } }, { kind: "leave", to: BACK, notice: null, closeSession: false }],
    [{ kind: "session", check: { kind: "unavailable" } }, { kind: "failed", reason: "unavailable" }],
    [{ kind: "session", check: { kind: "must_sign_out", then: "sign_in" } }, { kind: "leave", to: "/entrar", notice: null, closeSession: true }],
    [{ kind: "session", check: { kind: "must_sign_out", then: "recover" } }, { kind: "leave", to: "/recuperar", notice: "choose_password", closeSession: true }],
  ])("%j", (result, expected) => {
    expect(changeOutcome(result, BACK)).toEqual(expected);
  });

  it("«no se supo» nunca es hecho", () => {
    expect(changeOutcome({ kind: "unknown" }, BACK).kind).not.toBe("done");
    expect(changeOutcome({ kind: "session", check: { kind: "unavailable" } }, BACK).kind).not.toBe("done");
  });
});
