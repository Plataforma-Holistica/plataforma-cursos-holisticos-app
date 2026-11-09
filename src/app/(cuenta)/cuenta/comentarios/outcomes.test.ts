import { describe, expect, it } from "vitest";

import { signInPath } from "@/services/account/navigation";

import { IDLE_MINE, myDeleteOutcome, readMyCommentsForm } from "./outcomes";

// «Mis comentarios» (PA-24; T-501): qué pide cada botón y qué pinta la pantalla después de borrar. Es puro.

const ID = "c0000000-0000-4000-8000-000000000001";
const AT = "2026-11-03T18:00:00.123456+00:00";
const BACK = "/cuenta/comentarios";

function form(...values: [string, string][]): FormData {
  const data = new FormData();
  for (const [field, value] of values) data.append(field, value);
  return data;
}

describe("readMyCommentsForm: qué botón se pulsó, y desde qué página", () => {
  it("preguntar, borrar con la revisión que se vio, y cancelar", () => {
    expect(readMyCommentsForm(form(["do", `ask-delete:${ID}`]))).toEqual({ kind: "ask", id: ID, back: BACK });
    expect(readMyCommentsForm(form(["do", `delete:${ID}:3`]))).toEqual({ kind: "delete", id: ID, revision: 3, back: BACK });
    expect(readMyCommentsForm(form(["do", "cancel"]))).toEqual({ kind: "cancel", back: BACK });
  });

  it("la página en que se estaba, si tiene forma, es a donde se vuelve", () => {
    expect(readMyCommentsForm(form(["do", "cancel"], ["desde", `${AT}_${ID}`]))).toEqual({ kind: "cancel", back: `${BACK}?desde=${encodeURIComponent(`${AT}_${ID}`)}` });
    expect(readMyCommentsForm(form(["do", "cancel"], ["desde", "basura"]))).toEqual({ kind: "cancel", back: BACK });
  });

  it("lo que no tiene forma cuenta como vacío", () => {
    for (const value of ["", "borrar", `delete:${ID}`, `delete:${ID}:0`, `delete:${ID}:1.5`, `ask-delete:${ID.toUpperCase()}`, `save:${ID}:1`]) {
      expect(readMyCommentsForm(form(["do", value]))).toEqual({ kind: "none" });
    }
    expect(readMyCommentsForm(form(["do", "cancel"], ["do", "cancel"]))).toEqual({ kind: "none" });
    expect(readMyCommentsForm(null)).toEqual({ kind: "none" });
  });
});

describe("myDeleteOutcome: lo que pinta la lista después de borrar", () => {
  it("borrado, ya no estaba, o cambiado: se dice, y la lista se vuelve a leer", () => {
    expect(myDeleteOutcome(ID, { kind: "deleted" }, BACK)).toEqual({ kind: "state", refresh: true, state: { asking: null, notice: { kind: "deleted", id: null } } });
    expect(myDeleteOutcome(ID, { kind: "not_found" }, BACK)).toEqual({ kind: "state", refresh: true, state: { asking: null, notice: { kind: "gone", id: null } } });
    expect(myDeleteOutcome(ID, { kind: "changed" }, BACK)).toEqual({ kind: "state", refresh: true, state: { asking: null, notice: { kind: "changed", id: ID } } });
    // Lo oculto por reportes ya no sale en la lista: el aviso va arriba (T-502).
    expect(myDeleteOutcome(ID, { kind: "hidden" }, BACK)).toEqual({ kind: "state", refresh: true, state: { asking: null, notice: { kind: "hidden", id: null } } });
  });

  it("si no se supo, la pregunta se queda para reintentar", () => {
    expect(myDeleteOutcome(ID, { kind: "unavailable" }, BACK)).toEqual({ kind: "state", refresh: false, state: { asking: ID, notice: { kind: "unavailable", id: ID } } });
  });

  it("la sesión que no pasa sale de la pantalla y vuelve a ella", () => {
    expect(myDeleteOutcome(ID, { kind: "session", check: { kind: "anonymous" } }, BACK)).toEqual({ kind: "redirect", to: signInPath(BACK), notice: null, closeSession: false });
    expect(myDeleteOutcome(ID, { kind: "session", check: { kind: "suspended" } } as never, BACK)).toMatchObject({ kind: "redirect", to: BACK });
  });

  it("el estado de reposo", () => {
    expect(IDLE_MINE).toEqual({ attempt: 0, asking: null, notice: null });
  });
});
