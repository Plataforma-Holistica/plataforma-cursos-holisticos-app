import type { PendingAccount, SessionCheck, TeamCheck, VerifiedClaims } from "@/services/account/account";
import {
  consentsPath,
  homeOf,
  resolveDestination,
  ROUTES,
  secondFactorPath,
  signInPath,
  signUpPath,
  teamDestination,
  portalNoticePath,
} from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import { holds, type Capability } from "@/services/account/team";
import type { TeacherCheck } from "@/services/teachers/standing";

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
 * La pantalla de una lección (PA-22, T-203): pide sesión como cualquiera, salvo a dónde va
 * quien no la tiene (flujo §6.3). Si el curso es el abierto, a registrarse; si no, o si no se
 * supo, a entrar, que es lo que sirve a quien ya tiene cuenta. Cuando exista `/planes`
 * (T-30x), el curso normal va ahí.
 * @param courseIsOpen Si el curso de la lección es el abierto, o nulo si no se supo.
 */
export function lessonPageStep(
  check: SessionCheck,
  path: string,
  courseIsOpen: boolean | null,
): { kind: "render"; claims: VerifiedClaims } | Detour {
  if (check.kind === "anonymous") return redirect(courseIsOpen === true ? signUpPath(path) : signInPath(path));
  return sessionPageStep(check, path);
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
 * Una pantalla pública que cambia según quién mira (la ficha de un curso, PA-02; T-210): se pinta
 * siempre, nunca redirige ni pinta un estado. Con una sesión que pasa, como alumno. Sin sesión, o
 * con una cookie que ya no vale, como visitante: entrar o registrarse cierra esa sesión. A una
 * cuenta suspendida o a medias, o cuando no se supo, no se le ofrece lo del visitante
 * (`unavailable` nunca se trata como «sin sesión»): se le muestra lo que cualquiera ve, sin botón.
 */
export function publicPageStep(check: SessionCheck): { kind: "student"; claims: VerifiedClaims } | { kind: "visitor" } | { kind: "unknown" } {
  switch (check.kind) {
    case "pass":
      return { kind: "student", claims: check.claims };
    case "anonymous":
    case "must_sign_out":
      return { kind: "visitor" };
    default:
      return { kind: "unknown" };
  }
}

// Las pantallas del equipo (T-105; flujo de la app §6.2). Su entrada es lo que contesta
// `teamStanding`: lo que la guarda de sesión niega, o el estado que dice la base. Quién es
// del equipo no se decide aquí, y `unavailable` nunca se trata como «no es del equipo».

/** PA-19: se contesta lo mismo que en una ruta que no existe. */
export interface NotFound {
  kind: "not_found";
}

type TeamDetour = Detour | NotFound;

/** Lo que la guarda de sesión niega, igual para las tres: a dónde manda a entrar o a completar la cuenta cambia. */
function refusedStep(
  check: Exclude<TeamCheck, { kind: "team" }>,
  toSignIn: string,
  toConsents: string,
): Detour {
  switch (check.kind) {
    case "anonymous":
      return redirect(toSignIn);
    case "incomplete":
      return redirect(toConsents);
    default:
      return detour(check);
  }
}

/**
 * Una pantalla de administración. Solo se pinta para quien es del equipo con la sesión que
 * pasa la puerta; a los demás estados los lleva a la pantalla que les toca.
 * @param path La ruta que se pidió, con su consulta: es a donde se vuelve después.
 * @param capability La capacidad que esa pantalla pide, si pide una. A quien es del equipo y
 *   no la tiene se le dice (PA-88); a los demás no les cambia nada.
 */
export function adminPageStep(
  check: TeamCheck,
  path: string,
  capability?: Capability,
): { kind: "render"; claims: VerifiedClaims; capabilities: string[] } | { kind: "forbidden"; capability: Capability } | TeamDetour {
  if (check.kind !== "team") return refusedStep(check, signInPath(path), consentsPath(path));
  const { standing } = check;
  switch (standing.state) {
    case "none":
      return { kind: "not_found" };
    case "invited_unproven":
    case "invited":
      return redirect(ROUTES.factorSetup);
    case "unbound":
      return redirect(ROUTES.secondFactor);
    case "needs_code":
      return redirect(secondFactorPath(path));
    case "member":
      if (capability !== undefined && !holds(standing, capability)) return { kind: "forbidden", capability };
      return { kind: "render", claims: check.claims, capabilities: standing.capabilities };
  }
}

// Las pantallas del portal del maestro (T-402; flujo de la app §6.2). Su entrada es lo que contesta
// `teacherStanding`. La cuenta suspendida va a PA-35 antes de mirar al maestro; el maestro suspendido
// entra en solo lectura (RF-702), y eso lo decide la pantalla con `status`. Quien no es maestro recibe
// lo mismo que en una ruta que no existe.

/** Qué tipo de pantalla del portal se pide: trabajar, aceptar la invitación, o el aviso vuelto a pedir. */
export type PortalKind = "work" | "invitation" | "notice";

/** Lo que se pinta: del maestro, o de la invitación. */
export type TeacherRender =
  | { kind: "render"; screen: "work"; claims: VerifiedClaims; teacher: { id: string; status: "active" | "suspended"; notice: string | null } }
  | { kind: "render"; screen: "invitation"; claims: VerifiedClaims; invitation: { proven: boolean; name: string | null } }
  | { kind: "render"; screen: "notice"; claims: VerifiedClaims };

/**
 * Una pantalla del portal del maestro (decisiones de Sergio del 2026-10-29 y del 2026-10-30). Quien no es
 * maestro recibe lo mismo en toda ruta, exista o no. A un invitado, toda ruta lo lleva a su invitación; a un
 * maestro al que le falta el aviso, al aviso, y de ahí vuelve a donde iba. A un suspendido no se le pide.
 * @param path La ruta que se pidió, con su consulta: es a donde se vuelve después.
 * @param kind El tipo de pantalla. Una ruta que no existe cuenta como de trabajo.
 */
export function teacherPageStep(check: TeacherCheck, path: string, kind: PortalKind = "work"): TeacherRender | TeamDetour {
  if (check.kind !== "teacher") return refusedStep(check, signInPath(path), consentsPath(path));
  const { claims, standing } = check;
  switch (standing.state) {
    case "none":
      return { kind: "not_found" };
    case "invited":
    case "invited_unproven":
      return kind === "invitation"
        ? { kind: "render", screen: "invitation", claims, invitation: { proven: standing.state === "invited", name: standing.name } }
        : { kind: "redirect", to: ROUTES.portalInvitation };
    case "needs_notice":
      if (kind === "notice") return { kind: "render", screen: "notice", claims };
      return { kind: "redirect", to: kind === "work" ? portalNoticePath(path) : ROUTES.portalNotice };
    case "active":
      if (kind !== "work") return { kind: "redirect", to: ROUTES.portal };
      return { kind: "render", screen: "work", claims, teacher: { id: standing.teacher.id, status: "active", notice: null } };
    case "suspended":
      if (kind !== "work") return { kind: "redirect", to: ROUTES.portal };
      return { kind: "render", screen: "work", claims, teacher: { id: standing.teacher.id, status: "suspended", notice: standing.notice } };
  }
}

/**
 * PA-12, dar el código (`/entrar/segundo-factor`). No usa la tabla de administración: con
 * `needs_code` se redirigiría a sí misma.
 * @param returnTo El destino guardado (`volver`), tal como llegó.
 */
export function secondFactorPageStep(
  check: TeamCheck,
  returnTo: string | null | undefined,
): { kind: "render"; view: "code" | "unbound" } | TeamDetour {
  if (check.kind !== "team") return refusedStep(check, signInPath(returnTo), consentsPath(returnTo));
  switch (check.standing.state) {
    case "none":
      return { kind: "not_found" };
    case "invited_unproven":
    case "invited":
      return redirect(ROUTES.factorSetup);
    case "unbound":
      // Conserva capacidades y perdió su atadura: no hay código que dar. Se le explica.
      return { kind: "render", view: "unbound" };
    case "needs_code":
      return { kind: "render", view: "code" };
    case "member":
      return redirect(teamDestination(returnTo));
  }
}

export type FactorSetupView =
  /** Tiene invitación, pero no ha abierto un enlace de su correo en este navegador. */
  | { view: "prove_mailbox" }
  /** `handoff`: es un restablecimiento, y pide además el código que dicta quien restableció. */
  | { view: "start"; handoff: boolean }
  /**
   * Ya hay un factor dado de alta en ese navegador y en esa sesión. La clave no se vuelve a
   * pintar: el campo del código, y cómo empezar de nuevo. `painted` es ese factor, que la
   * pantalla manda de vuelta como «lo que pinté».
   */
  | { view: "resume"; painted: string; handoff: boolean };

/** PA-12, configurar (`/entrar/segundo-factor/configurar`): ahí se acepta una invitación. */
export function factorSetupPageStep(check: TeamCheck): ({ kind: "render" } & FactorSetupView) | TeamDetour {
  if (check.kind !== "team") return refusedStep(check, ROUTES.signIn, ROUTES.consents);
  const { standing } = check;
  switch (standing.state) {
    case "none":
      return { kind: "not_found" };
    case "invited_unproven":
      return { kind: "render", view: "prove_mailbox" };
    case "invited": {
      const handoff = standing.kind === "rebind";
      return check.inProgress === null
        ? { kind: "render", view: "start", handoff }
        : { kind: "render", view: "resume", painted: check.inProgress, handoff };
    }
    case "unbound":
    case "needs_code":
      return redirect(ROUTES.secondFactor);
    case "member":
      return redirect(ROUTES.admin);
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
