import { longDate } from "@/app/_lib/dates";
import { ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type { TaxReveal, TaxSave } from "@/services/teachers/tax-data";
import type { TaxFormProblems } from "@/services/teachers/tax-rules";

// Lo que PA-48 lee del formulario y lo que hace con cada respuesta (T-409). Es puro. Ninguna respuesta lleva lo que la persona escribió: sin
// JavaScript, React manda el estado de una acción dentro de todo formulario ligado a ella.

/** Lo que trae más que esto no es un dato de nadie: cuenta como vacío. */
const MAX_FIELD = 1_000;
/** La versión que sigue tiene que caber en la fila (`smallint`). */
const MAX_SEEN = 32_766;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" && value.length <= MAX_FIELD ? value : "";
}

export function readRevealForm(form: FormData): { password: string } {
  return { password: text(form, "password") };
}

export interface TaxFormInput {
  rfc: string;
  regime: string;
  legalName: string;
  clabe: string;
  /** Nula si no tiene forma: un formulario armado a mano. */
  seen: number | null;
  password: string;
}

export function readTaxForm(form: FormData): TaxFormInput {
  const seen = text(form, "seen");
  const number = /^[0-9]{1,5}$/.test(seen) ? Number(seen) : null;
  return {
    rfc: text(form, "rfc"),
    regime: text(form, "regime"),
    legalName: text(form, "legal_name"),
    clabe: text(form, "clabe"),
    seen: number !== null && number <= MAX_SEEN ? number : null,
    password: text(form, "password"),
  };
}

export type RevealFailure = "wrong_password" | "capped" | "unavailable" | "off" | "no_profile";

export type RevealState =
  | { kind: "idle" }
  | { kind: "revealed"; data: { rfc: string; legalName: string; regime: string; clabe: string; date: string }; attempt: number }
  | { kind: "failed"; reason: RevealFailure; attempt: number }
  | { kind: "throttled"; retryAt: string; attempt: number };

export type SaveFailure = "wrong_password" | "capped" | "unavailable" | "off";

export type SaveState =
  | { kind: "idle" }
  | { kind: "invalid"; problems: TaxFormProblems; attempt: number }
  | { kind: "failed"; reason: SaveFailure; attempt: number }
  | { kind: "throttled"; retryAt: string; attempt: number };

type Leave = { kind: "leave"; to: string; notice: Notice | null; closeSession?: boolean };
type Refused = Extract<TaxReveal | TaxSave, { kind: "session" }>["check"];

/** Lo que la guarda contestó en lugar de dejar pasar. Nulo si no es para irse: «no se supo» no es «sin sesión». */
function leaveFor(check: Refused): Leave | null {
  switch (check.kind) {
    case "must_sign_out":
      return check.then === "recover"
        ? { kind: "leave", to: ROUTES.recover, notice: "choose_password", closeSession: true }
        : { kind: "leave", to: ROUTES.signIn, notice: null, closeSession: true };
    case "unavailable":
      return null;
    // Le falta algo a la cuenta, o no hay sesión: la guarda de la página decide.
    default:
      return { kind: "leave", to: ROUTES.portal, notice: null };
  }
}

export function revealOutcome(result: TaxReveal, attempt: number): Leave | { kind: "repaint"; state: RevealState } {
  const failed = (reason: RevealFailure) => ({ kind: "repaint", state: { kind: "failed", reason, attempt } }) as const;
  switch (result.kind) {
    case "revealed": {
      const { updatedAt, ...shown } = result.data;
      return { kind: "repaint", state: { kind: "revealed", data: { ...shown, date: longDate(updatedAt) }, attempt } };
    }
    case "throttled":
      return { kind: "repaint", state: { kind: "throttled", retryAt: result.retryAt.toISOString(), attempt } };
    case "not_teacher":
      return { kind: "leave", to: ROUTES.portal, notice: null };
    case "session":
      return leaveFor(result.check) ?? failed("unavailable");
    default:
      return failed(result.kind);
  }
}

/** A dónde va un formulario cuya versión vista ya no es: a cambiar con la de ahora, con el aviso. Lo escrito no vuelve: pisaría sin saberlo. */
export const changedElsewhere: Leave = { kind: "leave", to: `${ROUTES.portalTaxData}?cambiar=1`, notice: "tax_data_changed" };

export function saveOutcome(result: TaxSave, attempt: number): Leave | { kind: "repaint"; state: SaveState } {
  const failed = (reason: SaveFailure) => ({ kind: "repaint", state: { kind: "failed", reason, attempt } }) as const;
  switch (result.kind) {
    // Sin ningún dato en la respuesta, y sin un formulario que reenviar al recargar.
    case "saved":
      return { kind: "leave", to: ROUTES.portalTaxData, notice: "tax_data_saved" };
    case "invalid":
      return { kind: "repaint", state: { kind: "invalid", problems: result.problems, attempt } };
    case "throttled":
      return { kind: "repaint", state: { kind: "throttled", retryAt: result.retryAt.toISOString(), attempt } };
    case "not_teacher":
      return { kind: "leave", to: ROUTES.portal, notice: null };
    case "session":
      return leaveFor(result.check) ?? failed("unavailable");
    // En una primera captura, ya con datos, la pantalla pinta otra cosa: un aviso en este bloque no lo vería nadie.
    case "changed":
      return changedElsewhere;
    // La franja ya estaba: sin este aviso, parecería que no pasó nada. No dice por qué: de eso le avisa el equipo.
    case "suspended":
      return { kind: "leave", to: ROUTES.portalTaxData, notice: "tax_data_locked" };
    default:
      return failed(result.kind);
  }
}
