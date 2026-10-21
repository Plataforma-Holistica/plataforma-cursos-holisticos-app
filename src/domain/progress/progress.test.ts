import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { courseProgress, lessonState, RESUME_RULES, resumeAt, suggestedLesson, type LessonProgressFacts } from "./progress";

// El progreso como lo lee la Plataforma (RF-307; T-206): en qué estado está cada lección, desde
// dónde arranca el video, cuánto lleva un curso y qué lección se sugiere. Lo que se vio y si se
// terminó lo decide la base al registrar los latidos; aquí solo se lee.

const facts = (over: Partial<LessonProgressFacts> = {}): LessonProgressFacts => ({
  coveredSeconds: 0,
  position: 0,
  completed: false,
  sameVideo: true,
  ...over,
});

describe("el estado de una lección", () => {
  it.each([
    ["sin fila", null, "not_started"],
    ["fila sin nada visto ni posición", facts(), "not_started"],
    ["algo visto", facts({ coveredSeconds: 1 }), "in_progress"],
    ["solo la posición (lo visto fue con la pestaña oculta)", facts({ position: 30 }), "in_progress"],
    ["terminada", facts({ coveredSeconds: 90, completed: true }), "completed"],
    ["terminada aunque no haya visto nada del video nuevo", facts({ completed: true, sameVideo: false }), "completed"],
    ["lo visto era de otro video", facts({ coveredSeconds: 50, position: 50, sameVideo: false }), "not_started"],
  ] as const)("%s", (_, progress, state) => {
    expect(lessonState(progress)).toBe(state);
  });

  it("terminada manda sobre todo lo demás", () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.boolean(), (coveredSeconds, position, sameVideo) => {
        expect(lessonState(facts({ coveredSeconds, position, sameVideo, completed: true }))).toBe("completed");
      }),
    );
  });
});

describe("desde dónde arranca el video (decisión de Sergio del 2026-10-20)", () => {
  it("las reglas: el 5 % del final, y al menos 10 segundos", () => {
    expect(RESUME_RULES).toEqual({ tailShare: 0.05, tailSeconds: 10 });
  });

  it.each([
    ["sin posición", null, 600, 0],
    ["al principio", 0, 600, 0],
    ["a media lección", 300, 600, 300],
    ["con fracción, baja al segundo", 300.9, 600, 300],
    ["le faltan justo 30 s de 600 (el 5 %): sigue", 570, 600, 570],
    ["le faltan menos del 5 %: desde el principio", 571, 600, 0],
    ["en lecciones cortas manda el mínimo de 10 s: le faltan 10, sigue", 50, 60, 50],
    ["le faltan menos de 10 s: desde el principio", 51, 60, 0],
    ["al final", 600, 600, 0],
    ["más allá del final", 900, 600, 0],
    ["una posición negativa", -5, 600, 0],
    ["una posición que no es un número", Number.NaN, 600, 0],
    ["una posición infinita", Number.POSITIVE_INFINITY, 600, 0],
    ["sin duración", 30, 0, 0],
    ["duración negativa", 30, -10, 0],
    ["duración que no es un número", 30, Number.NaN, 0],
  ] as const)("%s", (_, position, duration, start) => {
    expect(resumeAt(position, duration)).toBe(start);
  });

  it("nunca arranca fuera del video, ni en la cola", () => {
    fc.assert(
      fc.property(fc.option(fc.double({ min: -1e6, max: 1e6 })), fc.integer({ min: -10, max: 100_000 }), (position, duration) => {
        const start = resumeAt(position, duration);
        expect(Number.isInteger(start)).toBe(true);
        expect(start).toBeGreaterThanOrEqual(0);
        if (start > 0) {
          expect(start).toBeLessThanOrEqual(position ?? 0);
          expect(duration - start).toBeGreaterThanOrEqual(Math.max(duration * RESUME_RULES.tailShare, RESUME_RULES.tailSeconds));
        }
      }),
    );
  });

  it("donde se quedó, si le falta más que la cola", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), (duration, position) => {
        fc.pre(position < duration - Math.max(duration * RESUME_RULES.tailShare, RESUME_RULES.tailSeconds));
        expect(resumeAt(position, duration)).toBe(position);
      }),
    );
  });
});

describe("el avance de un curso", () => {
  it.each([
    ["sin lecciones", [], { completed: 0, total: 0, finished: false }],
    ["ninguna terminada", [false, false], { completed: 0, total: 2, finished: false }],
    ["una de tres", [true, false, false], { completed: 1, total: 3, finished: false }],
    ["todas", [true, true], { completed: 2, total: 2, finished: true }],
  ] as const)("%s", (_, completed, answer) => {
    expect(courseProgress(completed.map((each) => ({ completed: each })))).toEqual(answer);
  });

  it("terminado es todas, y nunca cuenta de más", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 40 }), (completed) => {
        const answer = courseProgress(completed.map((each) => ({ completed: each })));
        expect(answer.total).toBe(completed.length);
        expect(answer.completed).toBe(completed.filter(Boolean).length);
        expect(answer.finished).toBe(completed.length > 0 && completed.every(Boolean));
      }),
    );
  });
});

describe("la lección sugerida (decisión de Sergio del 2026-10-20)", () => {
  const course = (...completed: boolean[]) => completed.map((each, index) => ({ id: `l${index + 1}`, completed: each }));

  it.each([
    ["sin historial, la primera", course(false, false, false), null, "l1"],
    ["la última que vio, si no la terminó", course(true, false, false), "l3", "l3"],
    ["aunque haya terminadas antes", course(false, true, false), "l3", "l3"],
    ["si la terminó, la siguiente sin terminar", course(false, true, true, false, false), "l2", "l4"],
    ["si después no hay, la primera sin terminar", course(false, true, true), "l3", "l1"],
    ["si la que vio ya no está en el temario, la primera sin terminar", course(true, false, false), "retirada", "l2"],
    ["todas terminadas: ninguna", course(true, true), "l2", null],
    ["sin lecciones: ninguna", [], "l1", null],
  ] as const)("%s", (_, lessons, last, suggested) => {
    expect(suggestedLesson(lessons, last)).toBe(suggested);
  });

  it("nunca sugiere una terminada si queda alguna sin terminar, y siempre una del temario", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 20 }), fc.option(fc.integer({ min: -2, max: 22 })), (completed, pick) => {
        const lessons = course(...completed);
        const last = pick === null ? null : `l${pick}`;
        const suggested = suggestedLesson(lessons, last);
        if (completed.every(Boolean)) {
          expect(suggested).toBeNull();
          return;
        }
        const found = lessons.find((lesson) => lesson.id === suggested);
        expect(found?.completed).toBe(false);
      }),
    );
  });
});
