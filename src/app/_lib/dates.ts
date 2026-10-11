// Cómo se escribe una fecha y una hora en pantalla (diseño, sección 6.0): la fecha
// completa, «12 de noviembre de 2026».
//
// El servidor no sabe en qué zona está quien lee. Una fecha se escribe en la zona del
// centro de México, que es la del producto; una hora, que sí cambia de sentido con la
// zona, la vuelve a escribir el navegador en la suya cuando puede (ver la pantalla de
// entrar).

export const PRODUCT_TIME_ZONE = "America/Mexico_City";

const LONG_DATE = new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeZone: PRODUCT_TIME_ZONE });

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
