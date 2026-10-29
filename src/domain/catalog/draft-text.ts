// Los textos del borrador de un curso (RF-603, PA-43; T-402): el único criterio de «texto válido»
// antes de la base. Lo usan el servicio, antes de preguntarle a la base, y la pantalla, antes de
// llamar al servicio: así un texto que no pasa se dice en su campo y no se pierde.
//
// La base revisa lo mismo y manda (`private.draft_text_ok()` y las restricciones de las tablas): en
// NFC, sin espacios en las puntas, sin caracteres de control ni de formato; el resumen y la
// descripción admiten saltos de línea. Los largos los decidió Sergio el 2026-10-29: el título del
// curso, el del diseño (03 §4.1).

export const DRAFT_TEXT_LIMITS = {
  courseTitle: 60,
  summary: 500,
  moduleTitle: 120,
  lessonTitle: 120,
  description: 2000,
} as const;
export type DraftTextKind = keyof typeof DRAFT_TEXT_LIMITS;

/** Los que admiten saltos de línea y pueden quedar vacíos (en la base, nulos). */
const MULTILINE: ReadonlySet<DraftTextKind> = new Set(["summary", "description"]);

/** Lo que se acepta revisar: más largo es «demasiado largo» sin normalizarlo. */
const INPUT_MAX_FACTOR = 4;

// Los caracteres de control, los de formato (la categoría Cf: el guion suave, los de ancho cero, los
// que invierten o aíslan la dirección del texto) y los separadores de línea y de párrafo de Unicode. En
// un texto de varias líneas, el salto de línea no cuenta: el retorno de carro se quita antes, al
// normalizar los saltos. Un tabulador (lo trae un texto pegado de un documento) se vuelve un espacio:
// decisión mía sin confirmar.
const FORBIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const FORBIDDEN_MULTILINE = /[\p{Cf}\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;

export type DraftTextResult =
  | { ok: true; /** Lo que se guarda: en NFC, sin espacios en las puntas; nulo si quedó vacío y puede. */ text: string | null }
  | { ok: false; reason: "empty" | "too_long" | "invalid" };

export function parseDraftText(kind: DraftTextKind, input: string | null): DraftTextResult {
  const max = DRAFT_TEXT_LIMITS[kind];
  const multiline = MULTILINE.has(kind);
  const raw = input ?? "";
  if (raw.length > max * INPUT_MAX_FACTOR) return { ok: false, reason: "too_long" };
  const text = (multiline ? raw.replace(/\r\n?/g, "\n") : raw).replace(/\t/g, " ").normalize("NFC").trim();
  if (text === "") return multiline ? { ok: true, text: null } : { ok: false, reason: "empty" };
  if ([...text].length > max) return { ok: false, reason: "too_long" };
  if ((multiline ? FORBIDDEN_MULTILINE : FORBIDDEN).test(text)) return { ok: false, reason: "invalid" };
  return { ok: true, text };
}
