import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { PlaybackTokens, SigningKey } from "@/adapters/mux/sign";
import { grantLifetimeSeconds, mayRequestMedia, resolveMediaAccess, type MediaViewer } from "@/domain/access/media-access";

import { holds, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

import type { LessonVideo } from "./records";

// La función única de medios (RF-305, RF-306; TRD §5.5 y §9.4): la única que firma una
// dirección de video. Pregunta quién pide (la guarda del equipo), lee la lección como esa
// persona, le pregunta a la regla del dominio y, si le toca, firma. Hoy solo la regla de
// revisar (T-108); T-202 suma las otras tres y la búsqueda de firmas en el código.
//
// Nada de lo que llega dice qué video: llega una lección, y el playback id sale de la base.

export type MediaGrant =
  | {
      kind: "granted";
      playbackId: string;
      tokens: PlaybackTokens;
      /** Segundos desde la época. */
      expiresAt: number;
    }
  /** Quien pide no puede ver esa lección. No se le dice si existe. */
  | { kind: "refused" }
  /** No hay video que firmar: no existe, se retiró, es de prueba o no está listo. */
  | { kind: "no_video" }
  /** No se supo, o falta configuración (la llave, la velocidad mínima): se reporta. */
  | { kind: "unavailable" };

export interface MediaStore {
  lessonVideo(claims: VerifiedClaims, lessonId: string): Promise<LessonVideo | null>;
  minimumSpeed(claims: VerifiedClaims): Promise<number | null>;
}

export interface MediaCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  store: MediaStore;
  /** La llave de firma, o nulo si no está configurada. */
  signingKey: () => SigningKey | null;
  sign: (input: { playbackId: string; expiresAt: number; key: SigningKey }) => PlaybackTokens | null;
  /** Segundos desde la época. */
  now: () => number;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createMediaGrant(deps: { report: (code: FailureCode) => Promise<void> }, core: MediaCore) {
  async function getMediaGrant(reader: CookieReader, lessonId: unknown): Promise<MediaGrant> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { kind: "unavailable" };
    const viewer: MediaViewer = team.kind === "team" ? { kind: "team", content: holds(team.standing, "content") } : { kind: "other" };
    // A quien no puede, antes de leer nada: no se le dice si la lección existe.
    if (team.kind !== "team" || !mayRequestMedia(viewer)) return { kind: "refused" };
    if (typeof lessonId !== "string" || !ID.test(lessonId)) return { kind: "no_video" };

    let lesson: LessonVideo | null;
    try {
      lesson = await core.store.lessonVideo(team.claims, lessonId);
    } catch {
      await deps.report("media_grant_unavailable");
      return { kind: "unavailable" };
    }
    // Quien llega aquí ya pasó `mayRequestMedia`: lo único que puede faltar es el video.
    const access = resolveMediaAccess(viewer, lesson);
    if (!access.ok) return { kind: "no_video" };
    if (lesson === null || lesson.playbackId === null) return { kind: "no_video" };

    const key = core.signingKey();
    let speed: number | null = null;
    try {
      speed = key === null ? null : await core.store.minimumSpeed(team.claims);
    } catch {
      speed = null;
    }
    const life = speed === null ? null : grantLifetimeSeconds(lesson.durationSeconds, speed);
    if (key === null || life === null) {
      await deps.report("media_grant_unavailable");
      return { kind: "unavailable" };
    }
    const expiresAt = core.now() + life;
    const tokens = core.sign({ playbackId: lesson.playbackId, expiresAt, key });
    if (tokens === null) {
      await deps.report("media_grant_unavailable");
      return { kind: "unavailable" };
    }
    return { kind: "granted", playbackId: lesson.playbackId, tokens, expiresAt };
  }

  return { getMediaGrant };
}
