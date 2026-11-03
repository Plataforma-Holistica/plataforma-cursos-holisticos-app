import { describe, expect, it } from "vitest";

import { ROUTES } from "@/services/account/navigation";
import { SUBMIT_ANSWERS } from "@/services/drafts/editor";

import { ACCEPT_FIELD, ACCEPT_VALUE, readSubmitForm, removePendingButton, submitButton, submitOutcome } from "./outcomes";

// PA-44: qué llega del formulario y qué se hace con cada respuesta (T-405).

const COURSE = "c0000000-0000-4000-8000-000000000002";
const ANNEX = "a1000000-0000-4000-8000-000000000003";
const RESOURCE = "e0000000-0000-4000-8000-000000000004";
const HASH = "b".repeat(64);
const BACK = `/portal/cursos/${COURSE}/enviar`;
const SEEN = { course: COURSE, annex: ANNEX, seen: HASH, term: 10, submission: 2 };

const form = (entries: [string, string][]) => {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
};

describe("readSubmitForm", () => {
  it("el botón lleva lo que se vio, y la casilla viaja aparte", () => {
    expect(readSubmitForm(form([["do", submitButton(SEEN)], [ACCEPT_FIELD, ACCEPT_VALUE]]))).toEqual({ step: "submit", ...SEEN, accepted: true });
    expect(readSubmitForm(form([["do", submitButton(SEEN)]]))).toEqual({ step: "submit", ...SEEN, accepted: false });
  });

  it("una casilla con otro valor, o repetida, no cuenta como aceptada", () => {
    expect(readSubmitForm(form([["do", submitButton(SEEN)], [ACCEPT_FIELD, "si"]]))).toMatchObject({ accepted: false });
    expect(readSubmitForm(form([["do", submitButton(SEEN)], [ACCEPT_FIELD, ACCEPT_VALUE], [ACCEPT_FIELD, ACCEPT_VALUE]]))).toMatchObject({ accepted: false });
  });

  it("quitar un recurso pendiente lleva su revisión", () => {
    expect(readSubmitForm(form([["do", removePendingButton(COURSE, RESOURCE, 3)]]))).toEqual({ step: "remove", course: COURSE, resource: RESOURCE, seen: 3 });
  });

  it.each([
    ["sin do", []],
    ["con dos", [["do", submitButton(SEEN)], ["do", submitButton(SEEN)]]],
    ["una huella sin forma", [["do", `submit:${COURSE}:${ANNEX}:ab:10:2`]]],
    ["un plazo de cero", [["do", `submit:${COURSE}:${ANNEX}:${HASH}:0:2`]]],
    ["de más", [["do", `${submitButton(SEEN)}:otro`]]],
    ["otro verbo", [["do", `publish:${COURSE}`]]],
    ["una revisión sin forma", [["do", `remove:${COURSE}:${RESOURCE}:x`]]],
  ] as [string, [string, string][]][])("%s: vacío", (_what, entries) => {
    expect(readSubmitForm(form(entries))).toEqual({ step: "none" });
  });

  it("lo que no es un formulario: vacío", () => {
    expect(readSubmitForm(null)).toEqual({ step: "none" });
  });
});

describe("submitOutcome", () => {
  const leave = (to: string, notice: string | null = null) => ({ kind: "leave", to, notice, closeSession: false });
  const cases: Record<(typeof SUBMIT_ANSWERS)[number], unknown> = {
    submitted: leave(ROUTES.portalCourses, "course_submitted"),
    not_editable: leave(ROUTES.portalCourses),
    not_found: leave(ROUTES.portalCourses, "course_gone"),
    suspended: leave(BACK),
    not_teacher: leave(BACK),
    changed: { kind: "failed", reason: "changed" },
    not_ready: { kind: "failed", reason: "not_ready" },
    annex_missing: { kind: "failed", reason: "annex_missing" },
    origin_missing: { kind: "failed", reason: "origin_missing" },
    unavailable: { kind: "failed", reason: "unavailable" },
    invalid: { kind: "failed", reason: "changed" },
  };

  it.each(SUBMIT_ANSWERS)("la base contesta %s", (answer) => {
    expect(submitOutcome({ kind: answer }, BACK)).toEqual(cases[answer]);
  });

  it("lo que el servicio decide sin la base", () => {
    expect(submitOutcome({ kind: "not_accepted" }, BACK)).toEqual({ kind: "failed", reason: "not_accepted" });
    expect(submitOutcome({ kind: "video_not_ready" }, BACK)).toEqual({ kind: "failed", reason: "video_not_ready" });
    expect(submitOutcome({ kind: "malformed" }, BACK)).toEqual({ kind: "failed", reason: "changed" });
  });

  it("no se supo nunca se pinta como hecho", () => {
    expect(submitOutcome({ kind: "unknown" }, BACK)).toEqual({ kind: "failed", reason: "unknown" });
  });

  it("sin sesión, a entrar y de vuelta aquí", () => {
    expect(submitOutcome({ kind: "session", check: { kind: "anonymous" } } as never, BACK)).toMatchObject({ kind: "leave", to: expect.stringContaining(encodeURIComponent(BACK)) });
  });
});
