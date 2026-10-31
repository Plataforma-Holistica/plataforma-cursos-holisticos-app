import type { TeacherRow } from "./admin";

/**
 * Lo que se vio de un maestro: lo que cambia qué se le puede hacer. Viaja en el botón, sin dos puntos. Vive aparte porque
 * lo usan la tabla de las pantallas y el servicio, y esta no arrastra nada del servidor.
 */
export function teacherVersion(row: Pick<TeacherRow, "status" | "founderSince" | "invitation" | "suspension" | "fraudPending">): string {
  return [row.status, row.founderSince ?? "-", row.invitation, row.suspension ?? "-", row.fraudPending ? "1" : "0"].join(".");
}
