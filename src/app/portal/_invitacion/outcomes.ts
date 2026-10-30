import { ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type { InvitationAccepted } from "@/services/teachers/standing";

// Lo que PA-40 lee del formulario y lo que hace con cada respuesta (T-401, FL-30). Sin nada del servidor. El
// formulario solo lleva los dos textos que se mostraron y sus casillas: nunca el maestro, ni la invitación, ni
// el correo.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface InvitationForm {
  /** Nulo si no tiene forma: un formulario armado a mano. */
  shown: { agreement: string; notice: string } | null;
  agreed: boolean;
  noticeAgreed: boolean;
}

export function readInvitationForm(form: FormData): InvitationForm {
  const agreement = form.get("agreement");
  const notice = form.get("notice");
  return {
    shown: typeof agreement === "string" && ID.test(agreement) && typeof notice === "string" && ID.test(notice) ? { agreement, notice } : null,
    agreed: form.get("agreed") === "on",
    noticeAgreed: form.get("notice_agreed") === "on",
  };
}

export type InvitationFailure = "changed" | "gone" | "unavailable" | "unknown";

export type InvitationState =
  | { kind: "idle" }
  | { kind: "missing"; agreed: boolean; noticeAgreed: boolean; attempt: number }
  | { kind: "failed"; reason: InvitationFailure; attempt: number };

export type InvitationOutcome =
  | { kind: "leave"; to: string; notice: Notice | null; closeSession?: boolean }
  /** Se vuelve a pedir la página: la guarda y los textos dicen lo de ahora. */
  | { kind: "repaint"; reason: InvitationFailure | null }
  | { kind: "suspended" };

export function acceptOutcome(result: InvitationAccepted): InvitationOutcome {
  switch (result.kind) {
    case "accepted":
      return { kind: "leave", to: ROUTES.portal, notice: "teacher_accepted" };
    case "unknown":
      return { kind: "repaint", reason: "unknown" };
    case "refused":
      switch (result.check.kind) {
        case "anonymous":
          return { kind: "leave", to: ROUTES.portalInvitation, notice: null };
        case "must_sign_out":
          return { kind: "leave", to: ROUTES.signIn, notice: null, closeSession: true };
        case "suspended":
          return { kind: "suspended" };
        case "unavailable":
          return { kind: "repaint", reason: "unavailable" };
        default:
          // Le falta algo de su cuenta: la guarda de la página lo manda a completarla.
          return { kind: "repaint", reason: null };
      }
    case "answered":
      switch (result.answer) {
        case "changed":
          return { kind: "repaint", reason: "changed" };
        // La guarda vuelve a preguntar: pinta «prueba tu correo».
        case "needs_mailbox_proof":
          return { kind: "repaint", reason: null };
        case "already_teacher":
          return { kind: "leave", to: ROUTES.portal, notice: null };
        case "no_invitation":
        case "inviter_lost_content":
          return { kind: "repaint", reason: "gone" };
        case "unavailable":
          return { kind: "repaint", reason: "unavailable" };
        case "ineligible":
          return { kind: "repaint", reason: "unavailable" };
      }
  }
}
