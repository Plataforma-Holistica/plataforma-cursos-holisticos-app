import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { AccountAccess } from "./account-access";
import {
  COURSE_STATES,
  GRANT_MARGIN_SECONDS,
  GRANT_MAX_SECONDS,
  grantLifetimeSeconds,
  MAX_PLAYBACK_RATES,
  MEDIA_PURPOSES,
  mayReview,
  playbackRates,
  resolveMediaAccess,
  watermarkText,
  type MediaAccess,
  type MediaLesson,
  type MediaViewer,
} from "./media-access";

// La puerta de los medios (RF-305, RF-306; TRD §5.1), con sus cuatro reglas: revisar,
// el maestro dueño, el alumno con acceso (RN-01) y el curso abierto (RF-309). Y cuánto dura
// una dirección (ADR-27).

const TEACHER = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER = "22222222-2222-4222-8222-222222222222";
const LATER = new Date("2026-11-01T00:00:00.000Z");
const BEFORE = new Date("2026-10-01T00:00:00.000Z");

const LISTED: MediaLesson = {
  isCurrent: true,
  provider: "mux",
  ready: true,
  teacherId: TEACHER,
  courseState: "published",
  listed: true,
  isOpen: false,
};
const STUDENT: MediaViewer = { accountSuspended: false, content: false, teacherId: null, emailVerified: true };
const CONTENT: MediaViewer = { ...STUDENT, content: true };
const OWNER: MediaViewer = { ...STUDENT, teacherId: TEACHER };

const PAID: AccountAccess = { allowed: true, basis: "subscription", until: LATER };
const GRACE: AccountAccess = { allowed: true, basis: "grace", until: LATER };
const COURTESY: AccountAccess = { allowed: true, basis: "courtesy", until: null };
const NEVER: AccountAccess = { allowed: false, reason: "never_subscribed" };
const EXPIRED: AccountAccess = { allowed: false, reason: "expired", endedAt: BEFORE };
const INVALID: AccountAccess = { allowed: false, reason: "invalid_input" };
const SUSPENDED: AccountAccess = { allowed: false, reason: "suspended" };

const watch = (viewer: MediaViewer, account: AccountAccess | null, lesson: MediaLesson | null) =>
  resolveMediaAccess("watch", viewer, account, lesson);

describe("revisar (Contenido)", () => {
  it("alguien del equipo con Contenido ve una lección lista de cualquier curso, y nunca cuenta", () => {
    for (const courseState of COURSE_STATES) {
      expect(resolveMediaAccess("review", CONTENT, null, { ...LISTED, courseState, listed: false })).toEqual({
        ok: true,
        basis: "review",
        countsForPayout: false,
        until: null,
      });
    }
  });

  it("aunque además pague: desde la revisión nunca cuenta (decisión de Sergio del 2026-10-15)", () => {
    expect(resolveMediaAccess("review", CONTENT, PAID, LISTED)).toMatchObject({ ok: true, basis: "review", countsForPayout: false });
  });

  it.each<[string, MediaViewer]>([
    ["una cuenta común", STUDENT],
    ["el maestro dueño", OWNER],
  ])("%s no revisa, exista o no la lección", (_who, viewer) => {
    expect(resolveMediaAccess("review", viewer, PAID, LISTED)).toEqual({ ok: false, reason: "refused" });
    expect(resolveMediaAccess("review", viewer, PAID, null)).toEqual({ ok: false, reason: "refused" });
  });

  it.each<[string, MediaLesson | null]>([
    ["una lección que no existe", null],
    ["una retirada", { ...LISTED, isCurrent: false }],
    ["una con video de prueba", { ...LISTED, provider: "test" }],
    ["una con video sin terminar", { ...LISTED, ready: false }],
  ])("%s no tiene video que firmar", (_what, lesson) => {
    expect(resolveMediaAccess("review", CONTENT, null, lesson)).toEqual({ ok: false, reason: "no_video" });
  });

  it("mayReview: solo con Contenido", () => {
    expect(mayReview(CONTENT)).toBe(true);
    expect(mayReview(STUDENT)).toBe(false);
    expect(mayReview(OWNER)).toBe(false);
  });
});

describe("ver (el área del alumno)", () => {
  describe("1. la cuenta suspendida, antes que todo", () => {
    it.each<[string, MediaViewer, AccountAccess]>([
      ["una alumna que paga", { ...STUDENT, accountSuspended: true }, PAID],
      ["el maestro dueño", { ...OWNER, accountSuspended: true }, PAID],
      ["alguien con Contenido", { ...CONTENT, accountSuspended: true }, PAID],
    ])("%s, suspendida, no ve nada", (_who, viewer, account) => {
      expect(watch(viewer, account, LISTED)).toEqual({ ok: false, reason: "suspended" });
      expect(watch(viewer, account, { ...LISTED, isOpen: true })).toEqual({ ok: false, reason: "suspended" });
    });

    it("también si lo dice la regla de la cuenta y no quien mira", () => {
      expect(watch(STUDENT, SUSPENDED, LISTED)).toEqual({ ok: false, reason: "suspended" });
      expect(watch(STUDENT, SUSPENDED, { ...LISTED, isOpen: true })).toEqual({ ok: false, reason: "suspended" });
    });
  });

  describe("2. un curso que no se puede ver contesta lo mismo que una lección que no existe", () => {
    const hidden: Array<[string, MediaLesson]> = [
      ["en revisión", { ...LISTED, courseState: "in_review", listed: false }],
      ["en borrador", { ...LISTED, courseState: "draft", listed: false }],
      ["retirado", { ...LISTED, courseState: "withdrawn", listed: false }],
      ["publicado sin listar", { ...LISTED, listed: false }],
      ["listado sin estar publicado", { ...LISTED, courseState: "in_review" }],
    ];
    it.each(hidden)("un curso %s, a quien paga: no_video", (_what, lesson) => {
      const missing = watch(STUDENT, PAID, null);
      expect(missing).toEqual({ ok: false, reason: "no_video" });
      expect(watch(STUDENT, PAID, lesson)).toEqual(missing);
      // Ni con la cuenta sin acceso, ni abierto, ni con Contenido (eso es revisar, no ver).
      expect(watch(STUDENT, NEVER, { ...lesson, isOpen: true })).toEqual(missing);
      expect(watch(CONTENT, PAID, lesson)).toEqual(missing);
      expect(watch(STUDENT, INVALID, lesson)).toEqual(missing);
    });

    it("con cambios pendientes sigue publicado", () => {
      expect(watch(STUDENT, PAID, { ...LISTED, courseState: "changes_pending" })).toMatchObject({ ok: true, basis: "subscription" });
    });
  });

  describe("3. sin video que firmar, solo a quien puede ver el curso", () => {
    it.each<[string, MediaLesson]>([
      ["una lección retirada por una versión nueva", { ...LISTED, isCurrent: false }],
      ["un video de prueba", { ...LISTED, provider: "test" }],
      ["un video sin terminar", { ...LISTED, ready: false }],
    ])("%s: no_video, también al dueño", (_what, lesson) => {
      expect(watch(STUDENT, PAID, lesson)).toEqual({ ok: false, reason: "no_video" });
      expect(watch(OWNER, NEVER, { ...lesson, courseState: "in_review", listed: false })).toEqual({ ok: false, reason: "no_video" });
    });
  });

  describe("4. el maestro dueño", () => {
    it.each(COURSE_STATES)("ve lo suyo con el curso %s, y nunca cuenta", (courseState) => {
      expect(watch(OWNER, NEVER, { ...LISTED, courseState, listed: courseState === "published" })).toEqual({
        ok: true,
        basis: "owner_preview",
        countsForPayout: false,
        until: null,
      });
    });

    it("aunque pague, o no se sepa su cuenta: lo suyo no da puntos y no depende de la cuenta", () => {
      expect(watch(OWNER, PAID, LISTED)).toMatchObject({ basis: "owner_preview", countsForPayout: false });
      expect(watch(OWNER, INVALID, LISTED)).toMatchObject({ basis: "owner_preview", countsForPayout: false });
      expect(watch(OWNER, null, LISTED)).toMatchObject({ basis: "owner_preview", countsForPayout: false });
    });

    it("lo de otro maestro lo ve como cualquiera: pagando, cuenta", () => {
      expect(watch({ ...STUDENT, teacherId: OTHER_TEACHER }, PAID, LISTED)).toMatchObject({ basis: "subscription", countsForPayout: true });
      expect(watch({ ...STUDENT, teacherId: OTHER_TEACHER }, PAID, { ...LISTED, courseState: "in_review", listed: false })).toEqual({
        ok: false,
        reason: "no_video",
      });
    });
  });

  describe("5. «no se supo» de la cuenta", () => {
    it("es unknown (PA-18, nunca PA-33), también en el curso abierto: quizá paga", () => {
      expect(watch(STUDENT, INVALID, LISTED)).toEqual({ ok: false, reason: "unknown" });
      expect(watch(STUDENT, INVALID, { ...LISTED, isOpen: true })).toEqual({ ok: false, reason: "unknown" });
      expect(watch(STUDENT, null, LISTED)).toEqual({ ok: false, reason: "unknown" });
    });
  });

  describe("6 y 7. la suscripción, la gracia y la cortesía", () => {
    it.each<[string, AccountAccess, Partial<MediaAccess>]>([
      ["suscripción: cuenta", PAID, { basis: "subscription", countsForPayout: true, until: LATER }],
      ["gracia: cuenta", GRACE, { basis: "grace", countsForPayout: true, until: LATER }],
      ["cortesía: no cuenta (RN-08)", COURTESY, { basis: "courtesy", countsForPayout: false, until: null }],
    ])("%s", (_what, account, expected) => {
      expect(watch(STUDENT, account, LISTED)).toEqual({ ok: true, ...expected });
    });

    it("en el curso abierto, quien paga cuenta (RN-08 solo excluye a quien no paga)", () => {
      expect(watch(STUDENT, PAID, { ...LISTED, isOpen: true })).toMatchObject({ basis: "subscription", countsForPayout: true });
      expect(watch(STUDENT, GRACE, { ...LISTED, isOpen: true })).toMatchObject({ basis: "grace", countsForPayout: true });
    });

    it("y la cortesía sigue siendo cortesía", () => {
      expect(watch(STUDENT, COURTESY, { ...LISTED, isOpen: true })).toMatchObject({ basis: "courtesy", countsForPayout: false });
    });

    it("alguien del equipo que paga cuenta como cualquier alumno (decisión de Sergio del 2026-10-15)", () => {
      expect(watch(CONTENT, PAID, LISTED)).toMatchObject({ basis: "subscription", countsForPayout: true });
    });
  });

  describe("8. el curso abierto", () => {
    it("lo ve una cuenta verificada sin suscripción, sin puntos", () => {
      expect(watch(STUDENT, NEVER, { ...LISTED, isOpen: true })).toEqual({
        ok: true,
        basis: "open_course",
        countsForPayout: false,
        until: null,
      });
      expect(watch(STUDENT, EXPIRED, { ...LISTED, isOpen: true })).toMatchObject({ basis: "open_course" });
    });

    it("con el correo sin verificar no", () => {
      expect(watch({ ...STUDENT, emailVerified: false }, NEVER, { ...LISTED, isOpen: true })).toEqual({
        ok: false,
        reason: "no_access",
        account: NEVER,
      });
    });
  });

  describe("9. sin acceso: el motivo de la cuenta, para PA-33", () => {
    it.each<AccountAccess>([
      NEVER,
      EXPIRED,
      { allowed: false, reason: "grace_ended", endedAt: BEFORE },
      { allowed: false, reason: "refunded", endedAt: BEFORE },
    ])("%j", (account) => {
      expect(watch(STUDENT, account, LISTED)).toEqual({ ok: false, reason: "no_access", account });
    });
  });
});

describe("propiedades", () => {
  const instant = fc.date({ min: new Date("2026-01-01T00:00:00.000Z"), max: new Date("2027-12-31T00:00:00.000Z"), noInvalidDate: true });
  const account: fc.Arbitrary<AccountAccess | null> = fc.oneof(
    fc.constant(null),
    fc.record({
      allowed: fc.constant(true as const),
      basis: fc.constantFrom("subscription" as const, "grace" as const, "courtesy" as const),
      until: fc.option(instant, { nil: null }),
    }),
    fc.record({
      allowed: fc.constant(false as const),
      reason: fc.constantFrom("expired" as const, "grace_ended" as const, "refunded" as const),
      endedAt: instant,
    }),
    fc.record({
      allowed: fc.constant(false as const),
      reason: fc.constantFrom("suspended" as const, "never_subscribed" as const, "invalid_input" as const),
    }),
  );
  const teacher = fc.constantFrom(TEACHER, OTHER_TEACHER);
  const viewer: fc.Arbitrary<MediaViewer> = fc.record({
    accountSuspended: fc.boolean(),
    content: fc.boolean(),
    teacherId: fc.option(teacher, { nil: null }),
    emailVerified: fc.boolean(),
  });
  const lesson: fc.Arbitrary<MediaLesson | null> = fc.option(
    fc.record({
      isCurrent: fc.boolean(),
      provider: fc.constantFrom("mux", "test"),
      ready: fc.boolean(),
      teacherId: teacher,
      courseState: fc.constantFrom(...COURSE_STATES),
      listed: fc.boolean(),
      isOpen: fc.boolean(),
    }),
    { nil: null },
  );
  const purpose = fc.constantFrom(...MEDIA_PURPOSES);

  it("solo cuentan la suscripción y la gracia, y nunca el dueño", () => {
    fc.assert(
      fc.property(purpose, viewer, account, lesson, (p, v, a, l) => {
        const result = resolveMediaAccess(p, v, a, l);
        if (!result.ok || !result.countsForPayout) return;
        expect(["subscription", "grace"]).toContain(result.basis);
        expect(p).toBe("watch");
        expect(l?.teacherId).not.toBe(v.teacherId);
        expect(a?.allowed && a.basis).toBe(result.basis);
      }),
    );
  });

  it("con acceso, siempre hay un video que firmar y quien puede verlo", () => {
    fc.assert(
      fc.property(purpose, viewer, account, lesson, (p, v, a, l) => {
        const result = resolveMediaAccess(p, v, a, l);
        if (!result.ok) return;
        expect(l).not.toBeNull();
        expect(l?.isCurrent && l.provider === "mux" && l.ready).toBe(true);
        if (p === "review") expect(v.content).toBe(true);
        else {
          expect(v.accountSuspended).toBe(false);
          const visible = l?.teacherId === v.teacherId || (l?.listed && (l.courseState === "published" || l.courseState === "changes_pending"));
          expect(visible).toBe(true);
        }
      }),
    );
  });

  it("una cuenta suspendida nunca ve desde el área del alumno", () => {
    fc.assert(
      fc.property(viewer, account, lesson, (v, a, l) => {
        expect(resolveMediaAccess("watch", { ...v, accountSuspended: true }, a, l).ok).toBe(false);
      }),
    );
  });

  it("lo que no se puede ver contesta igual que lo que no existe", () => {
    fc.assert(
      fc.property(viewer, account, lesson, (v, a, l) => {
        if (l === null || l.teacherId === v.teacherId || v.accountSuspended) return;
        if (l.listed && (l.courseState === "published" || l.courseState === "changes_pending")) return;
        expect(resolveMediaAccess("watch", v, a, l)).toEqual(resolveMediaAccess("watch", v, a, null));
      }),
    );
  });

  it("nunca lanza", () => {
    fc.assert(
      fc.property(purpose, viewer, account, lesson, (p, v, a, l) => {
        expect(() => resolveMediaAccess(p, v, a, l)).not.toThrow();
      }),
    );
  });
});

describe("grantLifetimeSeconds", () => {
  it.each([
    ["una lección de 6 minutos a 0.75×", 356, 0.75, 475 + GRANT_MARGIN_SECONDS],
    ["una de 20 minutos a 0.75×", 1200, 0.75, 1600 + GRANT_MARGIN_SECONDS],
    ["una de 25 minutos a 0.75×: 43 minutos, bajo la hora", 1500, 0.75, 2000 + GRANT_MARGIN_SECONDS],
    ["una de 40 minutos: el tope", 2400, 0.75, GRANT_MAX_SECONDS],
    ["a velocidad normal", 600, 1, 600 + GRANT_MARGIN_SECONDS],
  ])("%s", (_what, duration, speed, expected) => {
    expect(grantLifetimeSeconds(duration, speed)).toBe(expected);
  });

  it("redondea hacia arriba: nunca caduca antes de terminar", () => {
    expect(grantLifetimeSeconds(1, 0.75)).toBe(2 + GRANT_MARGIN_SECONDS);
  });

  it.each([
    ["una duración cero", 0, 0.75],
    ["una duración negativa", -10, 0.75],
    ["una duración que no es un número", Number.NaN, 0.75],
    ["una duración infinita", Number.POSITIVE_INFINITY, 0.75],
    ["una velocidad que no es un número", 600, Number.NaN],
    ["una velocidad cero", 600, 0],
    ["una velocidad negativa", 600, -1],
    ["una velocidad infinita", 600, Number.POSITIVE_INFINITY],
  ])("%s: nulo", (_what, duration, speed) => {
    expect(grantLifetimeSeconds(duration, speed)).toBeNull();
  });

  it("el tope es menos de una hora, y nada lo pasa", () => {
    expect(GRANT_MAX_SECONDS).toBeLessThan(3600);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.double({ min: 0.1, max: 4, noNaN: true }), (duration, speed) => {
        const life = grantLifetimeSeconds(duration, speed);
        expect(life).not.toBeNull();
        expect(life ?? 0).toBeLessThanOrEqual(GRANT_MAX_SECONDS);
        // Y alcanza para la lección entera a esa velocidad, o llega al tope.
        expect((life ?? 0) >= Math.min(duration / speed + GRANT_MARGIN_SECONDS, GRANT_MAX_SECONDS)).toBe(true);
      }),
    );
  });
});

describe("playbackRates: el menú de velocidades (RF-312; 03 §5.4)", () => {
  it("de VELOCIDAD_MIN a VELOCIDAD_MAX en pasos de 0.25", () => {
    expect(playbackRates(0.75, 2)).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2]);
  });

  it.each([
    ["una mínima entre pasos empieza en el siguiente", 0.8, 1.5, [1, 1.25, 1.5]],
    ["una máxima entre pasos termina en el anterior", 1, 1.6, [1, 1.25, 1.5]],
    ["las dos iguales: una sola", 1, 1, [1]],
  ])("%s", (_what, minimum, maximum, expected) => {
    expect(playbackRates(minimum, maximum)).toEqual(expected);
  });

  it.each([
    ["una mínima que no es un número", Number.NaN, 2],
    ["una máxima que no es un número", 0.75, Number.NaN],
    ["una mínima cero", 0, 2],
    ["una mínima negativa", -1, 2],
    ["una máxima infinita", 0.75, Number.POSITIVE_INFINITY],
    ["la máxima menor que la mínima", 2, 0.75],
    ["sin un paso entre las dos", 1.1, 1.2],
    ["más pasos de los que caben en un menú", 0.25, 0.25 * (MAX_PLAYBACK_RATES + 1)],
  ])("%s: nulo", (_what, minimum, maximum) => {
    expect(playbackRates(minimum, maximum)).toBeNull();
  });

  it("todo lo que da cae entre las dos, en pasos de 0.25, en orden y sin repetir", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 4, noNaN: true }), fc.double({ min: 0.05, max: 4, noNaN: true }), (a, b) => {
        const rates = playbackRates(a, b);
        if (rates === null) return;
        expect(rates.length).toBeGreaterThan(0);
        expect(rates.length).toBeLessThanOrEqual(MAX_PLAYBACK_RATES);
        for (const [index, rate] of rates.entries()) {
          expect(rate).toBeGreaterThanOrEqual(a);
          expect(rate).toBeLessThanOrEqual(b);
          expect(Number.isInteger(rate * 4)).toBe(true);
          if (index > 0) expect(rate - rates[index - 1]!).toBe(0.25);
        }
      }),
    );
  });
});

describe("watermarkText: el correo de la marca de agua (RF-305; 03 §5.4)", () => {
  it("el correo, tal cual", () => {
    expect(watermarkText("ana@correo.com")).toBe("ana@correo.com");
    expect(watermarkText("Ana.Lopez+cursos@sub.correo.mx")).toBe("Ana.Lopez+cursos@sub.correo.mx");
  });

  it("no pide más forma que una arroba: un correo que Auth aceptó no deja a nadie sin video", () => {
    expect(watermarkText("raro@local")).toBe("raro@local");
  });

  it.each([
    ["nulo", null],
    ["algo que no es texto", 7],
    ["vacío", ""],
    ["solo espacios", "   "],
    ["sin arroba", "ana.correo.com"],
    ["demasiado largo", `${"a".repeat(320)}@correo.com`],
    ["con un salto de línea", "ana@correo.com\nOtra cosa"],
    ["con un carácter de control", "ana@correo.com\u0000"],
  ])("%s: nulo", (_what, value) => {
    expect(watermarkText(value)).toBeNull();
  });
});
