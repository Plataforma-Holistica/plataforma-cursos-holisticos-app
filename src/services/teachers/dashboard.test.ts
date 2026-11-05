import { describe, expect, it } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import type { FailureCode } from "@/services/error-reporting/server";

import { createDashboard, type DashboardStore } from "./dashboard";
import { askTeacherDashboard } from "./dashboard-records";

// El servicio del panel del maestro (PA-41, T-408), con la base simulada: lo que se acepta de `private.teacher_dashboard()` (la forma exacta y nada más)
// y «no se supo». Lo que la base decide lo prueba la 82, y el camino contra la base local, la integración 110.

const claims = { sub: "a0000000-0000-4000-8000-000000000001" } as unknown as VerifiedClaims;
const COURSE = "c0000000-0000-4000-8000-000000000001";

const OK = {
  outcome: "ok",
  has_published: true,
  current: { period_id: 203103, estimated_cents: 123_456, full_lessons: 214, half_lessons: 37, students: 58, updated_at: "2031-03-12T11:40:00.123+00:00", last_failed: false, stale: false },
  courses: [{ course_id: COURSE, title: "Respirar para volver", full_lessons: 150, half_lessons: 22, students: 41 }],
  series: [
    { period_id: 203101, cents: 98_000, estimated: false },
    { period_id: 203102, cents: 101_234, estimated: true },
  ],
};

/** Una transacción que contesta lo que se le diga, pasándolo por la forma de la fila como la de verdad. */
const txAnswering = (answer: unknown) =>
  ({ query: (_query: unknown, row: { parse: (value: unknown) => unknown }) => Promise.resolve([row.parse({ answer })]) }) as unknown as Tx;

describe("la lectura de la base", () => {
  it("traduce la respuesta: el periodo como «AAAA-MM», la fecha como ISO, y las cifras con su nombre", async () => {
    expect(await askTeacherDashboard(txAnswering(OK))).toEqual({
      outcome: "ok",
      value: {
        hasPublished: true,
        current: {
          period: "2031-03",
          run: { estimatedCents: 123_456, fullLessons: 214, halfLessons: 37, students: 58, updatedAt: "2031-03-12T11:40:00.123Z" },
          lastFailed: false,
          stale: false,
        },
        courses: [{ courseId: COURSE, title: "Respirar para volver", figures: { fullLessons: 150, halfLessons: 22, students: 41 } }],
        series: [
          { period: "2031-01", cents: 98_000, estimated: false },
          { period: "2031-02", cents: 101_234, estimated: true },
        ],
      },
    });
  });

  it("sin corrida buena, el mes y los cursos sin cifras, y la serie sin cifra en cierre", async () => {
    const answer = {
      ...OK,
      current: { period_id: 203103, estimated_cents: null, full_lessons: null, half_lessons: null, students: null, updated_at: null, last_failed: true, stale: false },
      courses: [{ course_id: COURSE, title: null, full_lessons: null, half_lessons: null, students: null }],
      series: [{ period_id: 203102, cents: null, estimated: true }],
    };
    const read = await askTeacherDashboard(txAnswering(answer));
    expect(read).toEqual({
      outcome: "ok",
      value: {
        hasPublished: true,
        current: { period: "2031-03", run: null, lastFailed: true, stale: false },
        courses: [{ courseId: COURSE, title: null, figures: null }],
        series: [{ period: "2031-02", cents: null, estimated: true }],
      },
    });
  });

  it("quien no es maestro pasa tal cual", async () => {
    expect(await askTeacherDashboard(txAnswering({ outcome: "not_teacher" }))).toEqual({ outcome: "not_teacher" });
  });

  it.each<[string, unknown]>([
    ["una clave de más arriba", { ...OK, pool_bps: 6_000 }],
    ["una clave de más en el mes", { ...OK, current: { ...OK.current, pool_bps: 6_000 } }],
    ["algo de un alumno en un curso", { ...OK, courses: [{ ...OK.courses[0], profile_id: COURSE }] }],
    ["una clave de más en la serie", { ...OK, series: [{ ...OK.series[0], base_cents: 1 }] }],
    ["el mes con cifras y sin fecha", { ...OK, current: { ...OK.current, updated_at: null } }],
    ["el mes con fecha y sin cifras", { ...OK, current: { ...OK.current, estimated_cents: null } }],
    ["el mes sin corrida y viejo", { ...OK, current: { ...OK.current, estimated_cents: null, full_lessons: null, half_lessons: null, students: null, updated_at: null, stale: true } }],
    ["el mes sin decir si es viejo", { ...OK, current: { ...OK.current, stale: undefined } }],
    ["un curso con cifras a medias", { ...OK, courses: [{ ...OK.courses[0], students: null }] }],
    ["una cifra negativa", { ...OK, current: { ...OK.current, estimated_cents: -1 } }],
    ["una fecha que no se entiende", { ...OK, current: { ...OK.current, updated_at: "ayer" } }],
    ["un curso sin identificador con forma", { ...OK, courses: [{ ...OK.courses[0], course_id: "uno" }] }],
    ["más de 12 periodos", { ...OK, series: Array.from({ length: 13 }, (_, i) => ({ period_id: 203001 + i, cents: 1, estimated: false })) }],
    ["un resultado que no conoce", { outcome: "closed" }],
    ["nada", undefined],
  ])("%s no tiene forma: falla", async (_name, answer) => {
    await expect(askTeacherDashboard(txAnswering(answer))).rejects.toThrow();
  });
});

function harness(store: DashboardStore) {
  const reported: FailureCode[] = [];
  const service = createDashboard({
    store,
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
  return { service, reported };
}

describe("el servicio", () => {
  it("le pregunta a la base con las claims de la guarda y devuelve lo que contestó", async () => {
    const asked: VerifiedClaims[] = [];
    const { service, reported } = harness({
      read: (given) => {
        asked.push(given);
        return Promise.resolve({ outcome: "not_teacher" });
      },
    });
    expect(await service.teacherDashboard(claims)).toEqual({ kind: "ready", value: { outcome: "not_teacher" } });
    expect(asked).toEqual([claims]);
    expect(reported).toEqual([]);
  });

  it("si la base no contesta, o contesta sin forma, «no se supo», y se reporta", async () => {
    const { service, reported } = harness({ read: () => Promise.reject(new Error("caída")) });
    expect(await service.teacherDashboard(claims)).toEqual({ kind: "unavailable" });
    expect(reported).toEqual(["teacher_dashboard_unavailable"]);
  });
});
