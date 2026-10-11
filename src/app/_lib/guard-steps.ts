import type { PendingAccount, SessionCheck, VerifiedClaims } from "@/services/account/account";
import { consentsPath, homeOf, resolveDestination, ROUTES, signInPath } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";

// Qué hace cada tipo de pantalla con lo que contesta la guarda de sesión (flujo de la app
// §6.2 y §6.3). Es una tabla pura: la guarda (`checkSession`) decide quién pasa, y esto
// solo traduce su respuesta a pintar la pantalla, pintar un estado o redirigir. Un caso
// nuevo se agrega aquí, con su prueba, no en una página.

export interface Redirect {
  kind: "redirect";
  to: string;
}

/** Lo que no es pintar la pantalla pedida. */
export type Detour =
  | Redirect
  /** PA-35: se pinta en esa misma ruta, sin navegación. */
  | { kind: "suspended" }
  /** No se supo si la sesión vale: PA-18, con «Reintentar». No se trata como «sin sesión». */
  | { kind: "unavailable" };

const redirect = (to: string): Redirect => ({ kind: "redirect", to });

function detour(check: Exclude<SessionCheck, { kind: "pass" | "incomplete" | "anonymous" }>): Detour {
  switch (check.kind) {
    case "suspended":
      return { kind: "suspended" };
    case "must_sign_out":
      // Una página no puede borrar una cookie: la sesión se cierra en esa ruta, que vuelve
      // a preguntarle a la guarda antes de cerrar nada.
      return redirect(ROUTES.closeSession);
    case "unavailable":
      return { kind: "unavailable" };
  }
}

/**
 * Una pantalla que pide sesión y cuenta completa.
 * @param path La ruta que se pidió, con su consulta: es a donde se vuelve después.
 */
export function sessionPageStep(check: SessionCheck, path: string): { kind: "render"; claims: VerifiedClaims } | Detour {
  switch (check.kind) {
    case "pass":
      return { kind: "render", claims: check.claims };
    case "anonymous":
      return redirect(signInPath(path));
    case "incomplete":
      return redirect(consentsPath(path));
    default:
      return detour(check);
  }
}

/**
 * La pantalla que pide lo que le falta a una cuenta (PA-15). Pide sesión, pero no cuenta
 * completa: ahí se completa.
 * @param returnTo El destino guardado (`volver`), tal como llegó.
 */
export function consentsPageStep(
  check: SessionCheck,
  returnTo: string | null | undefined,
): { kind: "render"; claims: VerifiedClaims; pending: PendingAccount } | Detour {
  switch (check.kind) {
    case "incomplete":
      return { kind: "render", claims: check.claims, pending: { variant: check.variant, missing: check.missing } };
    case "pass":
      return redirect(resolveDestination(returnTo));
    case "anonymous":
      return redirect(signInPath(returnTo));
    default:
      return detour(check);
  }
}

/**
 * Una pantalla de visitante (entrar, registrarse): quien ya tiene sesión va a su inicio,
 * que es donde la guarda decide qué ve. Con una cookie que ya no vale, o cuando no se
 * supo, la pantalla se pinta: entrar cierra la sesión que el navegador traía.
 */
export function visitorPageStep(check: SessionCheck): { kind: "render" } | Redirect {
  switch (check.kind) {
    case "pass":
    case "incomplete":
    case "suspended":
      return redirect(homeOf());
    default:
      return { kind: "render" };
  }
}

/**
 * A dónde va quien pasó por la ruta que cierra una sesión rechazada, según lo que esa ruta
 * hizo (`closeRejectedSession`).
 */
export function closedSessionRoute(result: "recover" | "sign_in" | "none" | "kept"): { to: string; notice: Notice | null } {
  switch (result) {
    case "recover":
      return { to: ROUTES.recover, notice: "choose_password" };
    case "sign_in":
    case "none":
      return { to: ROUTES.signIn, notice: null };
    case "kept":
      // No se cerró nada: la sesión vale, o no se supo. El inicio vuelve a preguntar.
      return { to: homeOf(), notice: null };
  }
}
