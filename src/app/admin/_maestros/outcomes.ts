import { parseEmail } from "@/services/account/field-rules";
import { ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type {
  DecideAnswer,
  FounderAnswer,
  InviteAnswer,
  LiftAnswer,
  ReinviteAnswer,
  RevokeAnswer,
  SuspendAnswer,
  TeacherChange,
  TeacherCode,
  TeacherInvited,
} from "@/services/teachers/teacher-admin";

import { givenCodeOutcome, type CodeOutcome, type Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace administrar a los maestros (PA-65 y PA-66; FL-46; T-401). Todo aquí es puro: el servicio corre
// la guarda y le pregunta a la base, y esto traduce su respuesta a un destino o a lo que se pinta. Cada respuesta tiene su
// caso: una nueva no compila sin el suyo.
//
//   · A quien la guarda no dejó (`refused`), o a quien la base le dijo que no tiene Contenido (`forbidden`), se le manda
//     a la misma página, donde decide su guarda.
//   · Lo que llega es qué botón se pulsó y lo escrito en su formulario. De qué maestro, qué se vio de él y qué propuesta,
//     sale del valor del botón.
//   · Lo que sale bien redirige con su aviso: sin JavaScript, recargar no reenvía.
//   · «No se supo» nunca se pinta como hecho.
//
// Viaja al navegador: no importa nada del servidor. Los topes se escriben aquí, por lo mismo; `admin.ts` tiene los suyos,
// y las pruebas de los dos los fijan contra la base.

export type { CodeState } from "../_lib/fresh-code";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEEN = /^[a-z_]+\.[0-9-]+\.[a-z]+\.[a-z-]+\.[01]$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INTENT = 160;
/** Lo que se lee de un campo de texto: un poco más que el tope mayor, para que la regla lo rechace y no lo corte. */
const MAX_TEXT_READ = 4_100;

export const LIMITS = { name: 80, reason: 1_000, notice: 300, note: 4_000 } as const;

export interface Drafts {
  name?: string;
  email?: string;
  since?: string;
  reason?: string;
  notice?: string;
  note?: string;
}
export type Field = "name" | "email" | "since" | "reason" | "notice" | "note";

interface OnTeacher {
  teacher: string;
  seen: string;
  drafts: Drafts;
}
export type TeachersRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "invite"; drafts: Drafts }
  | ({ step: "reinvite" | "revoke" | "lift" | "clear_founder" | "founder" | "ask_suspend" | "suspend" } & OnTeacher)
  | ({ step: "ask_confirm" | "confirm" | "reject"; request: string } & OnTeacher);

const SIMPLE = ["reinvite", "revoke", "lift", "clear_founder", "founder", "ask_suspend", "suspend"] as const;
const WITH_REQUEST = ["ask_confirm", "confirm", "reject"] as const;

/** Lo que cada botón manda. Solo esto se lee de vuelta. */
export const teachersButton = {
  reinvite: (teacher: string, seen: string) => `reinvite:${teacher}:${seen}`,
  revoke: (teacher: string, seen: string) => `revoke:${teacher}:${seen}`,
  lift: (teacher: string, seen: string) => `lift:${teacher}:${seen}`,
  founder: (teacher: string, seen: string) => `founder:${teacher}:${seen}`,
  clearFounder: (teacher: string, seen: string) => `clear_founder:${teacher}:${seen}`,
  askSuspend: (teacher: string, seen: string) => `ask_suspend:${teacher}:${seen}`,
  suspend: (teacher: string, seen: string) => `suspend:${teacher}:${seen}`,
  askConfirm: (teacher: string, seen: string, request: string) => `ask_confirm:${teacher}:${seen}:${request}`,
  confirm: (teacher: string, seen: string, request: string) => `confirm:${teacher}:${seen}:${request}`,
  reject: (teacher: string, seen: string, request: string) => `reject:${teacher}:${seen}:${request}`,
};

function textOf(form: FormData, name: Field): string {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, MAX_TEXT_READ) : "";
}

function draftsFor(form: FormData, step: string): Drafts {
  switch (step) {
    case "founder":
      return { since: textOf(form, "since") };
    case "ask_suspend":
    case "suspend":
      return { reason: textOf(form, "reason"), notice: textOf(form, "notice") };
    case "ask_confirm":
    case "confirm":
    case "reject":
      return { note: textOf(form, "note"), notice: textOf(form, "notice") };
    default:
      return {};
  }
}

/** Qué se pidió. `none` si lo que llegó no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readTeachersForm(form: unknown): TeachersRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  if (only === "cancel") return { step: "cancel" };
  if (only === "invite") return { step: "invite", drafts: { name: textOf(form, "name"), email: textOf(form, "email") } };
  const [verb, teacher, seen, request, ...rest] = only.split(":");
  if (rest.length > 0 || teacher === undefined || seen === undefined || !ID.test(teacher) || !SEEN.test(seen)) return { step: "none" };
  const simple = SIMPLE.find((each) => each === verb);
  if (simple !== undefined && request === undefined) return { step: simple, teacher, seen, drafts: draftsFor(form, simple) };
  const withRequest = WITH_REQUEST.find((each) => each === verb);
  if (withRequest !== undefined && request !== undefined && ID.test(request)) {
    return { step: withRequest, teacher, seen, request, drafts: draftsFor(form, withRequest) };
  }
  return { step: "none" };
}

const missing = (value: string | undefined, max: number) => (value ?? "").trim() === "" || (value ?? "").trim().length > max;

function isDay(value: string | undefined): boolean {
  if (value === undefined || !DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Lo que falta o no tiene forma: se dice en su campo, sin llamar a nadie. */
export function problemsOf(request: TeachersRequest): Field[] {
  switch (request.step) {
    case "invite": {
      const problems: Field[] = [];
      if (missing(request.drafts.name, LIMITS.name)) problems.push("name");
      if (!parseEmail(request.drafts.email ?? "").ok) problems.push("email");
      return problems;
    }
    case "founder":
      return isDay(request.drafts.since) ? [] : ["since"];
    case "ask_suspend":
    case "suspend": {
      const problems: Field[] = [];
      if (missing(request.drafts.reason, LIMITS.reason)) problems.push("reason");
      if (missing(request.drafts.notice, LIMITS.notice)) problems.push("notice");
      return problems;
    }
    case "ask_confirm":
    case "confirm":
      return missing(request.drafts.notice, LIMITS.notice) ? ["notice"] : [];
    case "reject":
      return (request.drafts.note ?? "").trim().length > LIMITS.note ? ["note"] : [];
    default:
      return [];
  }
}

export type TeachersFailure =
  | "needs_code"
  | "invalid"
  | "self"
  | "changed"
  | "not_found"
  | "unavailable"
  | "unknown"
  | "no_texts"
  | "ineligible"
  | "already_invited"
  | "already_teacher"
  | "too_early"
  | "locked"
  | "already_suspended"
  | "not_active"
  | "not_suspended"
  | "proposer";

export type TeachersOutcome = Leave | { kind: "failed"; reason: TeachersFailure };

/** Lo que se pinta después de un envío. Lo escrito viaja aquí: React devuelve el formulario a sus valores por omisión. */
export type TeachersState =
  | { kind: "idle" }
  | { kind: "invalid"; step: string; teacher: string | null; problems: Field[]; drafts: Drafts; attempt: number }
  | { kind: "asking"; ask: "suspend" | "confirm"; teacher: string; drafts: Drafts; attempt: number }
  | { kind: "failed"; reason: TeachersFailure; step: string; teacher: string | null; drafts: Drafts; attempt: number };

const failed = (reason: TeachersFailure): TeachersOutcome => ({ kind: "failed", reason });
const leave = (to: string, notice: Notice | null): TeachersOutcome => ({ kind: "leave", to, notice });

/** Lo que dar el código contestó: la tabla compartida, con la página de la lista. */
export function teachersCodeOutcome(result: TeacherCode): CodeOutcome {
  return givenCodeOutcome(result, ROUTES.adminTeachers);
}

type Result<Answer> = TeacherChange<Answer> | TeacherInvited;

function settle<Answer extends string>(
  result: Result<Answer>,
  page: string,
  table: Record<Exclude<Answer, "forbidden" | "needs_fresh_code">, TeachersOutcome>,
): TeachersOutcome {
  switch (result.kind) {
    case "refused":
      return leave(page, null);
    case "unavailable":
      return failed("unavailable");
    case "unknown":
      return failed("unknown");
    case "malformed":
      return failed("invalid");
    case "changed":
      return failed("changed");
    case "answered":
      if (result.answer === "forbidden") return leave(page, null);
      if (result.answer === "needs_fresh_code") return failed("needs_code");
      return table[result.answer as Exclude<Answer, "forbidden" | "needs_fresh_code">];
  }
}

const PLACED = {
  invalid: failed("invalid"),
  unavailable: failed("no_texts"),
  self: failed("self"),
  ineligible: failed("ineligible"),
  already_teacher: failed("already_teacher"),
  already_invited: failed("already_invited"),
};

export function inviteOutcome(result: TeacherInvited): TeachersOutcome {
  const done = leave(ROUTES.adminTeachers, "teacher_invited");
  return settle<InviteAnswer>(result, ROUTES.adminTeachers, { ...PLACED, invited_new: done, invited_existing: done });
}

export function reinviteOutcome(result: TeacherChange<ReinviteAnswer>): TeachersOutcome {
  const done = leave(ROUTES.adminTeachers, "teacher_reinvited");
  return settle<ReinviteAnswer>(result, ROUTES.adminTeachers, { ...PLACED, not_found: failed("not_found"), invited_new: done, invited_existing: done });
}

export function revokeOutcome(result: TeacherChange<RevokeAnswer>): TeachersOutcome {
  return settle<RevokeAnswer>(result, ROUTES.adminTeachers, {
    self: failed("self"),
    not_found: failed("not_found"),
    revoked: leave(ROUTES.adminTeachers, "teacher_invitation_revoked"),
  });
}

export function founderOutcome(result: TeacherChange<FounderAnswer>, page: string): TeachersOutcome {
  const done = leave(page, "teacher_founder_saved");
  return settle<FounderAnswer>(result, page, {
    not_found: failed("not_found"),
    self: failed("self"),
    unchanged: leave(page, null),
    too_early: failed("too_early"),
    locked: failed("locked"),
    set: done,
    cleared: done,
  });
}

export function suspendOutcome(result: TeacherChange<SuspendAnswer>, page: string): TeachersOutcome {
  return settle<SuspendAnswer>(result, page, {
    not_found: failed("not_found"),
    self: failed("self"),
    invalid: failed("invalid"),
    already_suspended: failed("already_suspended"),
    not_active: failed("not_active"),
    suspended: leave(page, "teacher_suspended"),
  });
}

export function liftOutcome(result: TeacherChange<LiftAnswer>, page: string): TeachersOutcome {
  return settle<LiftAnswer>(result, page, {
    not_found: failed("not_found"),
    self: failed("self"),
    proposer: failed("proposer"),
    not_suspended: failed("not_suspended"),
    lifted: leave(page, "teacher_lifted"),
  });
}

export function decideOutcome(result: TeacherChange<DecideAnswer>, page: string): TeachersOutcome {
  return settle<DecideAnswer>(result, page, {
    not_found: failed("not_found"),
    self: failed("self"),
    proposer: failed("proposer"),
    invalid: failed("invalid"),
    not_active: failed("not_active"),
    confirmed: leave(page, "teacher_fraud_confirmed"),
    rejected: leave(page, "teacher_fraud_rejected"),
  });
}
