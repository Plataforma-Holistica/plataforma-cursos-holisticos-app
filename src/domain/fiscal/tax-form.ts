import { parseClabe } from "./clabe";
import { acceptsPayee, taxRegimeOf, type TaxRegime } from "./regime";
import { parseRfc, type PayeeKind } from "./rfc";

// El formulario de los datos fiscales del maestro (PA-48; RF-510), revisado entero, y lo que se muestra de un dato ya guardado. El tipo de
// persona no se pregunta: lo dice el largo del RFC.

/** El `Nombre` del receptor en el CFDI 4.0 llega a 300 caracteres. */
export const LEGAL_NAME_MAX_LENGTH = 300;

export type LegalNameResult = { ok: true; name: string } | { ok: false; reason: "empty" | "long" | "form" };

/** Los caracteres de control y de formato: no se ven, y con ellos dos razones sociales iguales se leerían distinto. */
const UNSEEN = /[\p{Cc}\p{Cf}]/u;

export function parseLegalName(input: string): LegalNameResult {
  const spaced = input.normalize("NFC").replace(/[\t\n\r ]/g, " ");
  if (UNSEEN.test(spaced)) return { ok: false, reason: "form" };
  const name = spaced.trim().replace(/ {2,}/g, " ");
  if (name === "") return { ok: false, reason: "empty" };
  if ([...name].length > LEGAL_NAME_MAX_LENGTH) return { ok: false, reason: "long" };
  return { ok: true, name };
}

export type TaxFormField = "rfc" | "regime" | "legalName" | "clabe";
export type TaxFormProblem = "required" | "form" | "date" | "generic" | "long" | "length" | "check_digit" | "payee";
export type TaxFormProblems = Partial<Record<TaxFormField, TaxFormProblem>>;

export interface TaxFormValue {
  rfc: string;
  payee: PayeeKind;
  regime: TaxRegime;
  legalName: string;
  clabe: string;
  last4: string;
}

export type TaxFormCheck = { ok: true; value: TaxFormValue } | { ok: false; problems: TaxFormProblems };

export function checkTaxForm(input: { rfc: string; regime: string; legalName: string; clabe: string }): TaxFormCheck {
  const problems: TaxFormProblems = {};
  const rfc = parseRfc(input.rfc);
  if (!rfc.ok) problems.rfc = rfc.reason === "empty" ? "required" : rfc.reason;
  const regime = taxRegimeOf(input.regime);
  if (input.regime === "") problems.regime = "required";
  else if (regime === null) problems.regime = "form";
  // Con el RFC malo no se sabe de qué tipo de persona es: no se le puede decir que el régimen no le toca.
  else if (rfc.ok && !acceptsPayee(regime, rfc.kind)) problems.regime = "payee";
  const name = parseLegalName(input.legalName);
  if (!name.ok) problems.legalName = name.reason === "empty" ? "required" : name.reason;
  const clabe = parseClabe(input.clabe);
  if (!clabe.ok) problems.clabe = clabe.reason === "empty" ? "required" : clabe.reason;

  if (!rfc.ok || regime === null || !name.ok || !clabe.ok || problems.regime !== undefined) return { ok: false, problems };
  return { ok: true, value: { rfc: rfc.rfc, payee: rfc.kind, regime, legalName: name.name, clabe: clabe.clabe, last4: clabe.last4 } };
}

const TAIL = 4;

/** Los últimos cuatro caracteres. Un dato de cuatro o menos se vería entero: no se muestra. */
export function maskTail(value: string): string {
  const characters = [...value];
  return characters.length <= TAIL ? "••••" : `•••• ${characters.slice(-TAIL).join("")}`;
}
