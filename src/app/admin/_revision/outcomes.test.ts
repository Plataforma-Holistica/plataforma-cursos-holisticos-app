import { describe, expect, it } from "vitest";

import { ROUTES } from "@/services/account/navigation";
import { APPROVE_ANSWERS, RETURN_ANSWERS } from "@/services/review/review";

import { approveOutcome, readReviewForm, reviewButton, reviewCodeOutcome, videoAnswerOf, readReturnForm, returnButton, returnOutcome, returnProblems, reviewVideoAnswerOf } from "./outcomes";

// La tabla de la pantalla de revisión: lo que llega, lo que contesta cada servicio y a dónde
// va. Pura: sin servicios ni base.

const COURSE = "c0000000-0000-4000-8000-000000000002";
const TO_PAGE = { kind: "leave", to: ROUTES.review, notice: null };

function formWith(...values: [string, string][]) {
  const form = new FormData();
  for (const [name, value] of values) form.append(name, value);
  return form;
}

describe("readReviewForm", () => {
  it("lee los valores que arma reviewButton", () => {
    expect(readReviewForm(formWith(["do", reviewButton.ask(COURSE)]))).toEqual({ step: "ask", course: COURSE });
    expect(readReviewForm(formWith(["do", reviewButton.confirm(COURSE)]))).toEqual({ step: "confirm", course: COURSE });
    expect(readReviewForm(formWith(["do", reviewButton.cancel()]))).toEqual({ step: "cancel" });
  });

  it.each([
    ["no es un formulario", "texto"],
    ["sin do", formWith()],
    ["dos do", formWith(["do", reviewButton.ask(COURSE)], ["do", reviewButton.confirm(COURSE)])],
    ["un do vacío", formWith(["do", ""])],
    ["un do desmedido", formWith(["do", `confirm:${COURSE}${"x".repeat(200)}`])],
    ["un verbo que no existe", formWith(["do", `publish:${COURSE}`])],
    ["un curso sin forma", formWith(["do", "confirm:no-es-un-id"])],
    ["un curso en mayúsculas", formWith(["do", `confirm:${COURSE.toUpperCase()}`])],
    ["partes de más", formWith(["do", `confirm:${COURSE}:otra`])],
    ["confirmar sin curso", formWith(["do", "confirm"])],
    ["cancelar con curso", formWith(["do", `cancel:${COURSE}`])],
  ])("%s: none", (_what, form) => {
    expect(readReviewForm(form)).toEqual({ step: "none" });
  });
});

describe("approveOutcome", () => {
  const cases: Record<(typeof APPROVE_ANSWERS)[number], ReturnType<typeof approveOutcome>> = {
    approved: { kind: "leave", to: ROUTES.review, notice: "course_approved" },
    forbidden: TO_PAGE as never,
    needs_fresh_code: { kind: "failed", reason: "needs_code" },
    not_found: { kind: "failed", reason: "not_pending" },
    not_pending: { kind: "failed", reason: "not_pending" },
    self: { kind: "failed", reason: "self" },
    incomplete: { kind: "failed", reason: "incomplete" },
    practice_inactive: { kind: "failed", reason: "practice_inactive" },
    level_inactive: { kind: "failed", reason: "level_inactive" },
    videos_not_ready: { kind: "failed", reason: "videos_not_ready" },
  };

  it.each(APPROVE_ANSWERS)("la base contesta %s", (answer) => {
    expect(approveOutcome({ kind: "answered", answer })).toEqual(cases[answer]);
  });

  it("refused: a esta misma página, donde decide la guarda", () => {
    expect(approveOutcome({ kind: "refused" })).toEqual(TO_PAGE);
  });

  it("no se supo nunca se pinta como hecho", () => {
    expect(approveOutcome({ kind: "unavailable" })).toEqual({ kind: "failed", reason: "unavailable" });
    expect(approveOutcome({ kind: "unknown" })).toEqual({ kind: "failed", reason: "unknown" });
  });

  it("un curso sin forma: la cola de ahora lo aclara", () => {
    expect(approveOutcome({ kind: "malformed" })).toEqual({ kind: "failed", reason: "not_pending" });
  });
});

describe("reviewCodeOutcome", () => {
  it("dado el código, a esta página; sin él, se dice", () => {
    expect(reviewCodeOutcome({ kind: "verified" })).toEqual(TO_PAGE);
    expect(reviewCodeOutcome({ kind: "refused" })).toEqual(TO_PAGE);
    expect(reviewCodeOutcome({ kind: "wrong_code" })).toEqual({ kind: "failed", reason: "wrong_code" });
  });
});

describe("videoAnswerOf", () => {
  it("traduce los tokens a los nombres de Mux Player; la caducidad no viaja", () => {
    expect(
      videoAnswerOf({
        kind: "granted",
        playbackId: "PlaybackDePrueba",
        tokens: { video: "v.v.v", thumbnail: "t.t.t", storyboard: "s.s.s" },
        expiresAt: 99,
        speeds: [0.75, 1, 1.25, 1.5, 1.75, 2],
      }),
    ).toEqual({
      kind: "granted",
      playbackId: "PlaybackDePrueba",
      tokens: { playback: "v.v.v", thumbnail: "t.t.t", storyboard: "s.s.s" },
      speeds: [0.75, 1, 1.25, 1.5, 1.75, 2],
    });
  });

  it("refused: a esta página; lo demás, tal cual", () => {
    expect(videoAnswerOf({ kind: "refused" })).toEqual(TO_PAGE);
    expect(videoAnswerOf({ kind: "no_video" })).toEqual({ kind: "no_video" });
    expect(videoAnswerOf({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
  });
});

describe("devolver: lo que llega", () => {
  const C = "c0000000-0000-4000-8000-000000000002";
  const S = "f0000000-0000-4000-8000-000000000001";
  const form = (entries: [string, string][]) => {
    const data = new FormData();
    for (const [name, value] of entries) data.append(name, value);
    return data;
  };

  it("los botones se leen como se arman", () => {
    expect(readReturnForm(form([["do", returnButton.ask(C, S)]]))).toEqual({ step: "ask", course: C, submission: S });
    expect(readReturnForm(form([["do", returnButton.cancel()]]))).toEqual({ step: "cancel" });
  });

  it("enviar lee lo escrito", () => {
    expect(readReturnForm(form([["do", returnButton.send(C, S)], ["motivo", "Uno"], ["que_corregir", "Dos"]]))).toEqual({ step: "send", course: C, submission: S, reason: "Uno", whatToFix: "Dos" });
  });

  it("sin los campos, cuentan como vacíos", () => {
    expect(readReturnForm(form([["do", returnButton.send(C, S)]]))).toEqual({ step: "send", course: C, submission: S, reason: "", whatToFix: "" });
  });

  it.each([
    ["sin do", []],
    ["con dos", [["do", returnButton.ask(C, S)], ["do", returnButton.ask(C, S)]]],
    ["un curso sin forma", [["do", `return_ask:x:${S}`]]],
    ["sin envío", [["do", `return_ask:${C}`]]],
    ["de más", [["do", `return_ask:${C}:${S}:otro`]]],
    ["otro verbo", [["do", `confirm:${C}:${S}`]]],
  ] as [string, [string, string][]][])("%s: vacío", (_what, entries) => {
    expect(readReturnForm(form(entries))).toEqual({ step: "none" });
  });

  it("lo que no es un formulario: vacío", () => {
    expect(readReturnForm("hola")).toEqual({ step: "none" });
  });
});

describe("devolver: lo escrito", () => {
  it("los dos son obligatorios", () => {
    expect(returnProblems({ reason: "  ", whatToFix: "\n" })).toEqual({ reason: "empty", whatToFix: "empty" });
    expect(returnProblems({ reason: "Motivo.", whatToFix: "" })).toEqual({ reason: null, whatToFix: "empty" });
    expect(returnProblems({ reason: "", whatToFix: "Corrige." })).toEqual({ reason: "empty", whatToFix: null });
  });

  it("largo y caracteres, con la regla de la base", () => {
    expect(returnProblems({ reason: "a".repeat(2001), whatToFix: "a\u200b" })).toEqual({ reason: "too_long", whatToFix: "invalid" });
  });

  it("con los dos, nada", () => {
    expect(returnProblems({ reason: "Motivo.", whatToFix: "Corrige." })).toEqual({ reason: null, whatToFix: null });
  });
});

describe("returnOutcome", () => {
  const cases: Record<(typeof RETURN_ANSWERS)[number], ReturnType<typeof returnOutcome>> = {
    returned: { kind: "leave", to: ROUTES.review, notice: "course_returned" },
    forbidden: TO_PAGE as never,
    needs_fresh_code: { kind: "failed", reason: "needs_code" },
    not_found: { kind: "failed", reason: "not_pending" },
    not_pending: { kind: "failed", reason: "not_pending" },
    changed: { kind: "failed", reason: "changed" },
    self: { kind: "failed", reason: "self" },
    invalid: { kind: "failed", reason: "invalid" },
  };

  it.each(RETURN_ANSWERS)("la base contesta %s", (answer) => {
    expect(returnOutcome({ kind: "answered", answer })).toEqual(cases[answer]);
  });

  it("refused: a esta misma página, donde decide la guarda", () => {
    expect(returnOutcome({ kind: "refused" })).toEqual(TO_PAGE);
  });

  it("no se supo nunca se pinta como hecho", () => {
    expect(returnOutcome({ kind: "unavailable" })).toEqual({ kind: "failed", reason: "unavailable" });
    expect(returnOutcome({ kind: "unknown" })).toEqual({ kind: "failed", reason: "unknown" });
  });

  it("un curso sin forma: la cola de ahora lo aclara", () => {
    expect(returnOutcome({ kind: "malformed" })).toEqual({ kind: "failed", reason: "not_pending" });
  });
});

describe("reviewVideoAnswerOf", () => {
  it("lleva la marca de agua", () => {
    const answer = reviewVideoAnswerOf({ kind: "granted", playbackId: "P", tokens: { video: "v", thumbnail: "t", storyboard: "s" }, expiresAt: 9, speeds: [1], watermark: "yo@prueba.test" });
    expect(answer).toEqual({ kind: "granted", playbackId: "P", tokens: { playback: "v", thumbnail: "t", storyboard: "s" }, speeds: [1], watermark: "yo@prueba.test" });
  });

  it("lo demás", () => {
    expect(reviewVideoAnswerOf({ kind: "refused" })).toEqual(TO_PAGE);
    expect(reviewVideoAnswerOf({ kind: "no_video" })).toEqual({ kind: "no_video" });
    expect(reviewVideoAnswerOf({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
  });
});
