import { describe, expect, it } from "vitest";

import { checkDraftText, createOutcome, deleteButton, deleteOutcome, readDeleteForm, readNewCourseForm } from "./outcomes";

// Crear y borrar un curso (T-402): lo que llega del formulario y qué se hace con cada respuesta.

const COURSE = "c0000000-0000-4000-8000-000000000001";
const TOKEN = "b0000000-0000-4000-8000-000000000001";
const form = (entries: [string, string][]) => {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
};

describe("crear un curso", () => {
  it("lee el título y el testigo; un testigo sin forma no vale", () => {
    expect(readNewCourseForm(form([["title", "Respirar"], ["token", TOKEN]]))).toEqual({ title: "Respirar", token: TOKEN });
    expect(readNewCourseForm(form([["title", "Respirar"], ["token", "otro"]]))).toEqual({ title: "Respirar", token: null });
    expect(readNewCourseForm(form([["title", "Respirar"], ["token", TOKEN], ["token", TOKEN]]))).toEqual({ title: "Respirar", token: null });
    expect(readNewCourseForm("no es un formulario")).toEqual({ title: "", token: null });
  });

  it("un título desmedido llega cortado, y la regla lo da por largo", () => {
    const { title } = readNewCourseForm(form([["title", "a".repeat(5000)], ["token", TOKEN]]));
    expect(title.length).toBeLessThan(5000);
    expect(checkDraftText("courseTitle", title)).toBe("too_long");
  });

  it.each([
    ["", "required"],
    ["   ", "required"],
    ["a".repeat(61), "too_long"],
    ["Uno\u202edos", "invalid"],
    ["Respirar", null],
  ] as const)("el título %j: %s", (title, problem) => {
    expect(checkDraftText("courseTitle", title)).toBe(problem);
  });

  it("creado, se va al editor del curso; el mismo testigo devuelve el mismo curso", () => {
    expect(createOutcome({ kind: "created", id: COURSE })).toEqual({ kind: "leave", to: `/portal/cursos/${COURSE}`, notice: null, closeSession: false });
  });

  it("lo que no se hizo se queda en la pantalla, con lo escrito", () => {
    expect(createOutcome({ kind: "unknown" })).toEqual({ kind: "failed", reason: "unavailable" });
    expect(createOutcome({ kind: "invalid" })).toEqual({ kind: "failed", reason: "unavailable" });
    // Un id que no tiene forma no se pega a una dirección.
    expect(createOutcome({ kind: "created", id: "x" })).toEqual({ kind: "failed", reason: "unavailable" });
  });

  it("el suspendido y quien no es maestro vuelven a la pantalla, donde decide la guarda", () => {
    expect(createOutcome({ kind: "suspended" })).toEqual({ kind: "leave", to: "/portal/cursos/nuevo", notice: null, closeSession: false });
    expect(createOutcome({ kind: "not_teacher" })).toEqual({ kind: "leave", to: "/portal/cursos/nuevo", notice: null, closeSession: false });
  });
});

describe("borrar un curso", () => {
  it("el botón lleva el curso y la revisión que se vio, y se lee igual", () => {
    expect(readDeleteForm(form([["do", deleteButton(COURSE, 7)]]))).toEqual({ course: COURSE, seen: 7 });
  });

  it.each([
    ["sin botón", []],
    ["dos botones", [["do", deleteButton(COURSE, 7)], ["do", deleteButton(COURSE, 7)]]],
    ["otro verbo", [["do", `save:${COURSE}:7`]]],
    ["un id sin forma", [["do", "delete:x:7"]]],
    ["una revisión cero", [["do", `delete:${COURSE}:0`]]],
    ["de más", [["do", `delete:${COURSE}:7:8`]]],
  ] as [string, [string, string][]][])("%s no es nada", (_name, entries) => {
    expect(readDeleteForm(form(entries))).toBeNull();
  });

  it("borrado, a la lista con el aviso; si ya no existía, a la lista con el suyo", () => {
    expect(deleteOutcome({ kind: "deleted" }, COURSE)).toEqual({ kind: "leave", to: "/portal/cursos", notice: "course_deleted", closeSession: false });
    expect(deleteOutcome({ kind: "not_found" }, COURSE)).toEqual({ kind: "leave", to: "/portal/cursos", notice: "course_gone", closeSession: false });
  });

  it("si cambió mientras se veía, se queda y lo dice; «no se supo» no es borrado", () => {
    expect(deleteOutcome({ kind: "changed" }, COURSE)).toEqual({ kind: "failed", reason: "changed" });
    expect(deleteOutcome({ kind: "unknown" }, COURSE)).toEqual({ kind: "failed", reason: "unavailable" });
    expect(deleteOutcome({ kind: "not_editable" }, COURSE)).toEqual({ kind: "leave", to: `/portal/cursos/${COURSE}/borrar`, notice: null, closeSession: false });
  });
});
