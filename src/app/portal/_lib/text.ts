import { parseDraftText, type DraftTextKind } from "@/services/drafts/field-rules";

// Lo que se dice de un texto del borrador antes de llamar a nadie (T-402): la regla del dominio, la
// misma que corre el servicio y que la base vuelve a revisar. Viaja al navegador.

export type TextProblem = "required" | "too_long" | "invalid";

/** Lo que se lee de un texto. Más largo llega cortado, y la regla lo da por largo. */
export const MAX_TEXT_READ = 4001;

/** Un campo de texto tal como llegó, cortado si viene desmedido. Lo que no es texto, vacío. */
export function textField(form: FormData, name: string): string {
  const all = form.getAll(name);
  const [only] = all;
  return all.length === 1 && typeof only === "string" ? only.slice(0, MAX_TEXT_READ) : "";
}

export function checkDraftText(kind: DraftTextKind, value: string): TextProblem | null {
  const parsed = parseDraftText(kind, value);
  if (parsed.ok) return null;
  return parsed.reason === "empty" ? "required" : parsed.reason;
}
