import { describe, expect, it } from "vitest";

import { noticeDestination, noticeOutcome, readNoticeForm } from "./outcomes";

const NOTICE = "c0000000-0000-4000-8000-000000000002";

function formOf(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

describe("el formulario del aviso", () => {
  it("lee el texto que se mostró, la casilla y a dónde sigue", () => {
    expect(readNoticeForm(formOf({ notice: NOTICE, agreed: "on", volver: "/portal/cursos" }))).toEqual({ notice: NOTICE, agreed: true, returnTo: "/portal/cursos" });
  });

  it("un texto sin forma no se lee", () => {
    expect(readNoticeForm(formOf({ notice: "otra-cosa" })).notice).toBeNull();
  });
});

describe("a dónde sigue después de aceptar", () => {
  it.each([
    ["/portal/cursos", "/portal/cursos"],
    ["/portal", "/portal"],
    // Solo dentro del portal: lo demás, y lo que no vale, al inicio del portal.
    ["/inicio", "/portal"],
    ["/admin", "/portal"],
    ["https://otro.example/portal", "/portal"],
    ["", "/portal"],
  ])("%s", (returnTo, expected) => {
    expect(noticeDestination(returnTo)).toBe(expected);
  });
});

describe("lo que hace con cada respuesta", () => {
  it("anotado: a donde iba, con su aviso", () => {
    expect(noticeOutcome({ kind: "accepted" }, "/portal/cursos")).toEqual({ kind: "leave", to: "/portal/cursos", notice: "teacher_notice_accepted" });
  });

  it("el texto cambió: se vuelve a mostrar", () => {
    expect(noticeOutcome({ kind: "changed" }, "")).toEqual({ kind: "repaint", reason: "changed" });
  });

  it("no se supo: nunca como hecho", () => {
    expect(noticeOutcome({ kind: "unknown" }, "")).toEqual({ kind: "repaint", reason: "unknown" });
  });

  it("a quien no le toca: al portal, donde decide la guarda", () => {
    expect(noticeOutcome({ kind: "not_needed" }, "/portal/cursos")).toEqual({ kind: "leave", to: "/portal", notice: null });
  });

  it("una sesión que ya no vale se cierra", () => {
    expect(noticeOutcome({ kind: "refused", check: { kind: "must_sign_out", then: "sign_in" } }, "")).toEqual({
      kind: "leave",
      to: "/entrar",
      notice: null,
      closeSession: true,
    });
  });
});
