// Lo poco que una acción lee del estado anterior de su formulario.
//
// Ese estado viaja por el navegador: con JavaScript lo manda React, y sin él lo arma quien
// envía. Una acción no le cree nada, salvo esto, que no decide nada: el número de intento,
// para que el resumen de errores vuelva a tomar el foco cuando el envío falla otra vez con
// los mismos errores.

const MAX_ATTEMPT = 1_000_000;

/** El número del intento que sigue. Con un estado que no se entiende, el primero. */
export function nextAttempt(previous: unknown): number {
  const last =
    typeof previous === "object" && previous !== null && "attempt" in previous ? (previous as { attempt: unknown }).attempt : 0;
  return typeof last === "number" && Number.isInteger(last) && last >= 0 && last < MAX_ATTEMPT ? last + 1 : 1;
}
