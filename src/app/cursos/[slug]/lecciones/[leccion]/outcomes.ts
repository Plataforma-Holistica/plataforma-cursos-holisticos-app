import { longDate } from "@/app/_lib/dates";
import type { LessonAccess, LiveElsewhere, MediaGrant, PresenceAnswer } from "@/services/media/media";

// La tabla de la página de una lección (PA-22, T-203): lo que contesta la función única de
// medios, al cargar (`lessonAccess`) y al reproducir (`getMediaGrant`), traducido a lo que se
// pinta en el lugar del reproductor. Es pura. Un caso nuevo se agrega aquí, con su prueba.
//
// La base de acceso (`basis`), si cuenta para el reparto y hasta cuándo (`until`) no salen de
// aquí: son del servidor, no del navegador. Desde T-204 salen la reproducción abierta y cada
// cuánto latir, el lugar ocupado en otro navegador (PA-34) y lo que contesta el latido.

type AccountRefusal = Extract<MediaGrant, { kind: "denied" }>["account"];

/** El motivo de PA-33, con la fecha ya en palabras, en la zona del producto. */
export type Denial = { reason: "never_subscribed" } | { reason: "expired" | "grace_ended" | "refunded"; date: string };

/**
 * El motivo de PA-33, o nulo si es una cuenta suspendida: viene en el tipo del rechazo, pero
 * es PA-35, y la regla nunca la contesta así (la suspensión va antes).
 */
export function denialOf(account: AccountRefusal): Denial | null {
  switch (account.reason) {
    case "never_subscribed":
      return { reason: "never_subscribed" };
    case "suspended":
      return null;
    default:
      return { reason: account.reason, date: longDate(account.endedAt.toISOString()) };
  }
}

/** Lo que la página pinta al cargar, en el lugar del reproductor. */
export type InitialState =
  | { kind: "ready" }
  | { kind: "denied"; denial: Denial }
  | { kind: "no_video" }
  | { kind: "unavailable" }
  /** PA-35, en toda la página. */
  | { kind: "suspended" }
  /** La sesión dejó de pasar: a la misma ruta, donde decide la guarda. */
  | { kind: "reload" };

export function initialOf(access: LessonAccess): InitialState {
  switch (access.kind) {
    case "allowed":
      return { kind: "ready" };
    case "denied": {
      const denial = denialOf(access.account);
      return denial === null ? { kind: "suspended" } : { kind: "denied", denial };
    }
    case "no_video":
    case "unavailable":
    case "suspended":
      return { kind: access.kind };
    case "refused":
      return { kind: "reload" };
  }
}

/** Una reproducción viva en otro navegador de la cuenta (PA-34). La pantalla la pone en palabras. */
export interface BusyRow {
  /** Con él se pide cerrarla. */
  sessionId: string;
  browser: LiveElsewhere["device"]["browser"];
  system: LiveElsewhere["device"]["system"];
  lesson: string | null;
  course: string | null;
  /** Desde cuándo, en ISO 8601. */
  since: string;
}

const busyRows = (live: LiveElsewhere[]): BusyRow[] =>
  live.map((each) => ({
    sessionId: each.sessionId,
    browser: each.device.browser,
    system: each.device.system,
    lesson: each.lessonTitle,
    course: each.courseTitle,
    since: each.startedAt.toISOString(),
  }));

/** Lo que el reproductor recibe al pedir el video. Los nombres de los tokens son los de Mux Player. */
export type WatchAnswer =
  | {
      kind: "granted";
      playbackId: string;
      tokens: { playback: string; thumbnail: string; storyboard: string };
      speeds: number[];
      watermark: string;
      /** La reproducción abierta: con ella late (T-204). */
      playbackSessionId: string;
      heartbeatSeconds: number;
    }
  /** El lugar de la cuenta está ocupado en otro navegador (PA-34). */
  | { kind: "busy"; live: BusyRow[] }
  | { kind: "denied"; denial: Denial }
  | { kind: "no_video" }
  | { kind: "unavailable" };

/** Lo que contestó `getMediaGrant`, para el reproductor; o volver a la página, si la sesión ya no pasa. */
export function watchAnswerOf(grant: MediaGrant): WatchAnswer | { kind: "reload" } {
  switch (grant.kind) {
    case "granted":
      return {
        kind: "granted",
        playbackId: grant.playbackId,
        // `getMediaGrant` llama `video` al token del video; Mux Player lo llama `playback`.
        tokens: { playback: grant.tokens.video, thumbnail: grant.tokens.thumbnail, storyboard: grant.tokens.storyboard },
        speeds: grant.speeds,
        watermark: grant.watermark,
        playbackSessionId: grant.playbackSessionId,
        heartbeatSeconds: grant.heartbeatSeconds,
      };
    case "busy":
      return { kind: "busy", live: busyRows(grant.live) };
    case "denied": {
      const denial = denialOf(grant.account);
      return denial === null ? { kind: "reload" } : { kind: "denied", denial };
    }
    case "no_video":
    case "unavailable":
      return { kind: grant.kind };
    case "suspended":
    case "refused":
      return { kind: "reload" };
  }
}

/** Lo que el reproductor recibe de su latido de presencia (T-204). */
export type PresenceReply =
  | { kind: "ok" }
  /** Había vencido (una pausa larga) y otro navegador tomó el lugar: PA-34. */
  | { kind: "busy"; live: BusyRow[] }
  /**
   * Se cerró desde otro dispositivo (PA-34 de allá) o se abrió en otra pestaña de este navegador.
   * `by`: la que tomó su lugar, para tomarlo de vuelta con «Reproducir aquí».
   */
  | { kind: "closed"; from: "device" | "tab"; by: string | null }
  /** No se supo: el video sigue, y el siguiente latido lo vuelve a intentar. */
  | { kind: "unavailable" };

/**
 * Lo que contestó el latido, para el reproductor; o volver a la página, donde decide la guarda:
 * una cuenta suspendida, una sesión que ya no pasa o que se cerró, o un motivo que solo
 * escribe el equipo.
 */
export function presenceReplyOf(answer: PresenceAnswer): PresenceReply | { kind: "reload" } {
  switch (answer.kind) {
    case "ok":
    case "unavailable":
      return { kind: answer.kind };
    case "busy":
      return { kind: "busy", live: busyRows(answer.live) };
    case "revoked":
      return closedOf(answer);
    case "suspended":
    case "refused":
      return { kind: "reload" };
  }
}

function closedOf(answer: Extract<PresenceAnswer, { kind: "revoked" }>): PresenceReply | { kind: "reload" } {
  switch (answer.reason) {
    case "closed_by_user":
      return { kind: "closed", from: "device", by: answer.by };
    case "replaced":
      return { kind: "closed", from: "tab", by: answer.by };
    case "session_closed":
    case "access_lost":
    case "admin":
      return { kind: "reload" };
  }
}
