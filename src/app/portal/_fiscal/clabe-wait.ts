import { clockTime, longDate, PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { messages, t } from "@/messages";

// Lo que se le dice al maestro mientras su CLABE nueva espera (T-409), en PA-48 y en el inicio del portal: es lo único que hoy le avisa de un cambio que no hizo. Va sin pedir la
// contraseña, a propósito: de eso depende que el dueño se entere. Una fecha, sin nada del dato.

export function clabeWaitingText(until: string): string {
  return t(messages.portal.taxData.clabeWaiting, { date: longDate(until), time: clockTime(until, PRODUCT_TIME_ZONE) });
}
