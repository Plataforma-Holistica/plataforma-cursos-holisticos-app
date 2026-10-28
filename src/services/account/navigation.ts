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
  /** PA-12, dar el código: quien es del equipo y entra. Cuelga de entrar, pero pide sesión. */
  secondFactor: "/entrar/segundo-factor",
  /** PA-12, configurar: quien tiene una invitación la acepta ahí. */
  factorSetup: "/entrar/segundo-factor/configurar",
  admin: "/admin",
  /** PA-86, el equipo de administración: cuelga de administración y pide configuración. */
  team: "/admin/equipo",
  /** PA-67, las prácticas y los niveles: cuelga de administración y pide Contenido. */
  catalog: "/admin/practicas",
  /** PA-61 y PA-62 mínimas, los cursos por revisar: cuelga de administración y pide Contenido. */
  review: "/admin/revision",
  /** PA-68 mínima, las alertas de anomalía: cuelga de administración y pide finanzas. */
  alerts: "/admin/alertas",
  /** PA-78, los periodos: cuelga de administración y pide finanzas. El panel de uno y su cierre, `periodPath`. */
  periods: "/admin/periodos",
  /**
   * Los cursos. La ficha de un curso (`/cursos/[slug]`, T-210) es pública; la lección
   * (`/cursos/[slug]/lecciones/[leccion]`, PA-22, T-203) pide sesión. Ver `isLessonPath`.
   */
  courses: "/cursos",
  /** La ficha de un maestro (`/maestros/[slug]`, PA-03, T-210): pública. */
  teachers: "/maestros",
  /** Explorar y buscar (PA-21, T-210): pide sesión (RF-304). Con filtros, `explorePath`. */
  explore: "/explorar",
} as const;

/** El parámetro que guarda a dónde se quería ir. */
export const RETURN_PARAM = "volver";

/**
 * Las rutas que piden sesión: vale la ruta exacta y lo que cuelga de ella. Una pantalla
 * nueva con sesión se agrega aquí, y una prueba de arquitectura exige que llame a la guarda.
 */
export const SESSION_ROUTES: readonly string[] = [
  ROUTES.home,
  ROUTES.explore,
  ROUTES.consents,
  ROUTES.account,
  // Con ella entra también la de configurar, que cuelga de esta.
  ROUTES.secondFactor,
  ROUTES.admin,
];

// La lección: `/cursos/{slug}/lecciones/{id}`, exactamente esos cuatro segmentos. No va por
// prefijo, porque de `/cursos` cuelga también la ficha del curso, que es pública.
const LESSON_PATH = /^\/cursos\/[^/]+\/lecciones\/[^/]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LESSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Si la ruta es la de una lección (PA-22). Pide sesión, pero la guarda de su página decide a dónde va quien no la tiene. */
export function isLessonPath(pathname: string): boolean {
  return LESSON_PATH.test(pathname);
}

/** La dirección de una lección, o nulo si el slug o el id no tienen forma. */
export function lessonPath(slug: string, lessonId: string): string | null {
  return SLUG.test(slug) && LESSON_ID.test(lessonId) ? `${ROUTES.courses}/${slug}/lecciones/${lessonId}` : null;
}

/** La ficha de un curso (PA-02), o nulo si el slug no tiene forma. */
export function coursePath(slug: string): string | null {
  return SLUG.test(slug) ? `${ROUTES.courses}/${slug}` : null;
}

/** La ficha de un maestro (PA-03), o nulo si el slug no tiene forma. */
export function teacherPath(slug: string): string | null {
  return SLUG.test(slug) ? `${ROUTES.teachers}/${slug}` : null;
}

/** El periodo en la dirección: `202710` es `2027-10`. */
function periodSegment(period: number): string {
  return `${Math.floor(period / 100)}-${String(period % 100).padStart(2, "0")}`;
}

/** PA-79, el panel de un periodo (`AAAAMM`). */
export const periodPath = (period: number): string => `${ROUTES.periods}/${periodSegment(period)}`;

/** PA-80, el ensayo y el cierre de un periodo. */
/** Lo que explorar lleva en la dirección (PA-21): cada filtro por su slug, y la búsqueda. */
export interface ExploreParams {
  q?: string | null;
  practice?: string | null;
  teacher?: string | null;
  level?: string | null;
}

/** Explorar con esos filtros, siempre en el mismo orden; sin ninguno, `/explorar`. */
export function explorePath({ q = null, practice = null, teacher = null, level = null }: ExploreParams = {}): string {
  const params = new URLSearchParams();
  if (practice !== null) params.set("practica", practice);
  if (teacher !== null) params.set("maestro", teacher);
  if (level !== null) params.set("nivel", level);
  if (q !== null) params.set("q", q);
  const query = params.toString();
  return query === "" ? ROUTES.explore : `${ROUTES.explore}?${query}`;
}

export const periodClosePath = (period: number): string => `${periodPath(period)}/cierre`;

/** PA-81, las liquidaciones de un periodo. */
export const periodPayoutsPath = (period: number): string => `${periodPath(period)}/liquidaciones`;

/**
 * A dónde se puede volver después de entrar. Va por lo que se permite: una ruta nueva no
 * es destino hasta que alguien la agrega. Las pantallas por las que se entra (entrar,
 * registrarse, recuperar, completar la cuenta, las dos del segundo factor) no están: volver
 * a ellas daría vueltas.
 *
 * Administración vale con todo lo que cuelgue de ella: por eso bajo `/admin` no puede haber
 * una lectura con efectos.
 */
const RETURN_DESTINATIONS: readonly string[] = [ROUTES.home, ROUTES.account, ROUTES.admin, ROUTES.courses, ROUTES.explore];

/** Las rutas de `SESSION_ROUTES`: la ruta exacta y lo que cuelga de ella. */
function underSessionRoute(pathname: string): boolean {
  return SESSION_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export function requiresSession(pathname: string): boolean {
  return underSessionRoute(pathname) || isLessonPath(pathname);
}

/**
 * Si el paso previo manda a entrar a quien llega sin sesión. La lección no: si su curso es el
 * abierto va a registrarse, y eso lo sabe la base, que el paso previo no lee.
 */
export function proxySignsIn(pathname: string): boolean {
  return underSessionRoute(pathname);
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

/**
 * A registrarse, guardando a dónde se quería ir (la lección de un curso abierto, flujo §6.3).
 * El registro todavía no lleva ese destino hasta el final: queda escrito para cuando lo haga.
 */
export const signUpPath = (target: string | null | undefined): string => withReturn(ROUTES.signUp, target);

/** A completar la cuenta (PA-15), guardando a dónde se quería ir. */
export const consentsPath = (target: string | null | undefined): string => withReturn(ROUTES.consents, target);

/** A dar el código del segundo factor (PA-12), guardando a dónde se quería ir. */
export const secondFactorPath = (target: string | null | undefined): string => withReturn(ROUTES.secondFactor, target);

/**
 * A dónde va quien es del equipo y ya dio su código: el destino guardado si vale, y si no,
 * administración. Quién es del equipo no se decide aquí: lo dice la base.
 */
export function teamDestination(input: string | null | undefined): string {
  const resolved = resolveReturnPath(input, RETURN_DESTINATIONS);
  return resolved.kind === "path" ? resolved.path : ROUTES.admin;
}

/**
 * Si el destino guardado vale y no es de administración: quien lo trae pidió otra pantalla,
 * y al entrar no se le desvía a la del segundo factor.
 */
export function returnsOutsideAdmin(input: string | null | undefined): boolean {
  const resolved = resolveReturnPath(input, RETURN_DESTINATIONS);
  if (resolved.kind !== "path") return false;
  const pathname = resolved.path.split("?")[0];
  return pathname !== ROUTES.admin && !pathname?.startsWith(`${ROUTES.admin}/`);
}

/**
 * En qué estado está alguien respecto al equipo, solo por su nombre: los de `TeamStanding`,
 * en `team.ts`. Se escriben aquí, y no se traen de allá, porque este archivo lo carga el paso
 * previo y no importa nada de los servicios que llegan a la base. Si la base gana un estado,
 * `team.ts` deja de compilar hasta que entre a esta lista y a la tabla de abajo.
 */
export type TeamState = "none" | "member" | "needs_code" | "unbound" | "invited" | "invited_unproven";

/**
 * A dónde va quien acaba de quedar dentro y sin pendientes (entrar, completar el registro,
 * completar la cuenta), según su estado en el equipo.
 *
 * Quien pidió una pantalla que no es de administración va a esa pantalla: el segundo factor
 * solo se pide en administración. A los demás del equipo se les lleva a la pantalla que les
 * toca, y nunca directo a administración sin haber dado su código: a quien llegue ahí sin
 * darlo lo detiene la guarda de esa página, que es el control.
 *
 * @param state El estado que el servicio leyó al dejarla entrar, o nulo si no se supo: «no
 *   se supo» no da nada, y se sigue como cualquier cuenta.
 * @param returnTo El destino guardado (`volver`), tal como llegó.
 */
export function entryDestination(state: TeamState | null, returnTo: string | null | undefined): string {
  if (state === null || state === "none" || returnsOutsideAdmin(returnTo)) return resolveDestination(returnTo);
  switch (state) {
    case "invited_unproven":
    case "invited":
      return ROUTES.factorSetup;
    case "unbound":
      return ROUTES.secondFactor;
    case "needs_code":
      return secondFactorPath(returnTo);
    case "member":
      return teamDestination(returnTo);
  }
}
