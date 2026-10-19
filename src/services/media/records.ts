import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import type { AccountFacts } from "@/domain/access/account-access";
import { COURSE_STATES, type MediaBasis, type MediaLesson, type MediaViewer } from "@/domain/access/media-access";

// Lo que la función única de medios le pregunta a la base: la lección con su video para
// revisar, los hechos para ver, y las velocidades; y desde T-204, abrir la reproducción y su
// latido de presencia. Cada función recibe la transacción ya abierta.

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
  /** El correo de quien actúa, para la marca de agua (T-203): de la misma foto que el resto. */
  email: string | null;
  lesson: (MediaLesson & { durationSeconds: number }) | null;
  playbackId: string | null;
}

const instant = z.string().transform((value) => new Date(value));
const factsRow = z
  .object({
    now: instant,
    viewer: z
      .object({ suspended: z.boolean(), email_verified: z.boolean(), teacher_id: z.string().nullable(), email: z.string().nullable() })
      .strict(),
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
    email: facts.viewer.email,
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

const speedsRow = z.object({ minimum: z.unknown(), maximum: z.unknown() });

/** Un parámetro de velocidad guardado como número o como texto (`"0.75"`), o nulo si no es un número. */
function speed(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

/**
 * `VELOCIDAD_MIN` y `VELOCIDAD_MAX`, en una sola lectura, o nulo si falta alguna o no es un
 * número. La mínima fija la vida de la dirección (ADR-27); las dos, el menú. Que tengan
 * sentido (positivas, en orden) lo deciden las reglas del dominio, que contestan nulo si no.
 */
export async function readPlaybackSpeeds(tx: Tx): Promise<{ minimum: number; maximum: number } | null> {
  const [row] = await tx.query(
    sql`select private.parameter_value('VELOCIDAD_MIN') as minimum, private.parameter_value('VELOCIDAD_MAX') as maximum`,
    speedsRow,
  );
  const minimum = speed(row?.minimum);
  const maximum = speed(row?.maximum);
  return minimum === null || maximum === null ? null : { minimum, maximum };
}

// ---------------------------------------------------------------------------------------
// Las reproducciones (T-204; RF-107): abrir una después de firmar, y el latido de presencia.
// Las dos funciones de la base actúan a nombre de quien actúa y con la sesión de Auth que el
// servidor declara: aquí no llega de quién es la reproducción.

/** Por qué una reproducción dejó de estar viva sin que su dueño lo pidiera desde ahí. */
export const REVOKE_REASONS = ["closed_by_user", "replaced", "session_closed", "access_lost", "admin"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** Una reproducción viva de la misma cuenta en otro navegador: una fila de PA-34. */
export interface LivePlayback {
  sessionId: string;
  /** La cabecera `User-Agent` con que se abrió su sesión, o nulo si no se anotó. Solo para describirla. */
  userAgent: string | null;
  lessonTitle: string | null;
  courseTitle: string | null;
  startedAt: Date;
}

export type OpenedPlayback =
  | { kind: "opened"; sessionId: string; heartbeatSeconds: number }
  | { kind: "busy"; live: LivePlayback[] }
  /** La lección no existe, o su video ya no es el que se firmó. */
  | { kind: "not_found" }
  /** La sesión de Auth se cerró después de pasar la guarda. */
  | { kind: "session_closed" };

export type Presence =
  | { kind: "ok" }
  | { kind: "busy"; live: LivePlayback[] }
  /** `by`: la reproducción que tomó su lugar, si la hubo. */
  | { kind: "revoked"; reason: RevokeReason; by: string | null }
  /** No existe, o es de otra cuenta o de otra sesión de Auth. */
  | { kind: "not_found" };

export interface PlaybackOpening {
  lessonId: string;
  /** El playback id que se firmó: se anota ese video y no otro. */
  playbackId: string;
  basis: MediaBasis;
  countsForPayout: boolean;
  /** La reproducción que la persona eligió cerrar, o la que tomó su lugar. */
  closing: string | null;
}

const uuid = z.uuid();
const liveRow = z
  .object({
    session_id: uuid,
    user_agent: z.string().nullable(),
    lesson_title: z.string().nullable(),
    course_title: z.string().nullable(),
    started_at: instant,
  })
  .strict()
  .transform(
    (row): LivePlayback => ({
      sessionId: row.session_id,
      userAgent: row.user_agent,
      lessonTitle: row.lesson_title,
      courseTitle: row.course_title,
      startedAt: row.started_at,
    }),
  );
const busy = z.object({ outcome: z.literal("busy"), live: z.array(liveRow).min(1) }).strict();
const notFound = z.object({ outcome: z.literal("not_found") }).strict();

const openedRow = z.object({
  answer: z
    .union([
      z.object({ outcome: z.literal("opened"), session_id: uuid, heartbeat_seconds: z.number().int().positive() }).strict(),
      busy,
      notFound,
      z.object({ outcome: z.literal("session_closed") }).strict(),
    ])
    .nullable(),
});

const presenceRow = z.object({
  answer: z
    .union([
      z.object({ outcome: z.literal("ok") }).strict(),
      busy,
      z.object({ outcome: z.literal("revoked"), reason: z.enum(REVOKE_REASONS), by: uuid.nullable() }).strict(),
      notFound,
    ])
    .nullable(),
});

/**
 * Abrir una reproducción, o la lista de las vivas si no hay lugar. Nulo si la base no reconoce
 * a quien actúa o no se declaró su sesión. Lo que no tenga la forma lanza: es «no se supo».
 */
export async function openPlayback(tx: Tx, opening: PlaybackOpening): Promise<OpenedPlayback | null> {
  const [row] = await tx.query(
    sql`select private.open_playback(${opening.lessonId}::uuid, ${opening.playbackId}, ${opening.basis}::public.access_basis,
                                     ${opening.countsForPayout}, ${opening.closing}::uuid) as answer`,
    openedRow,
  );
  const answer = row?.answer ?? null;
  if (answer === null) return null;
  switch (answer.outcome) {
    case "opened":
      return { kind: "opened", sessionId: answer.session_id, heartbeatSeconds: answer.heartbeat_seconds };
    case "busy":
      return { kind: "busy", live: answer.live };
    case "not_found":
      return { kind: "not_found" };
    case "session_closed":
      return { kind: "session_closed" };
  }
}

/** El latido de presencia de una reproducción. Nulo y lanzar, como al abrir. */
export async function touchPlayback(tx: Tx, sessionId: string): Promise<Presence | null> {
  const [row] = await tx.query(sql`select private.touch_playback(${sessionId}::uuid) as answer`, presenceRow);
  const answer = row?.answer ?? null;
  if (answer === null) return null;
  switch (answer.outcome) {
    case "ok":
      return { kind: "ok" };
    case "busy":
      return { kind: "busy", live: answer.live };
    case "revoked":
      return { kind: "revoked", reason: answer.reason, by: answer.by };
    case "not_found":
      return { kind: "not_found" };
  }
}
