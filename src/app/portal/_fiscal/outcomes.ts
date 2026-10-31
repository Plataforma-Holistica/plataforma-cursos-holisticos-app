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

export type SaveFailure = "wrong_password" | "capped" | "unavailable" | "off" | "changed" | "suspended";

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

export function saveOutcome(result: TaxSave, attempt: number): Leave | { kind: "repaint"; refresh: boolean; state: SaveState } {
  const failed = (reason: SaveFailure, refresh = false) => ({ kind: "repaint", refresh, state: { kind: "failed", reason, attempt } }) as const;
  switch (result.kind) {
    // Sin ningún dato en la respuesta, y sin un formulario que reenviar al recargar.
    case "saved":
      return { kind: "leave", to: ROUTES.portalTaxData, notice: "tax_data_saved" };
    case "invalid":
      return { kind: "repaint", refresh: false, state: { kind: "invalid", problems: result.problems, attempt } };
    case "throttled":
      return { kind: "repaint", refresh: false, state: { kind: "throttled", retryAt: result.retryAt.toISOString(), attempt } };
    case "not_teacher":
      return { kind: "leave", to: ROUTES.portal, notice: null };
    case "session":
      return leaveFor(result.check) ?? failed("unavailable");
    // La página lleva la versión vista, y la franja de solo lectura: las dos cambiaron.
    case "changed":
    case "suspended":
      return failed(result.kind, true);
    default:
      return failed(result.kind);
  }
}
