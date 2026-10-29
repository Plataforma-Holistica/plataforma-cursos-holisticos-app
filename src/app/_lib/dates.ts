import { account } from "@/messages/es/account";
import { plural, t } from "@/messages/format";

// Cómo se escribe una fecha y una hora en pantalla (diseño, sección 6.0): la fecha
// completa, «12 de noviembre de 2026».
//
// El servidor no sabe en qué zona está quien lee. Una fecha se escribe en la zona del
// centro de México, que es la del producto; una hora, que sí cambia de sentido con la
// zona, la vuelve a escribir el navegador en la suya cuando puede (ver la pantalla de
// entrar).


export const PRODUCT_TIME_ZONE = "America/Mexico_City";

const LONG_DATE = new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeZone: PRODUCT_TIME_ZONE });
// `en-CA` escribe la fecha como AAAA-MM-DD.
const CALENDAR_DAY = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: PRODUCT_TIME_ZONE });

/** El día de un momento en la zona del producto, como AAAA-MM-DD (el de un `<input type="date">`). */
export function productDay(date: Date): string {
  return CALENDAR_DAY.format(date);
}

/** «12 de noviembre de 2026», o vacío si la fecha no se entiende. */
export function longDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : LONG_DATE.format(date);
}

/** La hora de un momento: en la zona que se pida o, sin zona, en la del navegador. */
export function clockTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-MX", { hour: "numeric", minute: "2-digit", timeZone }).format(date);
}

/**
 * Una duración, dicha como se dice: «1 hora», «15 minutos», «60 segundos». En la unidad más
 * grande que la deje entera. Vacío si no es un número de segundos que se pueda decir.
 */
export function durationText(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds <= 0) return "";
  const { hours, minutes, seconds: secondsForms } = account.durations;
  if (seconds % 3_600 === 0) return t(plural(seconds / 3_600, hours), { count: seconds / 3_600 });
  if (seconds % 60 === 0) return t(plural(seconds / 60, minutes), { count: seconds / 60 });
  return t(plural(seconds, secondsForms), { count: seconds });
}
