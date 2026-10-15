import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import type { AccountFacts } from "@/domain/access/account-access";
import { COURSE_STATES, type MediaLesson, type MediaViewer } from "@/domain/access/media-access";

// Lo que la función única de medios le pregunta a la base: la lección con su video para
// revisar, los hechos para ver, y la velocidad mínima. Cada función recibe la transacción ya
// abierta.

/** La lección y su video, como los necesita la regla. El playback id sale de aquí, nunca de quien pide. */
export interface LessonVideo extends MediaLesson {
  durationSeconds: number;
  playbackId: string | null;
}

const lessonRow = z.object({
  is_current: z.boolean(),
  duration_seconds: z.number().int(),
  provider: z.string(),
  status: z.string(),
  playback_id: z.string().nullable(),
  teacher_id: z.string(),
  course_state: z.enum(COURSE_STATES),
  listed: z.boolean(),
  is_open: z.boolean(),
});

/**
 * Para revisar: la lección `id` con su video, o nulo si no existe o quien lee no la ve. Se
 * lee como la persona (`asUser`): la política de Contenido sobre lo publicado y los videos es
 * una segunda barrera, además de la guarda del servicio.
 */
export async function readLessonVideo(tx: Tx, id: string): Promise<LessonVideo | null> {
  const [row] = await tx.query(
    sql`select l.is_current, l.duration_seconds, v.provider, v.status::text as status, v.provider_playback_id as playback_id,
               l.teacher_id, r.state::text as course_state, c.is_listed as listed, r.is_open
        from public.published_lessons l
        join public.video_assets v on v.id = l.video_asset_id
        join public.published_courses c on c.course_id = l.course_id
        join public.course_registry r on r.course_id = l.course_id
        where l.id = ${id}::uuid`,
    lessonRow,
  );
  if (!row) return null;
  return {
    isCurrent: row.is_current,
    durationSeconds: row.duration_seconds,
    provider: row.provider,
    ready: row.status === "ready",
    playbackId: row.playback_id,
    teacherId: row.teacher_id,
    courseState: row.course_state,
    listed: row.listed,
    isOpen: row.is_open,
  };
}

/**
 * Para ver: los hechos de quien actúa y de la lección (`private.media_facts`), con la hora de
 * la base, y el playback id que suelta la segunda barrera (`private.lesson_playback`), en la
 * misma transacción: lo que se decide y lo que se firma salen de la misma foto. El playback
 * id no sale del servicio si la regla no da acceso.
 */
export interface WatchFacts {
  now: Date;
  viewer: MediaViewer;
  account: AccountFacts;
  graceDays: number;
  lesson: (MediaLesson & { durationSeconds: number }) | null;
  playbackId: string | null;
}

const instant = z.string().transform((value) => new Date(value));
const factsRow = z
  .object({
    now: instant,
    viewer: z.object({ suspended: z.boolean(), email_verified: z.boolean(), teacher_id: z.string().nullable() }).strict(),
    subscription: z
      .object({
        paid_through: instant.nullable(),
        failed_at: instant.nullable(),
        ended_at: instant.nullable(),
        refunded: z.boolean(),
        grace_days: z.unknown(),
      })
      .strict()
      .nullable(),
    courtesy: z.array(z.object({ from: instant, until: instant.nullable() }).strict()),
    lesson: z
      .object({
        is_current: z.boolean(),
        provider: z.string(),
        ready: z.boolean(),
        duration_seconds: z.number().int(),
        teacher_id: z.string(),
        course_state: z.enum(COURSE_STATES),
        listed: z.boolean(),
        is_open: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const watchRow = z.object({ facts: factsRow.nullable(), playback_id: z.string().nullable() });

/**
 * Nulo si la base no reconoce a quien actúa. Lo que no tenga la forma lanza: es «no se supo».
 * Sin falla, la gracia no se usa y va en 0; con falla y sin un número (el parámetro no
 * existía a esa hora), va `NaN`, y la regla de la cuenta lo contesta como «no se supo».
 */
export async function readWatchFacts(tx: Tx, id: string): Promise<WatchFacts | null> {
  const [row] = await tx.query(
    sql`select private.media_facts(${id}::uuid) as facts, private.lesson_playback(${id}::uuid) as playback_id`,
    watchRow,
  );
  const facts = row?.facts;
  if (!facts) return null;
  const subscription = facts.subscription;
  const graceDays =
    subscription === null || subscription.failed_at === null
      ? 0
      : typeof subscription.grace_days === "number"
        ? subscription.grace_days
        : Number.NaN;
  const lesson = facts.lesson;
  return {
    now: facts.now,
    viewer: {
      accountSuspended: facts.viewer.suspended,
      content: false,
      teacherId: facts.viewer.teacher_id,
      emailVerified: facts.viewer.email_verified,
    },
    account: {
      suspended: facts.viewer.suspended,
      paidThrough: subscription?.paid_through ?? null,
      lastRenewalFailedAt: subscription?.failed_at ?? null,
      endedAt: subscription?.ended_at ?? null,
      refunded: subscription?.refunded ?? false,
      courtesy: facts.courtesy,
    },
    graceDays,
    lesson:
      lesson === null
        ? null
        : {
            isCurrent: lesson.is_current,
            provider: lesson.provider,
            ready: lesson.ready,
            durationSeconds: lesson.duration_seconds,
            teacherId: lesson.teacher_id,
            courseState: lesson.course_state,
            listed: lesson.listed,
            isOpen: lesson.is_open,
          },
    playbackId: row.playback_id,
  };
}

const speedRow = z.object({ value: z.unknown() });

/** `VELOCIDAD_MIN`, o nulo si falta o no es un número positivo. */
export async function readMinimumSpeed(tx: Tx): Promise<number | null> {
  const [row] = await tx.query(sql`select private.parameter_value('VELOCIDAD_MIN') as value`, speedRow);
  const value = typeof row?.value === "string" ? Number(row.value) : typeof row?.value === "number" ? row.value : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}
