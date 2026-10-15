import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { PlaybackTokens, SigningKey } from "@/adapters/mux/sign";
import { resolveAccountAccess } from "@/domain/access/account-access";
import {
  grantLifetimeSeconds,
  mayReview,
  MEDIA_PURPOSES,
  playbackRates,
  resolveMediaAccess,
  watermarkText,
  type AccountRefusal,
  type MediaBasis,
  type MediaPurpose,
  type MediaViewer,
} from "@/domain/access/media-access";

import type { SessionCheck } from "@/services/account/admission";
import { holds, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

import type { LessonVideo, WatchFacts } from "./records";

// La función única de medios (RF-305, RF-306; TRD §5.5, §6.1 y §9.4): la única que firma una
// dirección de video. Pregunta quién pide, lee la lección y los hechos, le pregunta a las
// reglas del dominio y, si le toca, firma. Dos caminos, según desde dónde se pide:
//
//   · `review`, la pantalla de revisión (T-108): la guarda del equipo, y la lección leída como
//     la persona. A quien no tiene Contenido se le contesta antes de leer nada.
//   · `watch`, el área del alumno (T-202; la pantalla llega con T-203): la guarda de sesión,
//     y los hechos de la cuenta y de la lección leídos como servidor, en una transacción. La
//     cuenta la decide `resolveAccountAccess` (RN-01), con la hora de la base, y la lección
//     `resolveMediaAccess` (RF-306).
//
// Para ver hay además una decisión sin firma, `lessonAccess`: la página de la lección le
// pregunta al cargar, para pintar PA-33 sin pedir un video (T-203; 04 §6.2 paso 7). Comparte
// con `watch` todo hasta antes de firmar, así que contesta lo mismo.
//
// Nada de lo que llega dice qué video: llega una lección, y el playback id sale de la base.
// Lo que todavía no se hace: anotar la reproducción (`playback_sessions`) y el límite de
// reproducciones (T-204), y los recursos (RF-308), que firman con esta misma regla en T-404.

/** Una dirección firmada, con lo que el reproductor necesita para usarla. */
interface Signed {
  kind: "granted";
  playbackId: string;
  tokens: PlaybackTokens;
  /** Segundos desde la época. */
  expiresAt: number;
  /** El menú de velocidades, de `VELOCIDAD_MIN` a `VELOCIDAD_MAX` (RF-312). */
  speeds: number[];
}

/** Lo que una decisión puede contestar en lugar de firmar. */
type Refusal =
  /** Quien pide no puede revisar, o no tiene una sesión que pase. No se le dice si existe. */
  | { kind: "refused" }
  /** No hay video que firmar, o quien pide no puede ver ese curso: las dos se ven igual. */
  | { kind: "no_video" }
  /** La cuenta está suspendida (PA-35). */
  | { kind: "suspended" }
  /** La cuenta no tiene acceso: lo que dice PA-33, con su fecha si terminó. */
  | { kind: "denied"; account: AccountRefusal }
  /** No se supo, o falta configuración (la llave, las velocidades, la marca): se reporta. */
  | { kind: "unavailable" };

export type MediaGrant =
  | (Signed & {
      /** El correo de la cuenta, que el reproductor pinta encima del video (RF-305). */
      watermark: string;
      basis: MediaBasis;
      /** Si este consumo genera puntos (RN-08). Lo usan T-204 y T-205. */
      countsForPayout: boolean;
      /**
       * El fin de la base de la cuenta. La dirección vive hasta `expiresAt`, pero desde aquí ya
       * no cuenta (decisión de Sergio del 2026-10-15). Nulo si no depende de la cuenta.
       */
      until: Date | null;
    })
  | Refusal;

/** Lo que contesta revisar: nunca habla de la cuenta, y nunca cuenta (sin base ni marca). */
export type ReviewGrant = Signed | Extract<Refusal, { kind: "refused" | "no_video" | "unavailable" }>;

/** Lo que contesta decidir al cargar: lo mismo que ver, sin firmar nada. */
export type LessonAccess = { kind: "allowed" } | Refusal;

export interface MediaStore {
  lessonVideo(claims: VerifiedClaims, lessonId: string): Promise<LessonVideo | null>;
  watchFacts(claims: VerifiedClaims, lessonId: string): Promise<WatchFacts | null>;
  playbackSpeeds(claims: VerifiedClaims): Promise<{ minimum: number; maximum: number } | null>;
}

export interface MediaCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  store: MediaStore;
  /** La llave de firma, o nulo si no está configurada. */
  signingKey: () => SigningKey | null;
  sign: (input: { playbackId: string; expiresAt: number; key: SigningKey }) => PlaybackTokens | null;
  /** Segundos desde la época. */
  now: () => number;
}

/** Lo que `decideWatch` deja listo para firmar. Nunca sale del servicio. */
interface Decided {
  kind: "decided";
  claims: VerifiedClaims;
  email: string | null;
  video: { playbackId: string; durationSeconds: number };
  access: { basis: MediaBasis; countsForPayout: boolean; until: Date | null };
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createMediaGrant(deps: { report: (code: FailureCode) => Promise<void> }, core: MediaCore) {
  /** Firma lo que una regla ya dejó pasar. */
  async function signFor(
    claims: VerifiedClaims,
    video: { playbackId: string; durationSeconds: number },
  ): Promise<Signed | { kind: "unavailable" }> {
    const key = core.signingKey();
    let speeds: { minimum: number; maximum: number } | null = null;
    try {
      speeds = key === null ? null : await core.store.playbackSpeeds(claims);
    } catch {
      speeds = null;
    }
    const life = speeds === null ? null : grantLifetimeSeconds(video.durationSeconds, speeds.minimum);
    const rates = speeds === null ? null : playbackRates(speeds.minimum, speeds.maximum);
    if (key === null || life === null || rates === null) {
      await deps.report("media_grant_unavailable");
      return { kind: "unavailable" };
    }
    const expiresAt = core.now() + life;
    const tokens = core.sign({ playbackId: video.playbackId, expiresAt, key });
    if (tokens === null) {
      await deps.report("media_grant_unavailable");
      return { kind: "unavailable" };
    }
    return { kind: "granted", playbackId: video.playbackId, tokens, expiresAt, speeds: rates };
  }

  async function review(reader: CookieReader, lessonId: unknown): Promise<ReviewGrant> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { kind: "unavailable" };
    const content = team.kind === "team" && holds(team.standing, "content");
    const viewer: MediaViewer = { accountSuspended: false, content, teacherId: null, emailVerified: false };
    // A quien no puede, antes de leer nada: no se le dice si la lección existe.
    if (team.kind !== "team" || !mayReview(viewer)) return { kind: "refused" };
    if (typeof lessonId !== "string" || !ID.test(lessonId)) return { kind: "no_video" };

    let lesson: LessonVideo | null;
    try {
      lesson = await core.store.lessonVideo(team.claims, lessonId);
    } catch {
      await deps.report("media_grant_unavailable");
      return { kind: "unavailable" };
    }
    // Quien llega aquí ya pasó `mayReview`: lo único que puede faltar es el video.
    const access = resolveMediaAccess("review", viewer, null, lesson);
    if (!access.ok || lesson === null || lesson.playbackId === null) return { kind: "no_video" };
    return signFor(team.claims, { playbackId: lesson.playbackId, durationSeconds: lesson.durationSeconds });
  }

  /**
   * La decisión de ver, sin firmar: la guarda de sesión, los hechos y las dos reglas. La
   * comparten `watch` y `lessonAccess`, para que lo que se dice al cargar sea lo que se
   * contestaría al pedir el video.
   */
  async function decideWatch(reader: CookieReader, lessonId: unknown): Promise<Refusal | Decided> {
    const session = await core.checkSession(reader);
    // La guarda ya reportó lo suyo. A quien no tiene una sesión que pase no se le dice nada
    // más: su pantalla corre la misma guarda y lo manda a donde toca.
    if (session.kind === "unavailable") return { kind: "unavailable" };
    if (session.kind === "suspended") return { kind: "suspended" };
    if (session.kind !== "pass") return { kind: "refused" };
    if (typeof lessonId !== "string" || !ID.test(lessonId)) return { kind: "no_video" };

    let facts: WatchFacts | null;
    try {
      facts = await core.store.watchFacts(session.claims, lessonId);
    } catch {
      facts = null;
    }
    if (facts === null) {
      await deps.report("media_facts_unavailable");
      return { kind: "unavailable" };
    }
    // Toda cuenta completa verificó su correo al abrir el enlace del registro: si no, algo
    // cambió por fuera, y alguien lo tiene que saber. La regla sigue con lo que hay.
    if (!facts.viewer.emailVerified) await deps.report("media_email_unverified");

    const account = resolveAccountAccess(facts.account, facts.now, { graceDays: facts.graceDays });
    const access = resolveMediaAccess("watch", facts.viewer, account, facts.lesson);
    if (!access.ok) {
      switch (access.reason) {
        case "no_video":
          return { kind: "no_video" };
        case "suspended":
          return { kind: "suspended" };
        case "no_access":
          return { kind: "denied", account: access.account };
        case "unknown":
        case "refused":
          await deps.report("media_facts_unavailable");
          return { kind: "unavailable" };
      }
    }
    // La regla dio acceso y la segunda barrera de la base no soltó el video: no deberían
    // contradecirse, y si lo hacen, manda la más estricta y alguien lo tiene que saber.
    if (facts.lesson === null || facts.playbackId === null) {
      await deps.report("media_facts_unavailable");
      return { kind: "unavailable" };
    }
    return {
      kind: "decided",
      claims: session.claims,
      email: facts.email,
      video: { playbackId: facts.playbackId, durationSeconds: facts.lesson.durationSeconds },
      access,
    };
  }

  async function watch(reader: CookieReader, lessonId: unknown): Promise<MediaGrant> {
    const decided = await decideWatch(reader, lessonId);
    if (decided.kind !== "decided") return decided;
    // Sin marca no hay video. Se mira solo aquí, con el acceso ya dado: a quien no lo tiene se
    // le dice PA-33, no «no se pudo».
    const watermark = watermarkText(decided.email);
    if (watermark === null) {
      await deps.report("media_watermark_unavailable");
      return { kind: "unavailable" };
    }
    const signed = await signFor(decided.claims, decided.video);
    if (signed.kind !== "granted") return signed;
    const { basis, countsForPayout, until } = decided.access;
    return { ...signed, watermark, basis, countsForPayout, until };
  }

  /**
   * Si quien trae la sesión puede ver la lección, sin firmar nada: lo que la página de la
   * lección pregunta al cargar. Nunca devuelve el playback id ni la base de acceso.
   */
  async function lessonAccess(reader: CookieReader, lessonId: unknown): Promise<LessonAccess> {
    const decided = await decideWatch(reader, lessonId);
    return decided.kind === "decided" ? { kind: "allowed" } : decided;
  }

  function getMediaGrant(reader: CookieReader, lessonId: unknown, purpose: "review"): Promise<ReviewGrant>;
  function getMediaGrant(reader: CookieReader, lessonId: unknown, purpose: "watch"): Promise<MediaGrant>;
  async function getMediaGrant(reader: CookieReader, lessonId: unknown, purpose: MediaPurpose): Promise<MediaGrant | ReviewGrant> {
    // Lo arma quien llama, como un literal; algo que no sea uno de los dos no pasa.
    if (!(MEDIA_PURPOSES as readonly unknown[]).includes(purpose)) return { kind: "refused" };
    return purpose === "review" ? review(reader, lessonId) : watch(reader, lessonId);
  }

  return { getMediaGrant, lessonAccess };
}
