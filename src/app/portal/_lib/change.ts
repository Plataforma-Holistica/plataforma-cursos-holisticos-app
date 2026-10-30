import { consentsPath, ROUTES, signInPath } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type { DraftChange } from "@/services/drafts/editor";

// Qué hace una pantalla del portal con lo que contesta un cambio al borrador (T-402). Es puro: el
// servicio corre la guarda y la base decide; esto traduce. Toda respuesta de las funciones del
// borrador tiene su caso, y «no se supo» nunca se pinta como hecho.
//
//   · Quien ya no puede editar (suspendido, ya no es maestro, el curso dejó de estar en borrador) se
//     vuelve a la misma ruta: ahí la guarda y la página dicen qué pasa.
//   · `invalid` llega con el dominio ya pasado: es un formulario alterado o una posición fuera de
//     rango, y se dice como «no pudimos».

/** Toda respuesta de las funciones del borrador. */
export type DraftAnswer =
  | "created"
  | "saved"
  | "moved"
  | "deleted"
  | "changed"
  | "invalid"
  | "practice_inactive"
  | "level_inactive"
  | "not_found"
  | "not_editable"
  | "suspended"
  | "not_teacher";

export type ChangeFailure = "changed" | "gone" | "practice_inactive" | "level_inactive" | "unavailable";

export interface Leave {
  kind: "leave";
  /** Ya validado: lo arma la pantalla con ids que tienen forma. */
  to: string;
  notice: Notice | null;
  closeSession: boolean;
}

export type ChangeOutcome =
  | Leave
  | { kind: "done"; answer: "created" | "saved" | "moved" | "deleted"; id: string | null }
  | { kind: "failed"; reason: ChangeFailure };

const leave = (to: string, notice: Notice | null = null, closeSession = false): Leave => ({ kind: "leave", to, notice, closeSession });

/**
 * @param back La ruta de la pantalla que envió, ya armada: a donde se vuelve, y a donde se regresa
 *   después de entrar.
 */
export function changeOutcome(result: DraftChange<DraftAnswer>, back: string): ChangeOutcome {
  switch (result.kind) {
    case "created":
    case "saved":
    case "moved":
    case "deleted":
      return { kind: "done", answer: result.kind, id: result.kind === "created" ? (result.id ?? null) : null };
    case "changed":
      return { kind: "failed", reason: "changed" };
    case "not_found":
      return { kind: "failed", reason: "gone" };
    case "practice_inactive":
    case "level_inactive":
      return { kind: "failed", reason: result.kind };
    case "invalid":
    case "unknown":
      return { kind: "failed", reason: "unavailable" };
    case "suspended":
    case "not_teacher":
    case "not_editable":
      return leave(back);
    case "session":
      switch (result.check.kind) {
        case "anonymous":
          return leave(signInPath(back));
        case "incomplete":
          return leave(consentsPath(back));
        case "suspended":
          // La cuenta suspendida: la página pinta PA-35.
          return leave(back);
        case "unavailable":
          return { kind: "failed", reason: "unavailable" };
        case "must_sign_out":
          return result.check.then === "recover" ? leave(ROUTES.recover, "choose_password", true) : leave(ROUTES.signIn, null, true);
      }
  }
}
