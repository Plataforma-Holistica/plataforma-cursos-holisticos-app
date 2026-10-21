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

import { describeUserAgent, type Device } from "@/domain/access/user-agent";
import { accessCounts, parseHeartbeatBatch, type AccessCount, type HeartbeatEvent } from "@/domain/consumption/heartbeat";
import { resumeAt } from "@/domain/progress/progress";

import type { SessionCheck } from "@/services/account/admission";
import { holds, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

import type {
  BatchRecord,
  HeartbeatBeat,
  HeartbeatOutcome,
  LessonVideo,
  LivePlayback,
  OpenedPlayback,
  PlaybackOpening,
  RevokeReason,
  WatchFacts,
} from "./records";

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
//
// Desde T-204, ver abre además una reproducción (RF-107), después de firmar: la firma es local
// y sin efectos, y si falla no queda una reproducción ocupando lugar. Con el lugar ocupado por
// otro navegador de la misma cuenta contesta `busy` con la lista (PA-34), y se le puede pedir
// cerrar una en el mismo paso. `playbackHeartbeat` es el latido de presencia, con la misma
// guarda de sesión. Revisar no abre reproducción (decisión de Sergio del 2026-10-19). Lo que
// todavía no se hace: los recursos (RF-308), que firman con esta misma regla en T-404.
//
// Desde T-205 el latido lleva los tramos vistos (RF-401), y `flushHeartbeats` los manda sin
// presencia (al pausar, al irse el reproductor, al volver a abrir una lección). Si lo visto
// cuenta lo decide aquí la regla de los medios con los hechos a la hora del tope del reloj de
// la reproducción, que la base da: lo atrasado se mide en su hora, no en la de llegada. La
// base revisa cada tramo contra la lección y el reloj, y solo puede bajar lo que cuenta.
//
// Desde T-206 la base funde además lo visto en el progreso, en la misma transacción, y lo que
// contesta del lote trae el estado de la lección: la pantalla marca «Terminada» al momento. Ver
// dice además desde qué segundo arrancar (`startSeconds`), leído al abrir la reproducción.

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

/** Una reproducción viva de la misma cuenta en otro navegador, como la pinta PA-34. */
export interface LiveElsewhere {
  sessionId: string;
  /** El navegador y el sistema de la sesión que la abrió; lo que no se reconoce, nulo. */
  device: Device;
  lessonTitle: string | null;
  courseTitle: string | null;
  startedAt: Date;
}

/** El lugar de la cuenta está ocupado en otro navegador (RF-107, PA-34). */
type Busy = { kind: "busy"; live: LiveElsewhere[] };

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
      /** La reproducción abierta (T-204): con ella late el reproductor. */
      playbackSessionId: string;
      /** Cada cuánto latir (`LATIDO_SEGUNDOS`). */
      heartbeatSeconds: number;
      /** La duración de la lección, la que revisa la base en cada tramo: el navegador recorta a ella (T-205). */
      durationSeconds: number;
      /** El segundo donde arranca: donde se quedó, o 0 si no hay, es de otro video o le faltaba poco (T-206). */
      startSeconds: number;
    })
  | Busy
  | Refusal;

/** Lo que contesta el latido de presencia. */
export type PresenceAnswer =
  | { kind: "ok" }
  /** Había vencido (una pausa larga) y otro navegador tomó el lugar. */
  | Busy
  /** `by`: la reproducción que tomó su lugar, si la hubo. */
  | { kind: "revoked"; reason: RevokeReason; by: string | null }
  | { kind: "suspended" }
  /** La sesión no pasa, o la reproducción no es de esta sesión: la pantalla vuelve a la página. */
  | { kind: "refused" }
  /** No se supo: el video sigue, y el siguiente latido lo vuelve a intentar. */
  | { kind: "unavailable" };

/** El estado de una lección después de un lote (T-206): con él la pantalla marca su fila al momento. */
export interface LessonProgressNote {
  lessonId: string;
  coveredSeconds: number;
  completed: boolean;
  /** Si este lote la terminó. */
  justCompleted: boolean;
}

/** Qué pasó con un lote de tramos (T-205), para la cola del navegador. */
export type BatchAnswer =
  /**
   * Los consecutivos que salen de la cola: aceptados, repetidos y rechazados. Ninguno se reenvía.
   * `progress`, el estado de la lección, o nulo si no deja progreso o no se pudo fundir.
   */
  | { kind: "settled"; seqs: number[]; progress: LessonProgressNote | null }
  /** La reproducción no existe o no es de quien la manda, o el lote no tiene forma: lo enviado se tira. */
  | { kind: "discard" }
  /** No se supo: todo se queda en la cola y se manda otra vez. */
  | { kind: "retry" };

/** Lo que contesta un latido: la presencia y, si llevaba tramos, qué pasó con ellos. */
export interface HeartbeatAnswer {
  presence: PresenceAnswer;
  batch: BatchAnswer | null;
}

/** Lo que puede acompañar a ver. */
export interface WatchOptions {
  /** La reproducción que se pide cerrar en el mismo paso (PA-34, o «Reproducir aquí»). */
  closing?: unknown;
}

/** Lo que contesta revisar: nunca habla de la cuenta, y nunca cuenta (sin base ni marca). */
export type ReviewGrant = Signed | Extract<Refusal, { kind: "refused" | "no_video" | "unavailable" }>;

/** Lo que contesta decidir al cargar: lo mismo que ver, sin firmar nada. */
export type LessonAccess = { kind: "allowed" } | Refusal;

export interface MediaStore {
  lessonVideo(claims: VerifiedClaims, lessonId: string): Promise<LessonVideo | null>;
  watchFacts(claims: VerifiedClaims, lessonId: string): Promise<WatchFacts | null>;
  playbackSpeeds(claims: VerifiedClaims): Promise<{ minimum: number; maximum: number } | null>;
  openPlayback(claims: VerifiedClaims, opening: PlaybackOpening): Promise<OpenedPlayback | null>;
  heartbeat(claims: VerifiedClaims, beat: HeartbeatBeat): Promise<HeartbeatOutcome | null>;
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
  lessonId: string;
  email: string | null;
  video: { playbackId: string; durationSeconds: number };
  access: { basis: MediaBasis; countsForPayout: boolean; until: Date | null };
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const idOrNull = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);

/**
 * Si lo visto cuenta, con los hechos de la cuenta a la hora del tope del reloj: la misma regla
 * que decide al ver (RN-01, RF-306). El fin del acceso o una lección retirada lo guardan sin
 * puntos (decisiones de Sergio del 2026-10-15 y del 2026-10-19).
 */
const decideBeat = (facts: WatchFacts, at: Date): AccessCount =>
  accessCounts(resolveMediaAccess("watch", facts.viewer, resolveAccountAccess(facts.account, at, { graceDays: facts.graceDays }), facts.lesson));

/** El lote como lo pide la base: lo que no tiene forma, nulo; sin lote, vacío. */
const batchOf = (events: unknown): HeartbeatEvent[] | null => (events === undefined ? [] : parseHeartbeatBatch(events));

/** Lo que se contesta del lote cuando no se llegó a mandar. */
const unsent = (batch: HeartbeatEvent[] | null, reason: "retry" | "discard"): BatchAnswer | null =>
  batch === null ? { kind: "discard" } : batch.length === 0 ? null : { kind: reason };

/** La lista de la base, con el navegador ya descrito: la cabecera no sale del servidor. */
const describeLive = (live: LivePlayback[]): LiveElsewhere[] =>
  live.map(({ userAgent, ...rest }) => ({ ...rest, device: describeUserAgent(userAgent) }));

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
      lessonId,
      email: facts.email,
      video: { playbackId: facts.playbackId, durationSeconds: facts.lesson.durationSeconds },
      access,
    };
  }

  async function watch(reader: CookieReader, lessonId: unknown, options: WatchOptions): Promise<MediaGrant> {
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
    // `review` solo sale de revisar (`resolveMediaAccess`), que no abre reproducción.
    let opened: OpenedPlayback | null;
    try {
      opened = await core.store.openPlayback(decided.claims, {
        lessonId: decided.lessonId,
        playbackId: signed.playbackId,
        basis,
        countsForPayout,
        closing: idOrNull(options.closing),
      });
    } catch {
      opened = null;
    }
    // No se supo, la base no reconoce la sesión que pasó la guarda, o la lección cambió de video
    // entre decidir y abrir: no se da una dirección que no quedó anotada.
    if (opened === null || opened.kind === "not_found") {
      await deps.report("playback_unavailable");
      return { kind: "unavailable" };
    }
    if (opened.kind === "busy") return { kind: "busy", live: describeLive(opened.live) };
    // Se cerró la sesión mientras se abría: la pantalla vuelve a la página, donde decide la guarda.
    if (opened.kind === "session_closed") return { kind: "refused" };
    return {
      ...signed,
      watermark,
      basis,
      countsForPayout,
      until,
      playbackSessionId: opened.sessionId,
      heartbeatSeconds: opened.heartbeatSeconds,
      durationSeconds: decided.video.durationSeconds,
      startSeconds: resumeAt(opened.position, decided.video.durationSeconds),
    };
  }

  /** Lo que la base contestó del lote, para la cola. «No se supo» se reporta. */
  async function settle(batch: BatchRecord | null): Promise<BatchAnswer | null> {
    if (batch === null) return null;
    switch (batch.kind) {
      case "recorded": {
        const seqs = [...new Set([...batch.accepted, ...batch.duplicate, ...batch.rejected.map((each) => each.seq)])].sort((a, b) => a - b);
        const saved = batch.progress;
        // El lote quedó en el libro: el progreso se rehace desde ahí. Alguien lo tiene que saber.
        if (saved?.kind === "failed") await deps.report("progress_unavailable");
        const progress =
          saved?.kind === "tracked"
            ? { lessonId: saved.lessonId, coveredSeconds: saved.coveredSeconds, completed: saved.completed, justCompleted: saved.justCompleted }
            : null;
        return { kind: "settled", seqs, progress };
      }
      case "not_found":
        return { kind: "discard" };
      case "unknown":
      case "failed":
        await deps.report("heartbeat_unavailable");
        return { kind: "retry" };
    }
  }

  /**
   * El latido de una reproducción (T-204), mientras el video avanza, con los tramos vistos que
   * tenga pendientes (T-205). Con la guarda de sesión: una cuenta suspendida se detiene
   * (PA-35); a una que le falta algo se le deja acabar (decisión de Sergio del 2026-10-19). El
   * fin del acceso no detiene el video: lo que se ve desde ahí se guarda sin puntos (decisión de
   * T-202). Si la presencia contesta que otro tomó el lugar, los tramos se registran igual: son
   * de antes.
   */
  async function playbackHeartbeat(reader: CookieReader, sessionId: unknown, events?: unknown): Promise<HeartbeatAnswer> {
    const session = await core.checkSession(reader);
    const batch = batchOf(events);
    // La guarda ya reportó lo suyo.
    if (session.kind === "unavailable") return { presence: { kind: "unavailable" }, batch: unsent(batch, "retry") };
    if (session.kind === "suspended") return { presence: { kind: "suspended" }, batch: unsent(batch, "retry") };
    if (session.kind !== "pass" && session.kind !== "incomplete") return { presence: { kind: "refused" }, batch: unsent(batch, "retry") };
    const id = idOrNull(sessionId);
    if (id === null) return { presence: { kind: "refused" }, batch: unsent(batch, "discard") };

    const beat = async (events: HeartbeatEvent[]): Promise<HeartbeatOutcome | null> => {
      try {
        return await core.store.heartbeat(session.claims, { sessionId: id, presence: true, events, decide: decideBeat });
      } catch {
        return null;
      }
    };
    let outcome = await beat(batch ?? []);
    // El lote tumbó la transacción con un error de la base que el registro no ataja (una consulta
    // cancelada, los hechos que no se leyeron): la presencia, sola, en otra. Así nada del
    // registro deja vencer la reproducción.
    const alone = (outcome === null || outcome.presence === null) && batch !== null && batch.length > 0;
    if (alone) outcome = await beat([]);
    if (outcome === null || outcome.presence === null) {
      await deps.report("playback_unavailable");
      return { presence: { kind: "unavailable" }, batch: unsent(batch, "retry") };
    }
    const presence = outcome.presence;
    let answer: BatchAnswer | null;
    if (batch === null) answer = { kind: "discard" };
    else if (alone) {
      await deps.report("heartbeat_unavailable");
      answer = { kind: "retry" };
    } else answer = await settle(outcome.batch);
    switch (presence.kind) {
      case "ok":
        return { presence: { kind: "ok" }, batch: answer };
      case "busy":
        return { presence: { kind: "busy", live: describeLive(presence.live) }, batch: answer };
      case "revoked":
        return { presence, batch: answer };
      case "not_found":
        return { presence: { kind: "refused" }, batch: answer };
    }
  }

  /**
   * Los tramos pendientes de una reproducción, sin presencia: no toma ni refresca el lugar. Lo
   * manda el navegador al pausar, al terminar, al ocultar la pestaña o al irse el reproductor, y
   * lo que quedó guardado de otra visita al volver a abrir una lección. Con la misma guarda que
   * el latido; lo atrasado de una reproducción de otra sesión de la cuenta entra si ya terminó.
   */
  async function flushHeartbeats(reader: CookieReader, sessionId: unknown, events: unknown): Promise<BatchAnswer> {
    const session = await core.checkSession(reader);
    const batch = parseHeartbeatBatch(events);
    if (batch === null) return { kind: "discard" };
    // La guarda ya reportó lo suyo. Sin una sesión que pase, se queda en la cola: al volver a
    // entrar se manda desde la sesión nueva.
    if (session.kind !== "pass" && session.kind !== "incomplete") return { kind: "retry" };
    const id = idOrNull(sessionId);
    if (id === null) return { kind: "discard" };
    if (batch.length === 0) return { kind: "settled", seqs: [], progress: null };

    let outcome: HeartbeatOutcome | null;
    try {
      outcome = await core.store.heartbeat(session.claims, { sessionId: id, presence: false, events: batch, decide: decideBeat });
    } catch {
      outcome = null;
    }
    if (outcome === null) {
      await deps.report("heartbeat_unavailable");
      return { kind: "retry" };
    }
    return (await settle(outcome.batch)) ?? { kind: "settled", seqs: [], progress: null };
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
  function getMediaGrant(reader: CookieReader, lessonId: unknown, purpose: "watch", options?: WatchOptions): Promise<MediaGrant>;
  async function getMediaGrant(
    reader: CookieReader,
    lessonId: unknown,
    purpose: MediaPurpose,
    options: WatchOptions = {},
  ): Promise<MediaGrant | ReviewGrant> {
    // Lo arma quien llama, como un literal; algo que no sea uno de los dos no pasa.
    if (!(MEDIA_PURPOSES as readonly unknown[]).includes(purpose)) return { kind: "refused" };
    return purpose === "review" ? review(reader, lessonId) : watch(reader, lessonId, options);
  }

  return { getMediaGrant, lessonAccess, playbackHeartbeat, flushHeartbeats };
}
