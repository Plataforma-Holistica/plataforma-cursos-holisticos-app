import { portalNoticePath, resolveDestination, RETURN_PARAM, ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type { NoticeAccepted } from "@/services/teachers/standing";

// Lo que la pantalla del aviso lee del formulario y lo que hace con cada respuesta (T-401). Sin nada del servidor.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface NoticeFormInput {
  /** Nulo si no tiene forma: un formulario armado a mano. */
  notice: string | null;
  agreed: boolean;
  returnTo: string;
}

export function readNoticeForm(form: FormData): NoticeFormInput {
  const notice = form.get("notice");
  const returnTo = form.get(RETURN_PARAM);
  return {
    notice: typeof notice === "string" && ID.test(notice) ? notice : null,
    agreed: form.get("agreed") === "on",
    returnTo: typeof returnTo === "string" ? returnTo : "",
  };
}

/** A dónde sigue: de vuelta a donde iba, solo dentro del portal. */
export function noticeDestination(returnTo: string): string {
  const to = resolveDestination(returnTo);
  return to === ROUTES.portal || to.startsWith(`${ROUTES.portal}/`) ? to : ROUTES.portal;
}

/** «Reintentar» cuando no se pudo leer el texto: sin perder a dónde iba. */
export function noticeRetryHref(returnTo: string): string {
  const to = noticeDestination(returnTo);
  return to === ROUTES.portal ? ROUTES.portalNotice : portalNoticePath(to);
}

export type NoticeFailure = "changed" | "unknown";

export type NoticeState = { kind: "idle" } | { kind: "missing"; attempt: number } | { kind: "failed"; reason: NoticeFailure; attempt: number };

export type NoticeOutcome =
  | { kind: "leave"; to: string; notice: Notice | null; closeSession?: boolean }
  | { kind: "repaint"; reason: NoticeFailure | null };

export function noticeOutcome(result: NoticeAccepted, returnTo: string): NoticeOutcome {
  switch (result.kind) {
    // Solo el inicio del portal lee el aviso: en otra pantalla se quedaría esperando a la siguiente vez que se abra.
    case "accepted": {
      const to = noticeDestination(returnTo);
      return { kind: "leave", to, notice: to === ROUTES.portal ? "teacher_notice_accepted" : null };
    }
    case "changed":
      return { kind: "repaint", reason: "changed" };
    case "unknown":
      return { kind: "repaint", reason: "unknown" };
    // Ya no es un maestro al que le falte: la guarda de la página decide.
    case "not_needed":
      return { kind: "leave", to: ROUTES.portal, notice: null };
    case "refused":
      switch (result.check.kind) {
        case "must_sign_out":
          return result.check.then === "recover"
            ? { kind: "leave", to: ROUTES.recover, notice: "choose_password", closeSession: true }
            : { kind: "leave", to: ROUTES.signIn, notice: null, closeSession: true };
        case "unavailable":
          return { kind: "repaint", reason: "unknown" };
        default:
          return { kind: "repaint", reason: null };
      }
  }
}
