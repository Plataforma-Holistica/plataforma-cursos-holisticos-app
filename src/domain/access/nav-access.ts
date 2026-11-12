// Quién ve «Mi portal» y «Administración» en la barra del alumno (T-616, solicitud 2; pedido de Sergio del
// 2026-11-10: desde el inicio no había cómo volver a la administración ni al portal). Regla pura: el servicio
// lee los dos estados de la base y la obedece.
//
// Mostrar un acceso no autoriza nada (04 §6.2: ocultar un botón nunca es el control): quién entra lo decide la
// guarda de esa pantalla. Aquí solo se cuida no ofrecerle un acceso a quien no tiene a dónde llegar.
//
//   · «Administración»: quien es del equipo, con el código dado (`member`), pendiente (`needs_code`, que la
//     guarda lleva a PA-12) o con el factor sin atar (`unbound`, que PA-12 le explica).
//   · «Mi portal»: el maestro activo, al que le falta el aviso (`needs_notice`, que el portal le pide) y el
//     suspendido (que lo ve en solo lectura).
//   · Una invitación, del equipo, de maestro o de restablecer el factor, no ve el acceso: su camino es el correo
//     (decisión del carril A del 2026-11-11).
//   · Lo que no se supo no abre nada, y no le quita al otro estado lo suyo.

/** Los estados del equipo, como los nombra `private.team_standing()`. */
export const TEAM_NAV_STATES = ["none", "member", "needs_code", "unbound", "invited", "invited_unproven"] as const;
export type TeamNavState = (typeof TEAM_NAV_STATES)[number];

/** Los estados del maestro, como los nombra `private.teacher_standing()`. */
export const TEACHER_NAV_STATES = ["none", "invited", "invited_unproven", "active", "needs_notice", "suspended"] as const;
export type TeacherNavState = (typeof TEACHER_NAV_STATES)[number];

/** Los accesos que pinta la barra. */
export interface NavAccess {
  readonly admin: boolean;
  readonly portal: boolean;
}

/** Ningún acceso: lo que da no saber. */
export const NO_NAV_ACCESS: NavAccess = Object.freeze({ admin: false, portal: false });

const ADMIN_STATES: readonly TeamNavState[] = ["member", "needs_code", "unbound"];
const PORTAL_STATES: readonly TeacherNavState[] = ["active", "needs_notice", "suspended"];

/** Si «Administración» lleva a algún lado. Nulo es que no se supo. */
export function opensAdmin(team: TeamNavState | null): boolean {
  return team !== null && ADMIN_STATES.includes(team);
}

/** Si «Mi portal» lleva a algún lado. Nulo es que no se supo. */
export function opensPortal(teacher: TeacherNavState | null): boolean {
  return teacher !== null && PORTAL_STATES.includes(teacher);
}

export function navAccessOf(team: TeamNavState | null, teacher: TeacherNavState | null): NavAccess {
  return { admin: opensAdmin(team), portal: opensPortal(teacher) };
}
