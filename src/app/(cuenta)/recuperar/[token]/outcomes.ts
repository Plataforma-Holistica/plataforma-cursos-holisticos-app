import type { RecoveryCompletion } from "@/services/account/account";
import { checkPassword } from "@/services/account/field-rules";
import { ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";

// Qué hace la pantalla que cambia la contraseña desde el enlace del correo (diseño, PA-13,
// «cambiar»; FL-06). Es una tabla pura: el servicio canjea el enlace y guarda, y esto solo
// lo traduce a un destino o a lo que la pantalla pinta. Un caso nuevo se agrega aquí, con
// su prueba.
//
// Viaja al navegador, que lo usa para revisar antes de enviar: no importa nada del servidor.

export type PasswordProblem = "too_short" | "too_long" | "malformed";

/** Lo que la pantalla pinta después de un envío. Nunca trae la contraseña. */
export type ChangePasswordState =
  | { kind: "idle" }
  | { kind: "invalid"; problem: PasswordProblem; attempt: number }
  /** No se supo. El enlace sigue sirviendo. */
  | { kind: "unavailable"; attempt: number }
  /** El enlace caducó o ya se usó. */
  | { kind: "link_dead" }
  /** El enlace se gastó y el cambio no terminó: hay que pedir otro. */
  | { kind: "request_new_link" };

const MAX_TOKEN = 256;
const MAX_PASSWORD = 1_024;

const textOf = (value: FormDataEntryValue | null, max: number): string =>
  typeof value === "string" && value.length <= max ? value : "";

/**
 * Lo que llega del formulario. Lo que no sea un formulario, o un texto de tamaño razonable,
 * cuenta como vacío. La forma de la huella la revisa la acción.
 */
export function readChangePasswordForm(form: unknown): { token: string; password: string } {
  if (!(form instanceof FormData)) return { token: "", password: "" };
  return { token: textOf(form.get("token"), MAX_TOKEN), password: textOf(form.get("password"), MAX_PASSWORD) };
}

/**
 * La regla de la contraseña, antes de enviar: una que no la cumple no le gasta el enlace a
 * nadie. La revisión que manda es la del servicio. Nulo si no hay nada que corregir.
 */
export function checkNewPassword(password: string): PasswordProblem | null {
  const checked = checkPassword(password);
  return checked.ok ? null : checked.reason;
}

export type ChangePasswordOutcome =
  /** `closeSession`: la acción cierra la sesión de este navegador antes de irse. */
  | { kind: "redirect"; to: string; notice: Notice | null; closeSession: boolean }
  | { kind: "invalid"; problem: PasswordProblem }
  | { kind: "unavailable" }
  | { kind: "link_dead" }
  | { kind: "request_new_link" };

export function completeRecoveryOutcome(result: RecoveryCompletion): ChangePasswordOutcome {
  switch (result.kind) {
    case "done":
      // No abre sesión: se cerraron todas las de esa cuenta, y la persona entra con su
      // contraseña nueva. La de este navegador también se cierra, sea de la cuenta que sea:
      // con otra cuenta abierta, la pantalla de entrar mandaría a su inicio, el aviso no se
      // vería y la persona quedaría dentro de una cuenta que no es la que acaba de recuperar.
      return { kind: "redirect", to: ROUTES.signIn, notice: "password_changed", closeSession: true };
    case "invalid":
      return { kind: "invalid", problem: result.reason };
    case "link_dead":
    case "request_new_link":
    case "unavailable":
      return { kind: result.kind };
  }
}
