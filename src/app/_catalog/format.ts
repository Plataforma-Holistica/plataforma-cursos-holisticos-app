import { messages, plural, t } from "@/messages";

// Cómo se escribe una duración en el catálogo (T-210): «6 min», «1 h 25 min», «2 horas». Es
// puro; lo comparten el inicio y las dos fichas.

const text = messages.browse;

/** Una lección: minutos, redondeados, y al menos uno. */
export function lessonMinutes(seconds: number): string {
  return t(text.minutes, { minutes: Math.max(1, Math.round(seconds / 60)) });
}

/** Un curso entero: en minutos si no llega a la hora; si no, horas y minutos. */
export function courseDuration(seconds: number): string {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  if (totalMinutes < 60) return t(text.minutes, { minutes: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? t(plural(hours, text.hours), { hours }) : t(text.hoursMinutes, { hours, minutes });
}
