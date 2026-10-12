import type { NameChange } from "@/services/account/account";
import { parseDisplayName } from "@/services/account/field-rules";
import { consentsPath, ROUTES, signInPath } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";

// Qué pinta y qué hace la pantalla de la cuenta (diseño, PA-25; FL-27). Todo aquí es puro:
// el servicio corre la guarda y guarda, y esto traduce su respuesta a un destino o a lo que
// se pinta. Un caso nuevo se agrega aquí, con su prueba.
//
// Viaja al navegador, que lo usa para revisar antes de enviar: no importa nada del servidor.

export type NameProblem = Extract<NameChange, { kind: "invalid" }>["reason"];

/** Lo que el bloque del nombre pinta después de un envío. */
export type NameState =
  | { kind: "idle" }
  | { kind: "invalid"; name: string; problem: NameProblem; attempt: number }
  /** `name`: como quedó guardado, sin espacios en los extremos. */
  | { kind: "saved"; name: string; attempt: number }
  | { kind: "unavailable"; name: string; attempt: number }
  | { kind: "suspended" };

const MAX_NAME = 500;

/**
 * Lo que llega del formulario del nombre. Lo que no sea un texto, o venga desmedido, cuenta
 * como vacío. De quién es la cuenta no se lee de aquí: lo dice la sesión.
 */
export function readNameForm(form: unknown): { name: string } {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { name: "" };
  const value = form.get("name");
  return { name: typeof value === "string" && value.length <= MAX_NAME ? value : "" };
}

/**
 * Lo que se puede revisar sin preguntarle a nadie. Lo usa el navegador antes de enviar; la
 * revisión que manda es la del servicio, con la misma regla. Nulo si no hay nada que corregir.
 */
export function checkNameForm(input: { name: string }): NameProblem | null {
  const parsed = parseDisplayName(input.name);
  return parsed.ok ? null : parsed.reason;
}

export type NameOutcome =
  /** `closeSession`: la guarda dijo que esta sesión ya no vale, y la acción la cierra antes de irse. */
  | { kind: "redirect"; to: string; notice: Notice | null; closeSession: boolean }
  | { kind: "saved"; name: string }
  | { kind: "invalid"; problem: NameProblem }
  | { kind: "suspended" }
  | { kind: "unavailable" };

export function changeNameOutcome(result: NameChange): NameOutcome {
  switch (result.kind) {
    case "saved":
      return { kind: "saved", name: result.name };
    case "invalid":
      return { kind: "invalid", problem: result.reason };
    case "unavailable":
      return { kind: "unavailable" };
    case "session":
      switch (result.check.kind) {
        case "anonymous":
          return { kind: "redirect", to: signInPath(ROUTES.account), notice: null, closeSession: false };
        case "incomplete":
          // A la cuenta le falta algo: lo pide su pantalla, y después se vuelve aquí.
          return { kind: "redirect", to: consentsPath(ROUTES.account), notice: null, closeSession: false };
        case "suspended":
          return { kind: "suspended" };
        case "unavailable":
          return { kind: "unavailable" };
        case "must_sign_out":
          return result.check.then === "recover"
            ? { kind: "redirect", to: ROUTES.recover, notice: "choose_password", closeSession: true }
            : { kind: "redirect", to: ROUTES.signIn, notice: null, closeSession: true };
      }
  }
}
