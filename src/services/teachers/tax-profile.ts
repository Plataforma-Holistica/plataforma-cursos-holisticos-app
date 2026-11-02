import "server-only";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { PayeeKind } from "@/domain/fiscal/rfc";
import { checkTaxForm, maskTail, type TaxFormProblems } from "@/domain/fiscal/tax-form";
import type { SessionCheck } from "@/services/account/admission";
import type { PasswordConfirmation } from "@/services/account/management";
import type { RequestOrigin } from "@/services/account/origin";
import type { FailureCode } from "@/services/error-reporting/server";

import type { TeacherStanding } from "./standing";
import type { SealedField, TaxFieldContext } from "./tax-cipher";

// Los datos fiscales y bancarios del maestro (PA-48, FL-31, RF-510). Aquí se decide qué se pide y en qué orden; quién puede y qué queda en
// la auditoría lo decide la base. Tres reglas: la contraseña va en el mismo envío, sin un estado de «ya la dio»; lo cifrado se abre aquí,
// con la transacción ya confirmada; y al maestro no le vuelve nada entero, ni lo que acaba de escribir.

type Refused = Exclude<SessionCheck, { kind: "pass" }>;

export type PasswordCheck = PasswordConfirmation;

/** Una fila, tal como la deja la base: lo cifrado sigue cifrado. */
export interface TaxProfileRow {
  teacherId: string;
  version: number;
  regime: string;
  payee: PayeeKind;
  last4: string;
  updatedAt: string;
  rfc: Buffer;
  legalName: Buffer;
  clabe: Buffer;
}

/** Lo que se le pide guardar a la base. */
export interface TaxProfileSeal {
  teacher: string;
  seen: number;
  regime: string;
  payee: PayeeKind;
  last4: string;
  keyVersion: number;
  rfc: SealedField;
  legalName: SealedField;
  clabe: SealedField;
  /** Si la CLABE escrita es otra que la vigente: la base no las puede comparar. Cierto si no se supo. */
  clabeChanged: boolean;
}

export type TaxSaveAnswer = "saved" | "changed" | "invalid" | "not_teacher" | "suspended" | "needs_notice";
export type TaxReadAnswer = { outcome: "ok"; row: TaxProfileRow } | { outcome: "no_profile" | "not_teacher" };
export type TaxPayoutAnswer =
  | { outcome: "ok"; row: TaxProfileRow }
  | { outcome: "clabe_waiting"; until: string }
  | { outcome: "forbidden" | "needs_fresh_code" | "not_found" | "self" | "no_profile" | "clabe_held" | "clabe_recapture" };

export interface TaxProfileState {
  version: number;
  updatedAt: string | null;
  /** Falso solo con el fraude confirmado: un suspendido por otra causa sí los captura (decisión de Sergio del 2026-11-01). */
  canSave: boolean;
  /** Desde cuándo rige una CLABE que todavía espera (decisión de Sergio del 2026-11-01). Con una propuesta de fraude pendiente dice lo mismo que sin ella. */
  clabeWaitsUntil: string | null;
  /** El último cambio de CLABE quedó anulado, y hay que volver a escribirla. */
  clabeRecapture: boolean;
}

export interface TaxStore {
  /** Si ya los capturó, qué versión tiene y si puede guardar, sin lo cifrado. Nulo si no es maestro. */
  state: (claims: VerifiedClaims) => Promise<TaxProfileState | null>;
  mine: (claims: VerifiedClaims) => Promise<TaxReadAnswer>;
  save: (claims: VerifiedClaims, row: TaxProfileSeal) => Promise<TaxSaveAnswer>;
  forPayout: (claims: VerifiedClaims, payout: string) => Promise<TaxPayoutAnswer>;
}

export interface TaxProfileDeps {
  store: TaxStore;
  cipher: {
    available: () => boolean;
    activeVersion: () => number;
    seal: (context: TaxFieldContext, text: string) => SealedField;
    open: (context: TaxFieldContext, sealed: Buffer) => string;
  };
  confirmPassword: (jar: CookieJar, password: string, origin: RequestOrigin) => Promise<PasswordCheck>;
  standing: (claims: VerifiedClaims) => Promise<TeacherStanding>;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
}

/** Lo que el maestro ve de lo suyo: los últimos cuatro de cada dato, ya en el servidor. */
export interface MaskedTaxProfile {
  rfc: string;
  legalName: string;
  regime: string;
  clabe: string;
  updatedAt: string;
}

/** Lo que finanzas ve, por una liquidación: con esto se paga (T-604). */
export interface OpenTaxProfile {
  rfc: string;
  legalName: string;
  regime: string;
  payee: PayeeKind;
  clabe: string;
  version: number;
  updatedAt: string;
}

type Proof = Exclude<PasswordCheck, { kind: "confirmed" | "wrong" }> | { kind: "wrong_password" };

export type TaxReveal = Proof | { kind: "revealed"; data: MaskedTaxProfile } | { kind: "off" | "no_profile" | "not_teacher" };
export type TaxSave = Proof | { kind: "saved" | "off" | "changed" | "suspended" | "not_teacher" } | { kind: "invalid"; problems: TaxFormProblems };
export type TaxPayoutRead =
  | { kind: "ok"; data: OpenTaxProfile }
  | { kind: "clabe_waiting"; until: string }
  | { kind: "forbidden" | "needs_fresh_code" | "not_found" | "self" | "no_profile" | "clabe_held" | "clabe_recapture" | "off" | "unavailable" }
  | { kind: "session"; check: Refused };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createTaxProfile(deps: TaxProfileDeps) {
  const { store, cipher, report } = deps;

  async function cipherIsOff(): Promise<boolean> {
    if (cipher.available()) return false;
    await report("tax_cipher_unavailable");
    return true;
  }

  /** Abre una fila, o nulo si no abre (otra llave, algo manipulado): nunca devuelve otra cosa. */
  function openRow(row: TaxProfileRow): Pick<OpenTaxProfile, "rfc" | "legalName" | "clabe"> | null {
    const at = { teacher: row.teacherId, rowVersion: row.version };
    try {
      return {
        rfc: cipher.open({ ...at, field: "rfc" }, row.rfc),
        legalName: cipher.open({ ...at, field: "legal_name" }, row.legalName),
        clabe: cipher.open({ ...at, field: "clabe", last4: row.last4 }, row.clabe),
      };
    } catch {
      return null;
    }
  }

  /**
   * Si la CLABE escrita es otra que la vigente: lo cifrado no se repite, así que hay que abrirla. Esa lectura queda en la auditoría, como cualquiera. Falla cerrado: lo que no
   * abre cuenta como cambio, y empieza la espera. Se compara lo abierto, así que rotar la llave no reinicia nada.
   */
  async function clabeDiffers(claims: VerifiedClaims, seen: number, clabe: string): Promise<boolean> {
    if (seen === 0) return true;
    const current = await store.mine(claims);
    if (current.outcome !== "ok" || current.row.version !== seen) return true;
    const open = openRow(current.row);
    if (open === null) {
      await report("tax_profile_unreadable");
      return true;
    }
    return open.clabe !== clabe;
  }

  /** Si ya los capturó y qué versión tiene, para la pantalla que ya pasó la guarda. Nulo si no se supo. */
  async function taxProfileState(claims: VerifiedClaims): Promise<TaxProfileState | null> {
    try {
      return await store.state(claims);
    } catch {
      await report("tax_profile_unavailable");
      return null;
    }
  }

  /** Ver lo guardado: primero la contraseña, y después la lectura, que queda en la auditoría aunque aquí no se pueda abrir. */
  async function revealTaxProfile(jar: CookieJar, password: string, origin: RequestOrigin): Promise<TaxReveal> {
    if (await cipherIsOff()) return { kind: "off" };
    if (password === "") return { kind: "wrong_password" };
    const proof = await deps.confirmPassword(jar, password, origin);
    if (proof.kind === "wrong") return { kind: "wrong_password" };
    if (proof.kind !== "confirmed") return proof;
    let answer: TaxReadAnswer;
    try {
      answer = await store.mine(proof.claims);
    } catch {
      await report("tax_profile_unavailable");
      return { kind: "unavailable" };
    }
    if (answer.outcome !== "ok") return { kind: answer.outcome };
    const open = openRow(answer.row);
    if (open === null) {
      await report("tax_profile_unreadable");
      return { kind: "unavailable" };
    }
    return {
      kind: "revealed",
      data: { rfc: maskTail(open.rfc), legalName: maskTail(open.legalName), regime: answer.row.regime, clabe: maskTail(open.clabe), updatedAt: answer.row.updatedAt },
    };
  }

  /**
   * Guardar una versión nueva. Lo escrito se revisa antes de la contraseña: un error de forma no cuenta como intento. `seen` es la versión
   * que el maestro tenía a la vista, y la que sigue entra a los datos asociados; si ya no es esa, la base contesta `changed`.
   */
  async function saveTaxProfile(
    jar: CookieJar,
    input: { rfc: string; regime: string; legalName: string; clabe: string; seen: number; password: string },
    origin: RequestOrigin,
  ): Promise<TaxSave> {
    if (await cipherIsOff()) return { kind: "off" };
    const form = checkTaxForm(input);
    if (!form.ok) return { kind: "invalid", problems: form.problems };
    if (input.password === "") return { kind: "wrong_password" };
    const proof = await deps.confirmPassword(jar, input.password, origin);
    if (proof.kind === "wrong") return { kind: "wrong_password" };
    if (proof.kind !== "confirmed") return proof;

    let answer: TaxSaveAnswer;
    try {
      const standing = await deps.standing(proof.claims);
      // El suspendido llega a la base: ella sabe si fue por fraude, y el servicio no lo lee.
      if (standing.state !== "active" && standing.state !== "suspended") return { kind: "not_teacher" };
      const { value } = form;
      const at = { teacher: standing.teacher.id, rowVersion: input.seen + 1 };
      const clabeChanged = await clabeDiffers(proof.claims, input.seen, value.clabe);
      answer = await store.save(proof.claims, {
        teacher: standing.teacher.id,
        seen: input.seen,
        regime: value.regime,
        payee: value.payee,
        last4: value.last4,
        keyVersion: cipher.activeVersion(),
        rfc: cipher.seal({ ...at, field: "rfc" }, value.rfc),
        legalName: cipher.seal({ ...at, field: "legal_name" }, value.legalName),
        clabe: cipher.seal({ ...at, field: "clabe", last4: value.last4 }, value.clabe),
        clabeChanged,
      });
    } catch {
      await report("tax_profile_unavailable");
      return { kind: "unavailable" };
    }
    switch (answer) {
      case "saved":
      case "changed":
      case "suspended":
        return { kind: answer };
      case "not_teacher":
      case "needs_notice":
        return { kind: "not_teacher" };
      // La aplicación selló lo que la base no reconoce: es una falla de código, no algo que el maestro pueda arreglar.
      case "invalid":
        await report("tax_profile_unavailable");
        return { kind: "unavailable" };
    }
  }

  /** Lo que finanzas lee, por una liquidación y nunca por un maestro (T-604). La puerta y la auditoría son de la base. */
  async function taxProfileForPayout(reader: CookieReader, payout: string): Promise<TaxPayoutRead> {
    if (!ID.test(payout)) return { kind: "not_found" };
    if (await cipherIsOff()) return { kind: "off" };
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };
    let answer: TaxPayoutAnswer;
    try {
      answer = await store.forPayout(check.claims, payout);
    } catch {
      await report("tax_profile_unavailable");
      return { kind: "unavailable" };
    }
    if (answer.outcome === "clabe_waiting") return { kind: "clabe_waiting", until: answer.until };
    if (answer.outcome !== "ok") return { kind: answer.outcome };
    const open = openRow(answer.row);
    if (open === null) {
      await report("tax_profile_unreadable");
      return { kind: "unavailable" };
    }
    const { regime, payee, version, updatedAt } = answer.row;
    return { kind: "ok", data: { ...open, regime, payee, version, updatedAt } };
  }

  /** Si hay con qué abrir y sellar: sin llave la pantalla lo dice antes de pedir nada, y se reporta. */
  const taxDataReady = async (): Promise<boolean> => !(await cipherIsOff());

  return { taxDataReady, taxProfileState, revealTaxProfile, saveTaxProfile, taxProfileForPayout };
}
