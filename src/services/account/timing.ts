import "server-only";

// El tiempo mínimo de respuesta (TRD §9.2, fila «Registro»).
//
// Supabase Auth contesta más rápido cuando el correo no existe o ya está confirmado. Los
// servicios de entrada, de registro y de recuperación alargan su respuesta hasta un piso
// fijo, que es una constante del código y no un parámetro de negocio. Aplica a todos los
// caminos: el frenado, el negado y el que falla.
//
// Protege mientras el camino lento quede debajo del piso. Si lo rebasa, la respuesta se
// alarga hasta el siguiente múltiplo: la diferencia queda en escalones, no al milisegundo.

/** El piso al entrar. */
export const SIGN_IN_FLOOR_MS = 500;
/** El piso al pedir el registro o la recuperación, que mandan un correo. */
export const MAIL_REQUEST_FLOOR_MS = 1_000;

export interface Timing {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realTiming: Timing = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Corre `work` y no contesta antes de `floorMs`, ni entre dos múltiplos suyos. */
export async function atLeast<T>(floorMs: number, work: () => Promise<T>, timing: Timing = realTiming): Promise<T> {
  if (!Number.isSafeInteger(floorMs) || floorMs < 1) {
    throw new Error("El piso del tiempo de respuesta debe ser un entero de milisegundos, mayor que cero.");
  }
  const started = timing.now();
  try {
    return await work();
  } finally {
    const elapsed = Math.max(timing.now() - started, 0);
    const target = Math.max(Math.ceil(elapsed / floorMs), 1) * floorMs;
    const remaining = target - elapsed;
    if (remaining > 0) await timing.sleep(remaining);
  }
}
