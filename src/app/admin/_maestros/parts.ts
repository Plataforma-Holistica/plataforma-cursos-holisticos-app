import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";

import type { TeachersFailure } from "./outcomes";

// Lo que comparten las dos pantallas de los maestros. Viaja al navegador.

const text = admin.teachers;

export const FAILURES: Record<TeachersFailure, string> = {
  needs_code: text.failures.needsCode,
  invalid: text.failures.invalid,
  self: t(text.failures.self),
  changed: text.failures.changed,
  not_found: t(text.failures.notFound),
  unavailable: text.failures.unavailable,
  unknown: text.failures.unknown,
  no_texts: t(text.failures.noTexts),
  ineligible: text.failures.ineligible,
  already_invited: t(text.failures.alreadyInvited),
  already_teacher: t(text.failures.alreadyTeacher),
  too_early: text.failures.tooEarly,
  locked: text.failures.locked,
  already_suspended: text.failures.alreadySuspended,
  not_active: t(text.failures.notActive),
  not_suspended: text.failures.notSuspended,
  proposer: text.failures.proposer,
};

/** El foco no tiene dueño: quedó en el documento. */
export function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}
