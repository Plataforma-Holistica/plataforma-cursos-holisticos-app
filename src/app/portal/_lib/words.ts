import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { DRAFT_TEXT_LIMITS, type DraftTextKind } from "@/services/drafts/field-rules";

import type { ChangeFailure } from "./change";
import type { TextProblem } from "./text";

// Lo que se dice de un campo o de un cambio que no se hizo, en las pantallas del portal (T-402).
// Viaja al navegador: solo el bloque de textos del portal.

export function problemText(kind: DraftTextKind, problem: TextProblem): string {
  const field = portal.fieldNames[kind];
  switch (problem) {
    case "required":
      return t(portal.field.required, { field });
    case "too_long":
      return t(portal.field.tooLong, { field, max: DRAFT_TEXT_LIMITS[kind] });
    case "invalid":
      return t(portal.field.invalid, { field });
  }
}

export function failureText(reason: ChangeFailure): string {
  switch (reason) {
    case "changed":
      return portal.failed.changed;
    case "gone":
      return portal.failed.gone;
    case "practice_inactive":
      return portal.failed.practiceInactive;
    case "level_inactive":
      return portal.failed.levelInactive;
    case "unavailable":
      return portal.failed.unavailable;
  }
}
