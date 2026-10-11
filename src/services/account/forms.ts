import "server-only";

import { parseDisplayName, type DisplayNameResult } from "@/domain/access/display-name";
import { checkPassword, type PasswordCheck } from "@/domain/access/password-policy";

// Lo que mandan los formularios de la cuenta, revisado antes de tocar nada (RF-101, RF-108,
// RF-109; TRD §9.2, fila «Verificación de correo»; flujo de la app FL-03 y FL-06).
//
// Todo aquí es puro. Va antes de canjear el enlace del correo: un dato mal escrito o un
// texto que cambió mientras la persona leía no le gasta el enlace a nadie.

/** Lo que se sabe del texto vigente de un tipo obligatorio. Sin texto vigente, todo nulo. */
export interface CurrentText {
  docType: string;
  documentId: string | null;
  version: number | null;
  title: string | null;
}

export interface FieldErrors {
  name?: Extract<DisplayNameResult, { ok: false }>["reason"];
  password?: Extract<PasswordCheck, { ok: false }>["reason"];
  adult?: "required";
  /** Falta aceptar alguno de los textos. */
  texts?: "required";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AcceptedMatch =
  /** `documentIds`: lo aceptado, sin repetir. Todos son textos vigentes. */
  | { kind: "ok"; documentIds: string[] }
  /** Falta aceptar alguno de los que hacen falta. */
  | { kind: "missing" }
  /** Lo aceptado no es lo vigente: el texto cambió, o el formulario no es el que se mostró. */
  | { kind: "stale" }
  /** Un tipo que hace falta no tiene texto vigente: no hay qué aceptar. */
  | { kind: "unavailable" };

/**
 * Compara lo que la persona aceptó con los textos vigentes. `needed` son los tipos que le
 * hacen falta a esta cuenta; `accepted`, los identificadores de los textos que marcó, que
 * son los que el formulario le mostró.
 *
 * Aceptar un texto que ya no es el vigente no vale como aceptar el nuevo: se le vuelve a
 * mostrar. Aceptar de más uno vigente no estorba.
 */
export function matchAccepted(
  current: readonly CurrentText[],
  needed: readonly string[],
  accepted: readonly string[],
): AcceptedMatch {
  const needs: string[] = [];
  for (const docType of needed) {
    const id = current.find((text) => text.docType === docType)?.documentId ?? null;
    if (id === null) return { kind: "unavailable" };
    needs.push(id);
  }
  const inForce = new Set(current.map((text) => text.documentId));
  const given = [...new Set(accepted.map((id) => id.toLowerCase()))];
  if (given.some((id) => !UUID.test(id) || !inForce.has(id))) return { kind: "stale" };
  if (needs.some((id) => !given.includes(id))) return { kind: "missing" };
  return { kind: "ok", documentIds: given };
}

export interface RegistrationForm {
  name: string;
  password: string;
  /** La persona declaró tener la edad mínima (`EDAD_MINIMA`). */
  adultDeclared: boolean;
  /** Los identificadores de los textos que marcó. */
  accepted: readonly string[];
}

export type RegistrationCheck =
  | { ok: true; /** Sin espacios en los extremos. */ name: string; /** Tal cual se escribió. */ password: string }
  | { ok: false; fields: FieldErrors };

/** El formulario que completa el registro (PA-14), sin mirar todavía qué textos rigen. */
export function checkRegistrationForm(form: RegistrationForm): RegistrationCheck {
  const fields: FieldErrors = {};
  const name = parseDisplayName(form.name);
  if (!name.ok) fields.name = name.reason;
  const password = checkPassword(form.password);
  if (!password.ok) fields.password = password.reason;
  if (form.adultDeclared !== true) fields.adult = "required";
  if (form.accepted.length === 0) fields.texts = "required";
  if (!name.ok || Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, name: name.name, password: form.password };
}

export interface AccountForm {
  name?: string | null;
  adultDeclared?: boolean;
  accepted: readonly string[];
}

export type AccountCheck =
  | { ok: true; /** El nombre a guardar, o nulo si no hacía falta. */ name: string | null; /** Guardar la edad. */ adult: boolean }
  | { ok: false; fields: FieldErrors };

/**
 * El formulario que completa una cuenta ya abierta (PA-15). Solo revisa lo que a esta
 * cuenta le falta; lo demás se ignora, venga como venga.
 */
export function checkAccountForm(
  missing: { name: boolean; adultDeclaration: boolean },
  form: AccountForm,
): AccountCheck {
  const fields: FieldErrors = {};
  let name: string | null = null;
  if (missing.name) {
    const parsed = parseDisplayName(form.name ?? null);
    if (parsed.ok) name = parsed.name;
    else fields.name = parsed.reason;
  }
  if (missing.adultDeclaration && form.adultDeclared !== true) fields.adult = "required";
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, name, adult: missing.adultDeclaration };
}
