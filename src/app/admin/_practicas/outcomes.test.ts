import { describe, expect, it } from "vitest";

import { ADD_ANSWERS, MOVE_ANSWERS, RENAME_ANSWERS, SET_ACTIVE_ANSWERS } from "@/services/catalog/lists";

import {
  activeOutcome,
  addOutcome,
  catalogButton,
  catalogCodeOutcome,
  checkName,
  moveOutcome,
  readCatalogForm,
  renameOutcome,
} from "./outcomes";

// La tabla de la pantalla de las prácticas y los niveles (PA-67): qué se entiende de cada
// envío, y qué se hace con cada respuesta del servicio. Cada respuesta de la base tiene su
// caso: las pruebas recorren las listas cerradas del servicio.

const ITEM = "b0000000-0000-4000-8000-000000000002";
const OTHER = "c0000000-0000-4000-8000-000000000003";
const TO_PAGE = { kind: "leave", to: "/admin/practicas", notice: null };

function form(entries: [string, string | Blob][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}
const pressed = (value: string, name?: string) => form(name === undefined ? [["do", value]] : [["do", value], ["name", name]]);

describe("qué botón se pulsó", () => {
  it("cada botón que arma la tabla se lee como lo que dice", () => {
    expect(readCatalogForm(pressed(catalogButton.add(), "Yoga"))).toEqual({ step: "add", name: "Yoga" });
    expect(readCatalogForm(pressed(catalogButton.cancel()))).toEqual({ step: "cancel" });
    expect(readCatalogForm(pressed(catalogButton.up(ITEM, 3)))).toEqual({ step: "move", id: ITEM, direction: "up", position: 3 });
    expect(readCatalogForm(pressed(catalogButton.down(ITEM, 12)))).toEqual({ step: "move", id: ITEM, direction: "down", position: 12 });
    expect(readCatalogForm(pressed(catalogButton.rename(ITEM)))).toEqual({ step: "rename", id: ITEM });
    expect(readCatalogForm(pressed(catalogButton.save(ITEM), "Yoga suave"))).toEqual({ step: "save", id: ITEM, name: "Yoga suave" });
    expect(readCatalogForm(pressed(catalogButton.deactivate(ITEM)))).toEqual({ step: "active", id: ITEM, active: false });
    expect(readCatalogForm(pressed(catalogButton.reactivate(ITEM)))).toEqual({ step: "active", id: ITEM, active: true });
  });

  it.each<[string, unknown]>([
    ["algo que no es un formulario", { do: "add" }],
    ["un formulario sin botón", form([["name", "Yoga"]])],
    ["dos botones", form([["do", "add"], ["do", `deactivate:${ITEM}`]])],
    ["un botón vacío", pressed("")],
    ["un botón desmedido", pressed(`rename:${ITEM}${"x".repeat(200)}`)],
    ["un archivo en lugar de un valor", form([["do", new Blob(["add"])]])],
    ["un verbo que no existe", pressed(`delete:${ITEM}`)],
    ["un id sin forma", pressed("rename:uno")],
    ["un id en mayúsculas", pressed(`rename:${ITEM.toUpperCase()}`)],
    ["subir sin la posición que se vio", pressed(`up:${ITEM}`)],
    ["subir desde la posición cero", pressed(`up:${ITEM}:0`)],
    ["subir con una posición con decimales", pressed(`up:${ITEM}:1.5`)],
    ["subir con una posición negativa", pressed(`up:${ITEM}:-1`)],
    ["renombrar con una posición de más", pressed(`rename:${ITEM}:3`)],
    ["desactivar con una posición de más", pressed(`deactivate:${ITEM}:3`)],
    ["un valor con partes de más", pressed(`up:${ITEM}:3:4`)],
    ["agregar con un id", pressed(`add:${ITEM}`)],
    ["cancelar con un id", pressed(`cancel:${ITEM}`)],
  ])("%s cuenta como vacío", (_what, sent) => {
    expect(readCatalogForm(sent)).toEqual({ step: "none" });
  });

  it("el nombre que no es texto llega vacío, y el desmedido llega cortado", () => {
    expect(readCatalogForm(form([["do", "add"], ["name", new Blob(["Yoga"])]]))).toEqual({ step: "add", name: "" });
    expect(readCatalogForm(form([["do", "add"]]))).toEqual({ step: "add", name: "" });
    const long = readCatalogForm(pressed("add", "a".repeat(5000)));
    expect(long.step === "add" && long.name.length).toBe(401);
  });
});

describe("el nombre se revisa antes de llamar a nadie", () => {
  it.each<[string, string, string | null]>([
    ["un nombre corriente", "Yoga", null],
    ["vacío", "", "required"],
    ["solo espacios", "   ", "required"],
    ["de 41 caracteres", "a".repeat(41), "too_long"],
    ["desmedido, ya cortado", "a".repeat(401), "too_long"],
    ["con un carácter de ancho cero", "Yo\u200bga", "invalid"],
    ["solo signos", "¡¡!!", "invalid"],
  ])("%s", (_what, name, problem) => {
    expect(checkName(name)).toBe(problem);
  });
});

describe("dar el código otra vez vuelve a esta página, no a la del equipo", () => {
  it.each(["verified", "refused"] as const)("%s", (kind) => {
    expect(catalogCodeOutcome({ kind })).toEqual(TO_PAGE);
  });
});

describe("a quien la guarda no dejó, o a quien la base le dijo que no tiene Contenido, a su página", () => {
  it.each([
    ["agregar", addOutcome({ kind: "refused" }, "Yoga")],
    ["renombrar", renameOutcome({ kind: "refused" }, ITEM, "Yoga")],
    ["mover", moveOutcome({ kind: "refused" }, ITEM, "up")],
    ["activar", activeOutcome({ kind: "refused" }, ITEM)],
    ["agregar, forbidden", addOutcome({ kind: "answered", answer: "forbidden", id: null }, "Yoga")],
    ["renombrar, forbidden", renameOutcome({ kind: "answered", answer: "forbidden" }, ITEM, "Yoga")],
    ["mover, forbidden", moveOutcome({ kind: "answered", answer: "forbidden" }, ITEM, "up")],
    ["activar, forbidden", activeOutcome({ kind: "answered", answer: "forbidden" }, ITEM)],
  ])("%s", (_what, outcome) => {
    expect(outcome).toEqual(TO_PAGE);
  });
});

describe("«no se supo» nunca se pinta como hecho", () => {
  it.each([
    ["agregar", addOutcome({ kind: "unavailable" }, "Yoga"), { kind: "failed", reason: "unavailable", name: "Yoga" }],
    ["agregar", addOutcome({ kind: "unknown" }, "Yoga"), { kind: "failed", reason: "unknown", name: "Yoga" }],
    ["renombrar", renameOutcome({ kind: "unknown" }, ITEM, "Yoga"), { kind: "failed", reason: "unknown", name: null }],
    ["mover", moveOutcome({ kind: "unavailable" }, ITEM, "up"), { kind: "failed", reason: "unavailable", name: null }],
    ["activar", activeOutcome({ kind: "unknown" }, ITEM), { kind: "failed", reason: "unknown", name: null }],
  ])("%s", (_what, outcome, expected) => {
    expect(outcome).toEqual(expected);
  });
});

describe("cada respuesta de agregar tiene su caso", () => {
  it.each(ADD_ANSWERS)("%s", (answer) => {
    expect(addOutcome({ kind: "answered", answer, id: ITEM }, "Yoga")).toBeDefined();
  });

  it("agregada: se dice con el nombre como quedó guardado", () => {
    expect(addOutcome({ kind: "answered", answer: "added", id: ITEM }, "  Ba\u0301sico ")).toEqual({
      kind: "done",
      what: "added",
      id: ITEM,
      name: "Básico",
      direction: null,
    });
  });

  it("duplicada: en su campo, con lo escrito", () => {
    expect(addOutcome({ kind: "answered", answer: "duplicate", id: OTHER }, "yoga")).toEqual({ kind: "add_invalid", name: "yoga", problem: "duplicate" });
  });

  it("de una desactivada: se ofrece reactivarla, con su id", () => {
    expect(addOutcome({ kind: "answered", answer: "inactive_duplicate", id: OTHER }, "yoga")).toEqual({
      kind: "inactive_duplicate",
      id: OTHER,
      name: "yoga",
    });
    // Sin el id no hay qué reactivar: no se supo.
    expect(addOutcome({ kind: "answered", answer: "inactive_duplicate", id: null }, "yoga")).toEqual({ kind: "failed", reason: "unknown", name: "yoga" });
  });

  it("la base dice que no tiene forma: en su campo", () => {
    expect(addOutcome({ kind: "answered", answer: "invalid", id: null }, "x")).toEqual({ kind: "add_invalid", name: "x", problem: "invalid" });
    expect(addOutcome({ kind: "malformed" }, "x")).toEqual({ kind: "add_invalid", name: "x", problem: "invalid" });
  });

  it("el código ya no es reciente: se pide, y lo escrito no se pierde", () => {
    expect(addOutcome({ kind: "answered", answer: "needs_fresh_code", id: null }, "Yoga")).toEqual({ kind: "failed", reason: "needs_code", name: "Yoga" });
  });
});

describe("cada respuesta de renombrar tiene su caso", () => {
  it.each(RENAME_ANSWERS)("%s", (answer) => {
    expect(renameOutcome({ kind: "answered", answer }, ITEM, "Yoga")).toBeDefined();
  });

  it.each([
    ["renamed", { kind: "done", what: "renamed", id: ITEM, name: null, direction: null }],
    ["unchanged", { kind: "unchanged" }],
    ["duplicate", { kind: "renaming", id: ITEM, name: "Yoga", problem: "duplicate" }],
    ["invalid", { kind: "renaming", id: ITEM, name: "Yoga", problem: "invalid" }],
    ["not_found", { kind: "failed", reason: "list_changed", name: null }],
    ["needs_fresh_code", { kind: "failed", reason: "needs_code", name: null }],
  ] as const)("%s", (answer, expected) => {
    expect(renameOutcome({ kind: "answered", answer }, ITEM, "Yoga")).toEqual(expected);
  });
});

describe("cada respuesta de mover tiene su caso", () => {
  it.each(MOVE_ANSWERS)("%s", (answer) => {
    expect(moveOutcome({ kind: "answered", answer }, ITEM, "up")).toBeDefined();
  });

  it.each([
    ["moved", { kind: "done", what: "moved", id: ITEM, name: null, direction: "down" }],
    ["edge", { kind: "failed", reason: "list_changed", name: null }],
    ["not_found", { kind: "failed", reason: "list_changed", name: null }],
    ["needs_fresh_code", { kind: "failed", reason: "needs_code", name: null }],
  ] as const)("%s", (answer, expected) => {
    expect(moveOutcome({ kind: "answered", answer }, ITEM, "down")).toEqual(expected);
  });

  it("ya no estaba donde se vio: la lista cambió, y no se movió nada", () => {
    expect(moveOutcome({ kind: "changed" }, ITEM, "up")).toEqual({ kind: "failed", reason: "list_changed", name: null });
  });
});

describe("cada respuesta de desactivar y reactivar tiene su caso", () => {
  it.each(SET_ACTIVE_ANSWERS)("%s", (answer) => {
    expect(activeOutcome({ kind: "answered", answer }, ITEM)).toBeDefined();
  });

  it.each([
    ["deactivated", { kind: "done", what: "deactivated", id: ITEM, name: null, direction: null }],
    ["reactivated", { kind: "done", what: "reactivated", id: ITEM, name: null, direction: null }],
    ["unchanged", { kind: "unchanged" }],
    ["in_use", { kind: "failed", reason: "in_use", name: null }],
    ["not_found", { kind: "failed", reason: "list_changed", name: null }],
    ["needs_fresh_code", { kind: "failed", reason: "needs_code", name: null }],
  ] as const)("%s", (answer, expected) => {
    expect(activeOutcome({ kind: "answered", answer }, ITEM)).toEqual(expected);
  });
});
