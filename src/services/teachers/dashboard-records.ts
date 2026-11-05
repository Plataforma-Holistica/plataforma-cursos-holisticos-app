import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { DashboardAnswer } from "./dashboard";
import { periodSegment } from "./payout-report";

// Lo que el panel del maestro le pregunta a la base, como el servidor y a nombre de la persona (T-408). `teacher_dashboard` se nombra solo aquí. La
// respuesta se lee con una forma estricta: si la base trajera una clave de más (algo de un alumno, el porcentaje del bote), falla y es «no se supo».

const answerRow = z.object({ answer: z.unknown() }).strict();

const count = z.number().int().min(0);
const money = z.number().int().min(0);
const period = z.number().int().min(200001).max(999912);
const instant = z.string().min(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

// El mes en curso: con corrida buena, todo; sin ella, todo nulo (y sin nada viejo que decir). Una mezcla no tiene forma.
const current = z.union([
  z
    .object({
      period_id: period, estimated_cents: money, full_lessons: count, half_lessons: count, students: count, updated_at: instant, last_failed: z.boolean(),
      stale: z.boolean(),
    })
    .strict(),
  z
    .object({
      period_id: period, estimated_cents: z.null(), full_lessons: z.null(), half_lessons: z.null(), students: z.null(), updated_at: z.null(), last_failed: z.boolean(),
      stale: z.literal(false),
    })
    .strict(),
]);

const course = z.union([
  z.object({ course_id: uuid, title: z.string().nullable(), full_lessons: count, half_lessons: count, students: count }).strict(),
  z.object({ course_id: uuid, title: z.string().nullable(), full_lessons: z.null(), half_lessons: z.null(), students: z.null() }).strict(),
]);

const dashboardAnswer = z.union([
  z
    .object({
      outcome: z.literal("ok"),
      has_published: z.boolean(),
      current,
      courses: z.array(course),
      series: z.array(z.object({ period_id: period, cents: money.nullable(), estimated: z.boolean() }).strict()).max(12),
    })
    .strict(),
  z.object({ outcome: z.literal("not_teacher") }).strict(),
]);

export async function askTeacherDashboard(tx: Tx): Promise<DashboardAnswer> {
  const rows = await tx.query(sql`select private.teacher_dashboard() as answer`, answerRow);
  const a = dashboardAnswer.parse(rows[0]?.answer);
  if (a.outcome !== "ok") return a;
  const now = a.current;
  return {
    outcome: "ok",
    value: {
      hasPublished: a.has_published,
      current: {
        period: periodSegment(now.period_id),
        run:
          now.updated_at === null
            ? null
            : {
                estimatedCents: now.estimated_cents, fullLessons: now.full_lessons, halfLessons: now.half_lessons, students: now.students,
                updatedAt: new Date(now.updated_at).toISOString(),
              },
        lastFailed: now.last_failed,
        stale: now.stale,
      },
      courses: a.courses.map((c) => ({
        courseId: c.course_id,
        title: c.title,
        figures: c.full_lessons === null ? null : { fullLessons: c.full_lessons, halfLessons: c.half_lessons, students: c.students },
      })),
      series: a.series.map((s) => ({ period: periodSegment(s.period_id), cents: s.cents, estimated: s.estimated })),
    },
  };
}
