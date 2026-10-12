import type { MailRequestResult } from "@/services/account/account";
import { parseEmail } from "@/services/account/field-rules";

// Pedir un correo: el de registro (PA-10, y «Reenviar» en PA-14) y el de recuperación
// (PA-13). Los tres formularios mandan lo mismo, un correo, y el servicio contesta lo mismo
// en los tres: por eso su tabla es una sola. Es pura, con su prueba.
//
// Lo que se le dice a quien pide no depende de si ese correo tiene cuenta. `accepted` es
// «si ese correo puede recibirlo, ya va en camino», se haya mandado algo o no.

const MAX_EMAIL = 320;

/**
 * Lo que llega del formulario. Una acción de servidor es una puerta pública: lo que no sea
 * un formulario, o no traiga un texto de tamaño razonable, cuenta como vacío.
 */
export function readEmailForm(form: unknown): { email: string } {
  if (!(form instanceof FormData)) return { email: "" };
  const value = form.get("email");
  return { email: typeof value === "string" && value.length <= MAX_EMAIL ? value : "" };
}

export type EmailField = "required" | "invalid";

/** Lo que se puede revisar sin preguntarle a nadie. Nulo si no hay nada que corregir. */
export function checkEmailField(email: string): EmailField | null {
  if (email.trim() === "") return "required";
  return parseEmail(email).ok ? null : "invalid";
}

/** Lo que pinta un formulario que pide un correo, después de un envío. */
export type MailRequestState =
  | { kind: "idle" }
  | { kind: "invalid"; email: string; field: EmailField; attempt: number }
  /** `wait`: el tope por dirección, el único que se dice. `unavailable`: no se supo. */
  | { kind: "failed"; email: string; reason: "wait" | "unavailable"; attempt: number }
  /**
   * El mismo mensaje exista o no la cuenta, y se haya mandado algo o no. `lifetimeSeconds`:
   * lo que dura un enlace (`VIGENCIA_ENLACE_CONTRASENA`), o nulo si no se supo.
   */
  | { kind: "sent"; lifetimeSeconds: number | null; attempt: number };

export type MailRequestOutcome =
  | { kind: "accepted" }
  | { kind: "invalid"; field: "invalid" }
  | { kind: "failed"; reason: "wait" | "unavailable" };

export function mailRequestOutcome(result: MailRequestResult): MailRequestOutcome {
  switch (result.kind) {
    case "accepted":
      return { kind: "accepted" };
    case "invalid_email":
      return { kind: "invalid", field: "invalid" };
    case "wait":
    case "unavailable":
      return { kind: "failed", reason: result.kind };
  }
}
