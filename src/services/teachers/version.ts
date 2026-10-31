import type { TeacherRow } from "./admin";

const stamp = (iso: string | null): number => {
  const ms = iso === null ? 0 : Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Lo que se vio de un maestro: lo que cambia qué se le puede hacer. Viaja en el botón, sin dos puntos. Lleva las horas de
 * la invitación y de la suspensión: levantar y volver a suspender, o revocar y reenviar, deja lo demás igual, y un botón viejo
 * no debe levantar una suspensión que no se vio ni revocar una invitación que no se vio. Vive aparte porque lo usan la tabla
 * de las pantallas y el servicio, y este archivo no arrastra nada del servidor.
 */
export function teacherVersion(row: Pick<TeacherRow, "status" | "founderSince" | "invitation" | "suspension" | "fraudPending" | "expiresAt" | "suspendedAt">): string {
  return [row.status, row.founderSince ?? "-", row.invitation, row.suspension ?? "-", row.fraudPending ? "1" : "0", stamp(row.expiresAt), stamp(row.suspendedAt)].join(".");
}
