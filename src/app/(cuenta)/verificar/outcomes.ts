// Lo que pinta «Revisa tu correo» (diseño, PA-14, primera variante) alrededor de su botón
// «Reenviar». Es puro, con su prueba, y viaja al navegador.
//
// Nada de esto es la espera de verdad: esa la lleva el servicio, que no manda dos correos
// antes de `ESPERA_REENVIO` se le pida lo que se le pida. Aquí solo se decide si el botón se
// pinta deshabilitado, para no ofrecer un envío que no va a salir.

/** Hasta cuándo queda deshabilitado «Reenviar», y de cuánto es la espera. */
export interface ResendWait {
  /** En formato ISO. */
  until: string;
  /** `ESPERA_REENVIO`, en segundos. */
  seconds: number;
}

/** Lo más que puede valer una espera para pintarse: un día. Más que eso no es un parámetro creíble. */
const MAX_WAIT_SECONDS = 86_400;

/**
 * La espera que le queda a «Reenviar», o nulo si ya se puede.
 *
 * La hora del último envío sale de una cookie, que escribe quien quiere: una hora que
 * todavía no llega cuenta como «ahora», para que nadie se deje el botón apagado por días.
 *
 * @param sentAt Cuándo se pidió el último envío, en milisegundos.
 * @param now La hora, en milisegundos.
 */
export function resendWait(sentAt: number, waitSeconds: number, now: number): ResendWait | null {
  if (!Number.isFinite(sentAt) || !Number.isFinite(now)) return null;
  if (!Number.isInteger(waitSeconds) || waitSeconds <= 0 || waitSeconds > MAX_WAIT_SECONDS) return null;
  const until = Math.min(sentAt, now) + waitSeconds * 1_000;
  return until > now ? { until: new Date(until).toISOString(), seconds: waitSeconds } : null;
}

/** Lo que la pantalla pinta después de pedir un reenvío. */
export type ResendState =
  | { kind: "idle" }
  /** «Listo, lo mandamos otra vez.» Lo mismo se haya mandado algo o no. */
  | { kind: "sent"; wait: ResendWait | null; attempt: number }
  /** `wait`: el tope por dirección, el único que se dice. `unavailable`: no se supo. */
  | { kind: "failed"; reason: "wait" | "unavailable"; attempt: number };
