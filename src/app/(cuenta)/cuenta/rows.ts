import { longDate } from "@/app/_lib/dates";
import { deviceName } from "@/app/_lib/devices";
import { account } from "@/messages/es/account";
import { t } from "@/messages/format";
import type { OpenSession } from "@/services/account/account";

// Las sesiones abiertas de la cuenta, puestas en palabras (diseño, PA-25). Lo arma la
// página, en el servidor, y la pantalla solo lo pinta: así el navegador no necesita saber
// leer fechas ni nombres de navegadores, y lo que se ve es lo mismo con JavaScript y sin él.

const text = account.manage;

/** Una fila de la lista de sesiones, lista para pintarse. */
export interface SessionRow {
  id: string;
  /** «Chrome en Windows», o lo que se haya podido reconocer. */
  device: string;
  /** «Se abrió el 12 de noviembre de 2026.», o nulo si la fecha no se entiende. */
  opened: string | null;
  /** «Última actividad: 12 de noviembre de 2026.», o nulo si no se sabe. */
  lastActive: string | null;
  /** Es la sesión con la que se está viendo la lista: esa no lleva botón de cerrar. */
  current: boolean;
  /** Lo que el botón «Cerrar» dice además, para quien no ve la fila. */
  closeDetail: string;
}

/** De qué navegador y sistema dijo ser una sesión: el mismo nombre que en PA-34 (T-204). */
export { deviceName };

export function sessionRows(sessions: readonly OpenSession[]): SessionRow[] {
  return sessions.map((session) => {
    const device = deviceName(session.device);
    const opened = longDate(session.openedAt);
    const active = session.lastActiveAt === null ? "" : longDate(session.lastActiveAt);
    return {
      id: session.id,
      device,
      opened: opened === "" ? null : t(text.openedOn, { date: opened }),
      lastActive: active === "" ? null : t(text.lastActiveOn, { date: active }),
      current: session.current,
      closeDetail: opened === "" ? device : t(text.closeOneDetail, { device, date: opened }),
    };
  });
}
