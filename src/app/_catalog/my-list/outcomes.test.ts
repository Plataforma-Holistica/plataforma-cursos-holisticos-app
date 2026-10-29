import { describe, expect, it } from "vitest";

import type { ListChange } from "@/services/browse/browse";

import { listOutcome, readListForm, type ListScreen } from "./outcomes";

// La tabla de Mi lista: qué pide el formulario y qué hace cada pantalla con cada respuesta.

const form = (...values: string[]) => {
  const data = new FormData();
  for (const value of values) data.append("do", value);
  return data;
};

describe("lo que pide el formulario", () => {
  it.each([
    ["save:respirar", { kind: "save", slug: "respirar" }],
    ["remove:respirar-hondo", { kind: "remove", slug: "respirar-hondo" }],
  ])("%s", (value, request) => {
    expect(readListForm(form(value))).toEqual(request);
  });

  it.each([
    ["sin botón", form()],
    ["dos botones", form("save:uno", "remove:dos")],
    ["otra intención", form("toggle:respirar")],
    ["un slug sin forma", form("save:Respirar")],
    ["un slug con ruta", form("save:../respirar")],
    ["sin slug", form("save:")],
    ["desmedido", form(`save:${"a".repeat(101)}`)],
    ["no es un formulario", "save:respirar"],
  ])("%s cuenta como vacío", (_, data) => {
    expect(readListForm(data)).toEqual({ kind: "none" });
  });

  it("un archivo en lugar de texto cuenta como vacío", () => {
    const data = new FormData();
    data.append("do", new Blob(["save:respirar"]));
    expect(readListForm(data)).toEqual({ kind: "none" });
  });
});

describe("qué hace cada pantalla con cada respuesta", () => {
  const screens: [ListScreen, string][] = [
    ["course", "/cursos/respirar"],
    ["home", "/inicio"],
    ["explore", "/explorar"],
  ];

  it.each(screens)("%s: guardado, quitado, ya no está y no se supo se dicen en la pantalla", (screen) => {
    const cases: [ListChange, string][] = [
      [{ kind: "saved" }, "saved"],
      [{ kind: "removed" }, "removed"],
      [{ kind: "not_found" }, "gone"],
      [{ kind: "unavailable" }, "unavailable"],
      [{ kind: "session", check: { kind: "unavailable" } }, "unavailable"],
    ];
    for (const [result, kind] of cases) expect(listOutcome(screen, "respirar", result)).toEqual({ kind });
  });

  it.each(screens)("%s: sin sesión, a entrar y de vuelta a la misma pantalla", (screen, back) => {
    expect(listOutcome(screen, "respirar", { kind: "session", check: { kind: "anonymous" } })).toEqual({
      kind: "redirect",
      to: `/entrar?volver=${encodeURIComponent(back)}`,
      notice: null,
      closeSession: false,
    });
  });

  it.each(screens)("%s: a una cuenta a medias se lo pide su pantalla, y vuelve", (screen, back) => {
    const outcome = listOutcome(screen, "respirar", {
      kind: "session",
      check: { kind: "incomplete", claims: {} as never, variant: "complete_account", missing: { name: true, adultDeclaration: false, documents: [] } },
    });
    expect(outcome).toMatchObject({ kind: "redirect", notice: null, closeSession: false });
    expect(outcome.kind === "redirect" && outcome.to.endsWith(`volver=${encodeURIComponent(back)}`)).toBe(true);
  });

  it.each(screens)("%s: suspendida, a la misma pantalla, donde decide la guarda", (screen, back) => {
    expect(listOutcome(screen, "respirar", { kind: "session", check: { kind: "suspended" } })).toEqual({
      kind: "redirect",
      to: back,
      notice: null,
      closeSession: false,
    });
  });

  it.each(screens)("%s: una sesión que ya no vale se cierra antes de irse", (screen) => {
    expect(listOutcome(screen, "respirar", { kind: "session", check: { kind: "must_sign_out", then: "sign_in" } })).toEqual({
      kind: "redirect",
      to: "/entrar",
      notice: null,
      closeSession: true,
    });
    expect(listOutcome(screen, "respirar", { kind: "session", check: { kind: "must_sign_out", then: "recover" } })).toEqual({
      kind: "redirect",
      to: "/recuperar",
      notice: "choose_password",
      closeSession: true,
    });
  });
});
