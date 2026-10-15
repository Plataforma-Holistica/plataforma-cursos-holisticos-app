import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { holds, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

// La cola de revisión y aprobar un curso (RF-701; PA-61 y PA-62 mínimas, FL-45; T-108).
// Decisiones de Sergio del 2026-10-14: una sola pantalla; reproducir no pide el código
// reciente, y aprobar sí. Quién puede lo decide la base, con la puerta de Contenido
// (`private.approve_course()`); aquí se decide a quién se le pregunta qué y en qué orden, como
// en el servicio del catálogo:
//
//   · La guarda va primero: `teamStanding`, y solo sigue quien es del equipo con Contenido.
//     Los demás reciben `refused`, sin preguntarle nada más a la base. Si no se supo quién
//     pide, `unavailable`.
//   · Un curso sin forma de identificador no llega a la base (`malformed`).
//   · Nada de lo que llega dice quién actúa: sale de la sesión que pasó la guarda.
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra su lista
//     cerrada. Otra cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho.
//
// El video de cada lección no sale de aquí: lo firma la función única de medios.

/** Lo que la pantalla dice del video de una lección (un mapa cerrado de la base). */
export const LESSON_VIDEOS = ["playable", "test", "processing", "errored"] as const;
export type LessonVideo = (typeof LESSON_VIDEOS)[number];

export interface ReviewLesson {
  lessonId: string;
  module: string;
  title: string;
  durationSeconds: number;
  video: LessonVideo;
}
export interface ReviewCourse {
  courseId: string;
  title: string;
  teacherName: string;
  /** La ficha del maestro ya está listada: aprobar no la lista otra vez. */
  teacherListed: boolean;
  practice: string | null;
  level: string | null;
  lessonCount: number;
  totalDurationSeconds: number;
  /** Cuándo se cargó, en ISO. */
  loadedAt: string;
  lessons: ReviewLesson[];
}
export interface ReviewQueue {
  /** Aprobar pasaría hoy la puerta sin pedir el código otra vez. */
  freshCode: boolean;
  /** Los cursos en revisión, el más antiguo primero. */
  courses: ReviewCourse[];
}

/** Lo que contesta `private.approve_course()`. */
export const APPROVE_ANSWERS = [
  "forbidden",
  "needs_fresh_code",
  "not_found",
  "not_pending",
  "incomplete",
  "practice_inactive",
  "level_inactive",
  "videos_not_ready",
  "approved",
] as const;
export type ApproveAnswer = (typeof APPROVE_ANSWERS)[number];

/**
 * Lo que este servicio le pregunta a la base, a nombre de las claims que se le pasan. La cola
 * es nula cuando quien actúa no pasa la puerta del equipo con Contenido. Aprobar lanza si la
 * base no contestó algo de su lista: quien llama lo trata como «no se supo».
 */
export interface ReviewStore {
  queue(claims: VerifiedClaims): Promise<ReviewQueue | null>;
  approve(claims: VerifiedClaims, courseId: string): Promise<ApproveAnswer>;
}

export type QueueRead = { kind: "queue"; queue: ReviewQueue } | { kind: "unavailable" };
export type CourseApproved =
  | { kind: "refused" }
  | { kind: "unavailable" }
  | { kind: "unknown" }
  | { kind: "malformed" }
  | { kind: "answered"; answer: ApproveAnswer };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReviewCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  store: ReviewStore;
}

export function createReviewQueue(deps: { report: (code: FailureCode) => Promise<void> }, core: ReviewCore) {
  /**
   * La cola, para la sección que ya pasó su guarda, con las claims que esa guarda dio. Leer no
   * pide el código reciente. Una lectura nula (la sesión dejó de pasar entre la guarda y esta
   * lectura) o que no se pudo hacer es «no se supo»; solo la segunda se reporta.
   */
  async function reviewQueue(claims: VerifiedClaims): Promise<QueueRead> {
    try {
      const queue = await core.store.queue(claims);
      return queue === null ? { kind: "unavailable" } : { kind: "queue", queue };
    } catch {
      await deps.report("review_queue_unavailable");
      return { kind: "unavailable" };
    }
  }

  async function approveCourse(reader: CookieReader, input: { course: unknown }): Promise<CourseApproved> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { kind: "unavailable" };
    if (team.kind !== "team" || !holds(team.standing, "content")) return { kind: "refused" };
    if (typeof input.course !== "string" || !ID.test(input.course)) return { kind: "malformed" };
    try {
      return { kind: "answered", answer: await core.store.approve(team.claims, input.course) };
    } catch {
      await deps.report("course_approval_unavailable");
      return { kind: "unknown" };
    }
  }

  return { reviewQueue, approveCourse };
}
