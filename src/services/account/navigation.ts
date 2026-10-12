import { resolveReturnPath } from "@/domain/access/return-path";

// Por dónde se mueve una persona entre las pantallas de la cuenta (flujo de la app §6.1,
// §6.3 y §6.4). Es puro y no toca la base: lo importan las pantallas y el paso previo, que
// no debe poder abrir una transacción.
//
// Aquí no se decide quién pasa. Eso lo dice la guarda de sesión (`checkSession`), en cada
// página y en cada acción; esto solo sabe a dónde llevar.

export const ROUTES = {
  landing: "/",
  signIn: "/entrar",
  signUp: "/registro",
  recover: "/recuperar",
  verify: "/verificar",
  consents: "/consentimientos",
  home: "/inicio",
  account: "/cuenta",
  closeSession: "/sesion/cerrar",
} as const;

/** El parámetro que guarda a dónde se quería ir. */
export const RETURN_PARAM = "volver";

/**
 * Las rutas que piden sesión: vale la ruta exacta y lo que cuelga de ella. Una pantalla
 * nueva con sesión se agrega aquí, y una prueba de arquitectura exige que llame a la guarda.
 */
export const SESSION_ROUTES: readonly string[] = [ROUTES.home, ROUTES.consents, ROUTES.account];

/**
 * A dónde se puede volver después de entrar. Va por lo que se permite: una ruta nueva no
 * es destino hasta que alguien la agrega. Las pantallas por las que se entra (entrar,
 * registrarse, recuperar, completar la cuenta) no están: volver a ellas daría vueltas.
 */
const RETURN_DESTINATIONS: readonly string[] = [ROUTES.home, ROUTES.account];

export function requiresSession(pathname: string): boolean {
  return SESSION_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** El inicio de quien entró. Los roles llegan con T-105: hoy todos son alumnos. */
export function homeOf(): string {
  return ROUTES.home;
}

/**
 * El destino guardado, o el inicio si no hay o no vale. Es el único lector de `volver`:
 * nada más lo usa como destino.
 */
export function resolveDestination(input: string | null | undefined): string {
  const resolved = resolveReturnPath(input, RETURN_DESTINATIONS);
  return resolved.kind === "path" ? resolved.path : homeOf();
}

function withReturn(route: string, target: string | null | undefined): string {
  const resolved = resolveReturnPath(target, RETURN_DESTINATIONS);
  // Un destino que no vale no se guarda: no tiene caso pasearlo por la dirección.
  return resolved.kind === "path" ? `${route}?${RETURN_PARAM}=${encodeURIComponent(resolved.path)}` : route;
}

/** A entrar, guardando a dónde se quería ir. */
export const signInPath = (target: string | null | undefined): string => withReturn(ROUTES.signIn, target);

/** A completar la cuenta (PA-15), guardando a dónde se quería ir. */
export const consentsPath = (target: string | null | undefined): string => withReturn(ROUTES.consents, target);
