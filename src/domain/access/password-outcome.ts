// Qué sigue después de pedirle a Auth que fije una contraseña (RF-101, RF-103; TRD §9.2,
// filas «Verificación de correo» y «Recuperación»).
//
// Para cuando Auth contesta, el enlace del correo ya se canjeó: si la contraseña se
// rechaza, el enlace no vuelve. Por eso el paso siguiente depende del flujo, y por eso está
// aquí y no repartido entre los dos servicios. Lo que más importa de esta tabla es una
// columna: la marca de contraseña solo se apaga (`claimAccount`) cuando la contraseña quedó
// fijada de verdad. Apagarla antes dejaría viva la contraseña de quien dio de alta el correo.
//
// El adaptador traduce el `error.code` de Auth a uno de estos resultados; el mensaje crudo
// del proveedor nunca sale de él.

/** Completar el registro desde el enlace de verificación, o recuperar la contraseña. */
export type PasswordFlow = "complete_registration" | "recovery";

export type PasswordSetResult =
  | "ok"
  /** La contraseña nueva es la que ya tenía: quedó fijada igual. */
  | "same_password"
  /** Auth la rechazó por débil. Hoy solo puede pasar con una filtrada, en su plan de pago. */
  | "weak_password"
  /** Auth la rechazó por otra razón. No debería pasar: la política se revisa antes. */
  | "rejected"
  /** No se supo: Auth no contestó. */
  | "unknown";

export interface PasswordOutcome {
  /**
   * - `done`: la contraseña quedó fijada.
   * - `request_new_link`: recuperando, se rechazó. El enlace ya se gastó: pedir otro.
   * - `recover_instead`: completando el registro, se rechazó. El correo ya quedó confirmado
   *   y la marca sigue prendida: elegir otra contraseña por recuperación.
   * - `outcome_unknown`: no se sabe si quedó fijada. No se afirma nada.
   */
  next: "done" | "request_new_link" | "recover_instead" | "outcome_unknown";
  /** Llamar a `private.claim_account()`, que apaga la marca de contraseña. */
  claimAccount: boolean;
  /** Quitar los frenos de la cuenta (`pairAfterRecovery`, en login-throttle). */
  clearThrottles: boolean;
  /**
   * Cerrar todas las sesiones de la cuenta, también la del canje. Al completar el registro
   * con éxito no hace falta: fijar la contraseña por la API de administración ya las borró,
   * y la que sigue es la que nace al entrar.
   */
  closeSessions: boolean;
}

const FIXED_ON_REGISTRATION: PasswordOutcome = { next: "done", claimAccount: true, clearThrottles: false, closeSessions: false };
const FIXED_ON_RECOVERY: PasswordOutcome = { next: "done", claimAccount: true, clearThrottles: true, closeSessions: true };
const not = (next: PasswordOutcome["next"]): PasswordOutcome => ({
  next,
  claimAccount: false,
  clearThrottles: false,
  closeSessions: true,
});

// Una tabla y no una cadena de condiciones: se lee entera de un vistazo, y agregar un
// resultado sin decidir sus dos celdas no compila.
const OUTCOMES: Record<PasswordFlow, Record<PasswordSetResult, PasswordOutcome>> = {
  complete_registration: {
    ok: FIXED_ON_REGISTRATION,
    same_password: FIXED_ON_REGISTRATION,
    weak_password: not("recover_instead"),
    rejected: not("recover_instead"),
    unknown: not("outcome_unknown"),
  },
  recovery: {
    ok: FIXED_ON_RECOVERY,
    same_password: FIXED_ON_RECOVERY,
    weak_password: not("request_new_link"),
    rejected: not("request_new_link"),
    unknown: not("outcome_unknown"),
  },
};

export function resolvePasswordOutcome(flow: PasswordFlow, result: PasswordSetResult): PasswordOutcome {
  return OUTCOMES[flow][result];
}
