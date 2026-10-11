import type { AccountCompletion, FieldErrors, LegalText, PendingAccount } from "@/services/account/account";
import { parseDisplayName } from "@/services/account/field-rules";
import { resolveDestination, ROUTES, signInPath } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import { legalBlocks } from "@/services/legal/blocks";

// Qué pinta y qué hace la pantalla que pide lo que le falta a una cuenta (diseño, PA-15;
// FL-05, paso 4). Todo aquí es puro: la guarda dice qué falta, el servicio guarda, y esto
// traduce en las dos direcciones. Un caso nuevo se agrega aquí, con su prueba.
//
// Viaja al navegador, que lo usa para revisar antes de enviar: no importa nada del servidor.

/** El tipo del consentimiento sobre el historial de cursos, que lleva su bloque explicado. */
const HISTORY_DOC_TYPE = "course_history_consent";

/** Un texto que la persona tiene que aceptar, como se pinta. */
export interface ConsentItem {
  docType: string;
  /** El texto que se pinta: es el que la persona acepta al marcar su casilla. */
  documentId: string;
  title: string;
  version: number;
  /** Desde cuándo rige, ya escrito como fecha. */
  effectiveDate: string;
  /** Dónde se lee completo, o nulo si no tiene página propia. */
  href: string | null;
  /** Los párrafos del texto, cuando se pinta completo junto a su casilla. Nulo si solo se enlaza. */
  explanation: string[] | null;
}

export interface ConsentsView {
  variant: PendingAccount["variant"];
  askName: boolean;
  askAdult: boolean;
  /** `EDAD_MINIMA`. */
  minimumAge: number;
  items: ConsentItem[];
  /** Qué textos se pintan. Cuando cambia, el formulario se arma de nuevo, sin casillas marcadas. */
  signature: string;
}

/**
 * Lo que la pantalla pide: solo lo que la guarda dijo que falta, con los textos vigentes y
 * en su orden. El historial de cursos se pinta completo junto a su casilla cuando la cuenta
 * nunca lo aceptó; cuando solo cambió una versión, cada texto va con su enlace.
 */
export function consentsView(
  pending: PendingAccount,
  facts: { texts: readonly LegalText[]; minimumAge: number },
  tools: { slugOf: (docType: string) => string | null; formatDate: (iso: string) => string },
): ConsentsView {
  const missing = new Set(pending.missing.documents.map((document) => document.docType));
  const items = facts.texts
    .filter((text) => missing.has(text.docType))
    .map((text): ConsentItem => {
      const explained = pending.variant === "complete_account" && text.docType === HISTORY_DOC_TYPE;
      const slug = tools.slugOf(text.docType);
      return {
        docType: text.docType,
        documentId: text.documentId,
        title: text.title,
        version: text.version,
        effectiveDate: tools.formatDate(text.effectiveFrom),
        href: explained || slug === null ? null : `/legal/${slug}`,
        explanation: explained
          ? legalBlocks(text.body).flatMap((block) => (block.kind === "paragraph" ? [block.text] : []))
          : null,
      };
    });
  return {
    variant: pending.variant,
    askName: pending.missing.name,
    askAdult: pending.missing.adultDeclaration,
    minimumAge: facts.minimumAge,
    items,
    signature: items.map((item) => item.documentId).join(","),
  };
}

export interface ConsentsFields {
  name?: NonNullable<FieldErrors["name"]>;
  adult?: true;
  /** Los tipos de los textos que faltó aceptar. */
  texts?: string[];
}

/** Lo que la pantalla pinta después de un envío. */
export type ConsentsState =
  | { kind: "idle" }
  | { kind: "invalid"; name: string; fields: ConsentsFields; attempt: number }
  /** La página se volvió a pintar: `texts_changed` lleva su aviso; `incomplete` solo pide lo que falte. */
  | { kind: "repainted"; reason: "texts_changed" | "incomplete"; name: string; attempt: number }
  | { kind: "unavailable"; name: string; attempt: number }
  | { kind: "suspended" };

const SHOWN = /^([a-z_]{1,64})=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Los textos de una cuenta son tres. Más que esto no es un formulario de esta pantalla. */
const MAX_ENTRIES = 20;
const MAX_NAME = 500;
const MAX_RETURN = 2_048;

const textOf = (value: FormDataEntryValue | null, max: number): string =>
  typeof value === "string" && value.length <= max ? value : "";

/** El nombre de la casilla de un texto. */
export const acceptName = (docType: string): string => `accept:${docType}`;

/** El valor del campo oculto que dice qué texto se pintó para un tipo. */
export const shownValue = (item: Pick<ConsentItem, "docType" | "documentId">): string => `${item.docType}=${item.documentId}`;

export interface ConsentsForm {
  name: string;
  adult: boolean;
  /** El destino guardado (`volver`), tal como llegó. */
  returnTo: string;
  /** Los identificadores de los textos que marcó, de entre los que se le pintaron. */
  accepted: string[];
  /** Los tipos de esos textos. */
  acceptedTypes: string[];
  /** Los tipos de los textos que se le pintaron y no marcó. */
  unchecked: string[];
}

/**
 * Lo que llega del formulario. Cada casilla marcada se convierte en el texto que la persona
 * tuvo a la vista (el que el formulario traía oculto), no en «el vigente al enviar»: si un
 * texto cambió entre tanto, el servicio lo nota y no guarda nada.
 *
 * Lo que no sea un texto, o venga desmedido, cuenta como vacío. Marcar un texto que no se
 * pintó no acepta nada.
 */
export function readConsentsForm(form: FormData): ConsentsForm {
  const shown = new Map<string, string>();
  for (const entry of form.getAll("shown").slice(0, MAX_ENTRIES)) {
    const match = SHOWN.exec(textOf(entry, 128));
    if (match?.[1] !== undefined && match[2] !== undefined) shown.set(match[1], match[2]);
  }
  // Cada casilla lleva el tipo de su texto en el nombre: `accept:terms`.
  const marked = (docType: string) => form.get(acceptName(docType)) === "on";
  const acceptedTypes = [...shown.keys()].filter(marked);
  return {
    name: textOf(form.get("name"), MAX_NAME),
    adult: form.get("adult") === "on",
    returnTo: textOf(form.get("volver"), MAX_RETURN),
    accepted: acceptedTypes.map((docType) => shown.get(docType) ?? ""),
    acceptedTypes,
    unchecked: [...shown.keys()].filter((docType) => !marked(docType)),
  };
}

/**
 * Lo que se puede revisar sin preguntarle a nadie: que venga lo que la pantalla pide. Lo usa
 * el navegador antes de enviar, para no perder lo marcado por un dato que falta. La
 * revisión que manda es la del servicio. Nulo si no hay nada que corregir.
 */
export function checkConsentsForm(
  view: Pick<ConsentsView, "askName" | "askAdult" | "items">,
  input: { name: string; adult: boolean; acceptedTypes: readonly string[] },
): ConsentsFields | null {
  const fields: ConsentsFields = {};
  if (view.askName) {
    const name = parseDisplayName(input.name);
    if (!name.ok) fields.name = name.reason;
  }
  if (view.askAdult && !input.adult) fields.adult = true;
  const texts = view.items.map((item) => item.docType).filter((docType) => !input.acceptedTypes.includes(docType));
  if (texts.length > 0) fields.texts = texts;
  return Object.keys(fields).length > 0 ? fields : null;
}

export type ConsentsOutcome =
  /** `closeSession`: la guarda dijo que esta sesión ya no vale, y la acción la cierra antes de irse. */
  | { kind: "redirect"; to: string; notice: Notice | null; closeSession: boolean }
  | { kind: "invalid"; fields: ConsentsFields }
  | { kind: "repaint"; reason: "texts_changed" | "incomplete" }
  | { kind: "suspended" }
  | { kind: "unavailable" };

/**
 * @param returnTo El destino guardado, tal como llegó: aquí se valida.
 * @param unchecked Los tipos de los textos pintados que no se marcaron: el servicio solo
 *   dice que falta alguno, y con esto la pantalla dice cuál.
 */
export function completeAccountOutcome(
  result: AccountCompletion,
  returnTo: string,
  unchecked: readonly string[],
): ConsentsOutcome {
  switch (result.kind) {
    case "complete":
      return { kind: "redirect", to: resolveDestination(returnTo), notice: null, closeSession: false };
    case "incomplete":
      return { kind: "repaint", reason: "incomplete" };
    case "texts_changed":
      return { kind: "repaint", reason: "texts_changed" };
    case "unavailable":
      return { kind: "unavailable" };
    case "invalid": {
      // Falta un texto y el formulario no sabe cuál: no es el formulario que se pintó.
      if (result.fields.texts && unchecked.length === 0) return { kind: "repaint", reason: "texts_changed" };
      const fields: ConsentsFields = {};
      if (result.fields.name) fields.name = result.fields.name;
      if (result.fields.adult) fields.adult = true;
      if (result.fields.texts) fields.texts = [...unchecked];
      return { kind: "invalid", fields };
    }
    case "session":
      switch (result.check.kind) {
        case "anonymous":
          return { kind: "redirect", to: signInPath(returnTo), notice: null, closeSession: false };
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
