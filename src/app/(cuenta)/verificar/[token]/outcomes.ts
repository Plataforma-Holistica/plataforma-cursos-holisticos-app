import type { FieldErrors, LegalText, RegistrationCompletion } from "@/services/account/account";
import { checkPassword, parseDisplayName } from "@/services/account/field-rules";
import { consentsPath, entryDestination, ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import { legalBlocks } from "@/services/legal/blocks";

import { acceptName, readShown, type ConsentItem } from "../../consentimientos/outcomes";

// Qué pinta y qué hace la pantalla que completa una cuenta desde el enlace del correo
// (diseño, PA-14, variante «Completa tu cuenta»; FL-03). Todo aquí es puro: el servicio
// canjea el enlace y guarda, y esto traduce en las dos direcciones. Un caso nuevo se agrega
// aquí, con su prueba.
//
// Viaja al navegador, que lo usa para revisar antes de enviar: no importa nada del servidor.

const HISTORY_DOC_TYPE = "course_history_consent";
/** Los dos textos que se aceptan juntos, con una sola casilla (diseño, PA-14). */
const PAIRED_DOC_TYPES: readonly string[] = ["terms", "student_privacy_notice"];

/** El nombre de la casilla que acepta juntos los Términos y el Aviso de privacidad. */
export const LEGAL_BOX = "accept:legal";

/**
 * La casilla con la que se acepta cada texto pintado. Términos y Aviso comparten la suya
 * solo cuando están los dos: su frase los nombra a ambos, y con uno solo afirmaría aceptar
 * un texto que no se pintó.
 */
export function boxesOf(docTypes: readonly string[]): Map<string, string> {
  const paired = PAIRED_DOC_TYPES.every((docType) => docTypes.includes(docType));
  return new Map(
    docTypes.map((docType) => [docType, paired && PAIRED_DOC_TYPES.includes(docType) ? LEGAL_BOX : acceptName(docType)]),
  );
}

/** Una casilla y los textos que acepta. */
export interface ConsentBox {
  name: string;
  /** `legal`: Términos y Aviso, juntos. `history`: el bloque explicado. `other`: un texto con su propia casilla. */
  kind: "legal" | "history" | "other";
  items: ConsentItem[];
}

export interface CompleteView {
  /** `EDAD_MINIMA`. */
  minimumAge: number;
  boxes: ConsentBox[];
  /** Los textos que se pintan, para los campos ocultos. */
  items: ConsentItem[];
  /** Qué textos se pintan. Cuando cambia, el formulario se arma de nuevo, sin casillas marcadas. */
  signature: string;
}

/**
 * Lo que la pantalla pide: todos los textos vigentes de una cuenta, en su orden. Términos y
 * Aviso comparten casilla; el historial de cursos se pinta completo junto a la suya. Un
 * texto obligatorio que no sea ninguno de esos lleva su propia casilla: no se le esconde a
 * nadie un texto que el servicio va a exigir.
 */
export function completeView(
  facts: { texts: readonly LegalText[]; minimumAge: number },
  tools: { slugOf: (docType: string) => string | null; formatDate: (iso: string) => string },
): CompleteView {
  const items = facts.texts.map((text): ConsentItem => {
    const slug = tools.slugOf(text.docType);
    return {
      docType: text.docType,
      documentId: text.documentId,
      title: text.title,
      version: text.version,
      effectiveDate: tools.formatDate(text.effectiveFrom),
      // Con la versión que aquí se anuncia: la página no enseña una más vieja.
      href: slug === null ? null : `/legal/${slug}?v=${text.version}`,
      explanation:
        text.docType === HISTORY_DOC_TYPE
          ? legalBlocks(text.body).flatMap((block) => (block.kind === "paragraph" ? [block.text] : []))
          : null,
    };
  });
  const names = boxesOf(items.map((item) => item.docType));
  const boxes: ConsentBox[] = [];
  for (const item of items) {
    const name = names.get(item.docType) ?? acceptName(item.docType);
    const box = boxes.find((candidate) => candidate.name === name);
    if (box) box.items.push(item);
    else {
      const kind = name === LEGAL_BOX ? "legal" : item.docType === HISTORY_DOC_TYPE ? "history" : "other";
      boxes.push({ name, kind, items: [item] });
    }
  }
  return { minimumAge: facts.minimumAge, boxes, items, signature: items.map((item) => item.documentId).join(",") };
}

export interface CompleteFields {
  name?: NonNullable<FieldErrors["name"]>;
  password?: NonNullable<FieldErrors["password"]>;
  adult?: true;
  /** Los nombres de las casillas que faltó marcar. */
  boxes?: string[];
}

/** Lo que la pantalla pinta después de un envío. Nunca trae la contraseña. */
export type CompleteState =
  | { kind: "idle" }
  | { kind: "invalid"; name: string; fields: CompleteFields; attempt: number }
  /** Un texto cambió mientras se llenaba: la página se volvió a pintar con los vigentes. */
  | { kind: "repainted"; name: string; attempt: number }
  /** No se supo. El enlace sigue sirviendo. */
  | { kind: "unavailable"; name: string; attempt: number }
  /** Falta el texto vigente de un tipo obligatorio. */
  | { kind: "texts_unavailable" }
  /** El enlace caducó o ya se usó. */
  | { kind: "link_dead" }
  /** El enlace se gastó y la cuenta no quedó lista: se sale por recuperar la contraseña. */
  | { kind: "recover_instead" };

const MAX_TOKEN = 256;
const MAX_NAME = 500;
const MAX_PASSWORD = 1_024;

const textOf = (value: FormDataEntryValue | null, max: number): string =>
  typeof value === "string" && value.length <= max ? value : "";

export interface CompleteForm {
  /** La huella del enlace, tal como llegó: su forma la revisa la acción. */
  token: string;
  name: string;
  password: string;
  adult: boolean;
  /** Los identificadores de los textos cuya casilla marcó, de entre los que se le pintaron. */
  accepted: string[];
  /** Los nombres de las casillas pintadas que marcó. */
  marked: string[];
  /** Los nombres de las casillas pintadas que no marcó. */
  unchecked: string[];
}

/**
 * Lo que llega del formulario. Cada casilla marcada se convierte en los textos que la
 * persona tuvo a la vista (los que el formulario traía ocultos), no en «los vigentes al
 * enviar»: si un texto cambió entre tanto, el servicio lo nota y no canjea el enlace.
 *
 * Lo que no sea un formulario, o un texto de tamaño razonable, cuenta como vacío. Marcar
 * una casilla de un texto que no se pintó no acepta nada.
 */
export function readCompleteForm(form: unknown): CompleteForm {
  if (!(form instanceof FormData)) {
    return { token: "", name: "", password: "", adult: false, accepted: [], marked: [], unchecked: [] };
  }
  const shown = readShown(form);
  const names = boxesOf([...shown.keys()]);
  const boxes = [...new Set(names.values())];
  const isMarked = (box: string | undefined) => box !== undefined && form.get(box) === "on";
  return {
    token: textOf(form.get("token"), MAX_TOKEN),
    name: textOf(form.get("name"), MAX_NAME),
    password: textOf(form.get("password"), MAX_PASSWORD),
    adult: form.get("adult") === "on",
    accepted: [...shown].filter(([docType]) => isMarked(names.get(docType))).map(([, documentId]) => documentId),
    marked: boxes.filter(isMarked),
    unchecked: boxes.filter((box) => !isMarked(box)),
  };
}

/**
 * Lo que se puede revisar sin preguntarle a nadie. Lo usa el navegador antes de enviar,
 * para no perder lo escrito ni lo marcado por un dato que falta. La revisión que manda es
 * la del servicio, que la repite antes de canjear el enlace. Nulo si no hay nada que corregir.
 */
export function checkCompleteForm(
  view: Pick<CompleteView, "boxes">,
  input: { name: string; password: string; adult: boolean; marked: readonly string[] },
): CompleteFields | null {
  const fields: CompleteFields = {};
  const name = parseDisplayName(input.name);
  if (!name.ok) fields.name = name.reason;
  const password = checkPassword(input.password);
  if (!password.ok) fields.password = password.reason;
  if (!input.adult) fields.adult = true;
  const boxes = view.boxes.map((box) => box.name).filter((box) => !input.marked.includes(box));
  if (boxes.length > 0) fields.boxes = boxes;
  return Object.keys(fields).length > 0 ? fields : null;
}

export type CompleteOutcome =
  | { kind: "redirect"; to: string; notice: Notice | null }
  | { kind: "invalid"; fields: CompleteFields }
  | { kind: "repaint" }
  | { kind: "unavailable" }
  | { kind: "texts_unavailable" }
  | { kind: "link_dead" }
  | { kind: "recover_instead" };

/**
 * @param unchecked Las casillas pintadas que no se marcaron: el servicio solo dice que falta
 *   algún texto, y con esto la pantalla dice cuál.
 */
export function completeRegistrationOutcome(result: RegistrationCompletion, unchecked: readonly string[]): CompleteOutcome {
  switch (result.kind) {
    case "entered":
      // Quedó dentro. Si a la cuenta todavía le falta algo, se le pide antes que nada.
      // Si no, su estado en el equipo dice a dónde va: quien abrió el enlace con una
      // invitación de administración sigue a configurar su segundo factor.
      return { kind: "redirect", to: result.pending ? consentsPath(null) : entryDestination(result.team, null), notice: null };
    case "ready_sign_in":
      // La cuenta quedó lista y solo falló abrir la sesión: entra con su contraseña.
      return { kind: "redirect", to: ROUTES.signIn, notice: "account_ready" };
    case "invalid": {
      // Falta un texto y el formulario no sabe cuál: no es el formulario que se pintó.
      if (result.fields.texts && unchecked.length === 0) return { kind: "repaint" };
      const fields: CompleteFields = {};
      if (result.fields.name) fields.name = result.fields.name;
      if (result.fields.password) fields.password = result.fields.password;
      if (result.fields.adult) fields.adult = true;
      // Todas las que faltan, de una vez: el servicio revisa los datos antes que los textos.
      if (unchecked.length > 0) fields.boxes = [...unchecked];
      return { kind: "invalid", fields };
    }
    case "texts_changed":
      return { kind: "repaint" };
    case "texts_unavailable":
    case "link_dead":
    case "recover_instead":
    case "unavailable":
      return { kind: result.kind };
  }
}
