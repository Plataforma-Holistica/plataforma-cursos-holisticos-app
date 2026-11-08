import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { AccountAccess } from "./account-access";
import {
  commentAllows,
  COMMENT_LEVELS,
  COURSE_STATES,
  resolveCommentAccess,
  resolveMediaAccess,
  type CommentAccess,
  type MediaLesson,
  type MediaResource,
  type MediaViewer,
} from "./media-access";

// Quién lee y quién escribe los comentarios de una lección (RF-801, RF-309; RN-01; FL-15). La base no mira el acceso:
// esta regla es la única defensa, y el servidor la corre en la misma transacción en que llama a la base.

const TEACHER = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER = "22222222-2222-4222-8222-222222222222";
const LATER = new Date("2026-11-01T00:00:00.000Z");
const BEFORE = new Date("2026-10-01T00:00:00.000Z");

const LISTED: MediaResource = { isCurrent: true, teacherId: TEACHER, courseState: "published", listed: true, isOpen: false };
const OPEN: MediaResource = { ...LISTED, isOpen: true };
const STUDENT: MediaViewer = { accountSuspended: false, content: false, teacherId: null, emailVerified: true };
const OWNER: MediaViewer = { ...STUDENT, teacherId: TEACHER };

const PAID: AccountAccess = { allowed: true, basis: "subscription", until: LATER };
const GRACE: AccountAccess = { allowed: true, basis: "grace", until: LATER };
const COURTESY: AccountAccess = { allowed: true, basis: "courtesy", until: null };
const NEVER: AccountAccess = { allowed: false, reason: "never_subscribed" };
const EXPIRED: AccountAccess = { allowed: false, reason: "expired", endedAt: BEFORE };
const INVALID: AccountAccess = { allowed: false, reason: "invalid_input" };
const SUSPENDED: AccountAccess = { allowed: false, reason: "suspended" };

const WRITE: CommentAccess = { ok: true, level: "write" };
const READ: CommentAccess = { ok: true, level: "read" };
const NOT_FOUND: CommentAccess = { ok: false, reason: "not_found" };

describe("los comentarios de una lección", () => {
  it("1. la cuenta suspendida, antes que todo: por la guarda o por la regla de la cuenta", () => {
    expect(resolveCommentAccess({ ...STUDENT, accountSuspended: true }, PAID, LISTED)).toEqual({ ok: false, reason: "suspended" });
    expect(resolveCommentAccess(STUDENT, SUSPENDED, LISTED)).toEqual({ ok: false, reason: "suspended" });
    expect(resolveCommentAccess({ ...OWNER, accountSuspended: true }, null, null)).toEqual({ ok: false, reason: "suspended" });
  });

  it("2. solo en la lección vigente de un curso publicado y listado, también para su maestro", () => {
    expect(resolveCommentAccess(STUDENT, PAID, null)).toEqual(NOT_FOUND);
    expect(resolveCommentAccess(STUDENT, PAID, { ...LISTED, isCurrent: false })).toEqual(NOT_FOUND);
    expect(resolveCommentAccess(STUDENT, PAID, { ...LISTED, listed: false })).toEqual(NOT_FOUND);
    expect(resolveCommentAccess(OWNER, null, { ...LISTED, listed: false })).toEqual(NOT_FOUND);
    expect(resolveCommentAccess(OWNER, null, { ...LISTED, isCurrent: false })).toEqual(NOT_FOUND);
    for (const state of ["draft", "in_review", "withdrawn"] as const) {
      expect(resolveCommentAccess(STUDENT, PAID, { ...LISTED, courseState: state })).toEqual(NOT_FOUND);
      expect(resolveCommentAccess(OWNER, null, { ...LISTED, courseState: state })).toEqual(NOT_FOUND);
    }
    expect(resolveCommentAccess(STUDENT, PAID, { ...LISTED, courseState: "changes_pending" })).toEqual(WRITE);
  });

  it("3. el maestro de la lección escribe en lo suyo, sin depender de su cuenta", () => {
    expect(resolveCommentAccess(OWNER, null, LISTED)).toEqual(WRITE);
    expect(resolveCommentAccess(OWNER, NEVER, LISTED)).toEqual(WRITE);
    expect(resolveCommentAccess(OWNER, INVALID, LISTED)).toEqual(WRITE);
    // En lo de otro maestro es un alumno más.
    expect(resolveCommentAccess({ ...STUDENT, teacherId: OTHER_TEACHER }, NEVER, LISTED)).toEqual({ ok: false, reason: "no_access", account: NEVER });
  });

  it("4. «no se supo» de la cuenta, también en el curso abierto", () => {
    expect(resolveCommentAccess(STUDENT, null, LISTED)).toEqual({ ok: false, reason: "unknown" });
    expect(resolveCommentAccess(STUDENT, INVALID, LISTED)).toEqual({ ok: false, reason: "unknown" });
    expect(resolveCommentAccess(STUDENT, null, OPEN)).toEqual({ ok: false, reason: "unknown" });
    expect(resolveCommentAccess(STUDENT, INVALID, OPEN)).toEqual({ ok: false, reason: "unknown" });
  });

  it("5. la suscripción, la gracia y la cortesía escriben, también en el curso abierto", () => {
    for (const account of [PAID, GRACE, COURTESY]) {
      expect(resolveCommentAccess(STUDENT, account, LISTED)).toEqual(WRITE);
      expect(resolveCommentAccess(STUDENT, account, OPEN)).toEqual(WRITE);
      expect(resolveCommentAccess({ ...STUDENT, emailVerified: false }, account, LISTED)).toEqual(WRITE);
    }
  });

  it("6. el curso abierto sin suscripción, con el correo verificado: lee y no escribe (RF-309, FL-15 E1)", () => {
    expect(resolveCommentAccess(STUDENT, NEVER, OPEN)).toEqual(READ);
    expect(resolveCommentAccess(STUDENT, EXPIRED, OPEN)).toEqual(READ);
    expect(resolveCommentAccess({ ...STUDENT, emailVerified: false }, NEVER, OPEN)).toEqual({ ok: false, reason: "no_access", account: NEVER });
  });

  it("7. si no, sin acceso, con el motivo de la cuenta", () => {
    expect(resolveCommentAccess(STUDENT, NEVER, LISTED)).toEqual({ ok: false, reason: "no_access", account: NEVER });
    expect(resolveCommentAccess(STUDENT, EXPIRED, LISTED)).toEqual({ ok: false, reason: "no_access", account: EXPIRED });
  });

  it("qué deja hacer cada respuesta: escribir pide `write`, leer basta con `read`", () => {
    expect(COMMENT_LEVELS).toEqual(["read", "write"]);
    expect(commentAllows(WRITE, "write")).toBe(true);
    expect(commentAllows(WRITE, "read")).toBe(true);
    expect(commentAllows(READ, "read")).toBe(true);
    expect(commentAllows(READ, "write")).toBe(false);
    for (const refused of [NOT_FOUND, { ok: false, reason: "unknown" } as const, { ok: false, reason: "suspended" } as const]) {
      expect(commentAllows(refused, "read")).toBe(false);
      expect(commentAllows(refused, "write")).toBe(false);
    }
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
  const viewer: fc.Arbitrary<MediaViewer> = fc.record({
    accountSuspended: fc.boolean(),
    content: fc.boolean(),
    teacherId: fc.option(fc.constantFrom(TEACHER, OTHER_TEACHER), { nil: null }),
    emailVerified: fc.boolean(),
  });
  const lesson: fc.Arbitrary<MediaResource | null> = fc.option(
    fc.record({
      isCurrent: fc.boolean(),
      teacherId: fc.constantFrom(TEACHER, OTHER_TEACHER),
      courseState: fc.constantFrom(...COURSE_STATES),
      listed: fc.boolean(),
      isOpen: fc.boolean(),
    }),
    { nil: null },
  );
  const level = fc.constantFrom(...COMMENT_LEVELS);

  it("lo que deja escribir también deja leer", () => {
    fc.assert(
      fc.property(viewer, account, lesson, (v, a, l) => {
        const result = resolveCommentAccess(v, a, l);
        if (commentAllows(result, "write")) expect(commentAllows(result, "read")).toBe(true);
      }),
    );
  });

  it("en un curso que se ve en público, leer los comentarios es lo mismo que ver la lección con su video listo", () => {
    fc.assert(
      fc.property(viewer, account, lesson, (v, a, l) => {
        if (l === null || !l.listed || (l.courseState !== "published" && l.courseState !== "changes_pending")) return;
        const withVideo: MediaLesson = { ...l, provider: "mux", ready: true };
        expect(commentAllows(resolveCommentAccess(v, a, l), "read")).toBe(resolveMediaAccess("watch", v, a, withVideo).ok);
      }),
    );
  });

  it("escribir pide la cuenta con acceso, o ser el maestro de la lección", () => {
    fc.assert(
      fc.property(viewer, account, lesson, (v, a, l) => {
        if (!commentAllows(resolveCommentAccess(v, a, l), "write")) return;
        expect(v.accountSuspended).toBe(false);
        expect(l?.teacherId === v.teacherId || a?.allowed === true).toBe(true);
      }),
    );
  });

  it("nada se permite en lo que no es vigente, publicado y listado", () => {
    fc.assert(
      fc.property(viewer, account, lesson, level, (v, a, l, needed) => {
        if (l !== null && l.isCurrent && l.listed && (l.courseState === "published" || l.courseState === "changes_pending")) return;
        expect(commentAllows(resolveCommentAccess(v, a, l), needed)).toBe(false);
      }),
    );
  });

  it("nunca lanza", () => {
    fc.assert(
      fc.property(viewer, account, lesson, (v, a, l) => {
        expect(() => resolveCommentAccess(v, a, l)).not.toThrow();
      }),
    );
  });
});
