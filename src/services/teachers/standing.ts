import "server-only";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { RequestOrigin } from "@/services/account/origin";
import type { ConsentEvidence } from "@/services/account/records";
import type { FailureCode } from "@/services/error-reporting/server";

// En qué estado está quien pide el portal del maestro, y aceptar su invitación o el aviso vuelto a pedir
// (T-402 y T-401; flujo de la app §6.2, FL-30). Quién es maestro y quién puede aceptar lo dice la base: aquí
// solo se decide a quién se le pregunta y en qué orden. La guarda de sesión va primero, y lo que no sea
// «pasa» se contesta tal cual. «No se supo» nunca es «no es maestro».

/**
 * El estado de quien actúa, como lo dice `private.teacher_standing()`. Un maestro que se fue cuenta como
 * `none`. De una invitación no sale su maestro: solo su nombre, para el saludo de PA-40. De una suspensión
 * sale solo el texto escrito para el maestro, nunca el motivo interno.
 */
export type TeacherStanding =
  | { state: "none" }
  | { state: "invited" | "invited_unproven"; name: string | null }
  | { state: "active" | "needs_notice"; teacher: { id: string } }
  | { state: "suspended"; teacher: { id: string }; notice: string | null };

/** Lo que la guarda de sesión contesta cuando no deja pasar. */
type Refused = Exclude<SessionCheck, { kind: "pass" }>;

export type TeacherCheck = Refused | { kind: "teacher"; claims: VerifiedClaims; standing: TeacherStanding };

/** Un texto del maestro, completo: no son públicos, y PA-40 los muestra ahí mismo. */
export interface TeacherText {
  documentId: string;
  version: number;
  title: string;
  body: string;
  effectiveFrom: string;
}

/** Los dos textos vigentes del maestro. Nulo el que no tiene texto vigente. */
export interface TeacherTexts {
  agreement: TeacherText | null;
  notice: TeacherText | null;
}

/** Lo que contesta `private.accept_teacher_invitation()`. */
export const ACCEPT_ANSWERS = [
  "accepted",
  "ineligible",
  "no_invitation",
  "already_teacher",
  "needs_mailbox_proof",
  "inviter_lost_content",
  "unavailable",
  "changed",
] as const;
export type AcceptAnswer = (typeof ACCEPT_ANSWERS)[number];

export type InvitationAccepted =
  | { kind: "refused"; check: Refused }
  /** Quedó aceptada: la base ya cerró las demás sesiones, y el resguardo se gastó. */
  | { kind: "accepted" }
  | { kind: "answered"; answer: Exclude<AcceptAnswer, "accepted"> }
  /** Se intentó y no se supo si quedó: la pantalla vuelve a preguntar el estado. */
  | { kind: "unknown" };

export type NoticeAccepted =
  | { kind: "refused"; check: Refused }
  /** Quedó anotado, o ya no le faltaba. */
  | { kind: "accepted" }
  /** El texto cambió entre mostrarlo y aceptarlo: se vuelve a mostrar. */
  | { kind: "changed" }
  /** No es un maestro al que le falte el aviso. */
  | { kind: "not_needed" }
  | { kind: "unknown" };

export interface TeacherStore {
  standing(claims: VerifiedClaims, ticketPrint: string | null): Promise<TeacherStanding>;
  texts(claims: VerifiedClaims, draftsAllowed: boolean): Promise<TeacherTexts>;
  accept(claims: VerifiedClaims, ticketPrint: string, agreement: string, notice: string, evidence: ConsentEvidence): Promise<AcceptAnswer>;
  /** Anota el aviso, solo si ese es el vigente. Falso si cambió. */
  acceptNotice(claims: VerifiedClaims, notice: string, evidence: ConsentEvidence, draftsAllowed: boolean): Promise<boolean>;
}

export interface TeachersDeps {
  store: TeacherStore;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
  /** La huella del resguardo del buzón de ese navegador, o nula. */
  readTicket: (reader: CookieReader) => string | null;
  dropTicket: (jar: CookieJar) => void;
  /** De dónde viene la petición, para el consentimiento. */
  evidence: (origin: RequestOrigin) => ConsentEvidence;
  /** Corre en local: ahí un borrador (versión 0) vale como texto vigente. */
  isLocal: () => boolean;
}

export function createTeachers(deps: TeachersDeps) {
  /** Lo que leen las guardas de las pantallas del portal. */
  async function teacherStanding(reader: CookieReader): Promise<TeacherCheck> {
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return check;
    try {
      return { kind: "teacher", claims: check.claims, standing: await deps.store.standing(check.claims, deps.readTicket(reader)) };
    } catch {
      await deps.report("teacher_unavailable");
      return { kind: "unavailable" };
    }
  }

  /** Los dos textos del maestro, para la pantalla que ya pasó la guarda. Nulo si no se supo. */
  async function teacherTexts(claims: VerifiedClaims): Promise<TeacherTexts | null> {
    try {
      return await deps.store.texts(claims, deps.isLocal());
    } catch {
      await deps.report("teacher_unavailable");
      return null;
    }
  }

  /** ¿Ya es maestro, según la base? Lo que aclara una respuesta que no dice qué pasó. Nulo si no se supo. */
  async function nowTeacher(claims: VerifiedClaims): Promise<boolean | null> {
    try {
      const { state } = await deps.store.standing(claims, null);
      return state === "active" || state === "needs_notice";
    } catch {
      return null;
    }
  }

  /**
   * Aceptar la invitación de quien actúa, con los dos textos que la pantalla le mostró. Nada de lo que llega
   * dice de qué invitación se trata: la base la busca por el correo de la cuenta. Sin resguardo no se le
   * pregunta. Un doble envío contesta `no_invitation`: si ya es maestro, quedó aceptada.
   */
  async function acceptTeacherInvitation(
    jar: CookieJar,
    shown: { agreement: string; notice: string },
    origin: RequestOrigin,
  ): Promise<InvitationAccepted> {
    const check = await deps.checkSession(jar);
    if (check.kind !== "pass") return { kind: "refused", check };
    const ticket = deps.readTicket(jar);
    if (ticket === null) return { kind: "answered", answer: "needs_mailbox_proof" };

    let answer: AcceptAnswer | "lost";
    try {
      answer = await deps.store.accept(check.claims, ticket, shown.agreement, shown.notice, deps.evidence(origin));
    } catch {
      answer = "lost";
    }
    if (answer === "no_invitation" || answer === "lost") {
      const teacher = await nowTeacher(check.claims);
      if (teacher === true) {
        if (answer === "lost") await deps.report("teacher_invitation_answer_lost");
        deps.dropTicket(jar);
        return { kind: "accepted" };
      }
      if (answer === "lost" || teacher === null) {
        await deps.report("teacher_invitation_answer_lost");
        return { kind: "unknown" };
      }
      return { kind: "answered", answer };
    }
    if (answer === "accepted") {
      deps.dropTicket(jar);
      return { kind: "accepted" };
    }
    // Faltan los textos o el plazo: no lo arregla reintentar, y alguien tiene que saberlo.
    if (answer === "unavailable") await deps.report("teacher_invitation_unavailable");
    return { kind: "answered", answer };
  }

  /**
   * Aceptar el aviso vuelto a pedir. Solo escribe para un maestro al que de verdad le falta, y solo si el
   * texto que se le mostró sigue siendo el vigente. Una decisión de Sergio del 2026-10-30: sin esto, la base
   * no lo deja escribir sus cursos.
   */
  async function acceptTeacherNotice(jar: CookieJar, shown: { notice: string }, origin: RequestOrigin): Promise<NoticeAccepted> {
    const check = await deps.checkSession(jar);
    if (check.kind !== "pass") return { kind: "refused", check };
    try {
      const { state } = await deps.store.standing(check.claims, null);
      if (state === "active") return { kind: "accepted" };
      if (state !== "needs_notice") return { kind: "not_needed" };
      return (await deps.store.acceptNotice(check.claims, shown.notice, deps.evidence(origin), deps.isLocal())) ? { kind: "accepted" } : { kind: "changed" };
    } catch {
      await deps.report("teacher_unavailable");
      return { kind: "unknown" };
    }
  }

  return { teacherStanding, teacherTexts, acceptTeacherInvitation, acceptTeacherNotice };
}
