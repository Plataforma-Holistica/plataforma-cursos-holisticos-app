import "server-only";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { holds, type CodeGiven, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

// Las alertas de anomalía y las decisiones de finanzas sobre ellas (RF-406, RN-17; PA-68 mínima,
// FL-64; T-208). Quién puede lo decide la base, con la puerta de finanzas
// (`private.finance_change_gate()`: la capacidad y un código reciente); aquí se decide a quién se
// le pregunta qué y en qué orden, como en el servicio de revisión:
//
//   · La guarda va primero: `teamStanding`, y solo sigue quien es del equipo con finanzas. Los
//     demás reciben `refused`, sin preguntarle nada más a la base. Si no se supo quién pide,
//     `unavailable`.
//   · Lo que llega se revisa antes de tocar la base: identificadores con forma, una cuenta con
//     forma de huella, un motivo de la lista, textos con algo escrito y de largo acotado. Lo que
//     no la tiene no llega (`malformed`).
//   · Nada de lo que llega dice quién actúa ni de qué cuenta se trata: quién, de la sesión que
//     pasó la guarda; la cuenta, de su huella en esa alerta, que la base resuelve.
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra su lista cerrada.
//     Otra cosa, o una excepción, es `unknown`: se reporta y nunca se pinta como hecho.

export const ALERT_KINDS = ["teacher_points_jump", "impossible_completion", "unconsumed_pool_ratio"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
/** La antigüedad de una cuenta, por tramos (decisión de Sergio del 2026-10-22). */
export const AGE_TIERS = ["under_7", "under_30", "under_90", "over_90"] as const;
export type AgeTier = (typeof AGE_TIERS)[number];
/** Lo que una cuenta le aporta a la maestra de la alerta, por tramos. */
export const SHARE_TIERS = ["only", "most", "less_than_half"] as const;
export type ShareTier = (typeof SHARE_TIERS)[number];
/** Los motivos de una exclusión. `fraud` solo con la alerta decidida como fraude. */
export const EXCLUSION_REASONS = ["technical_error", "test_account", "other", "fraud"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
export const EXCLUSION_SCOPES = ["account", "session", "interval"] as const;
export type ExclusionScope = (typeof EXCLUSION_SCOPES)[number];

/** Los topes de los textos, los de la base. */
export const NOTE_MAX = 4_000;
export const REASON_MAX = 2_000;

export interface AlertAccount {
  /** La huella de la cuenta en esta alerta: nunca su identificador. */
  account: string;
  age: AgeTier;
  share: ShareTier | null;
  halfPoints: number | null;
  halfPointsBefore: number | null;
  lessons: number;
  coveredSeconds: number | null;
  /** Tiene una exclusión vigente de esta alerta. */
  excluded: boolean;
}

export interface AlertExclusion {
  id: string;
  account: string;
  scope: ExclusionScope;
  reasonCode: ExclusionReason;
  reason: string;
  createdByName: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedByName: string | null;
  revokeReason: string | null;
}

export interface FinanceAlert {
  id: string;
  period: number;
  kind: AlertKind;
  status: "open" | "reviewed";
  metric: number;
  threshold: number;
  /** La cifra de hoy, recalculada; nula si no se pudo. */
  today: number | null;
  /** Las cifras con que se detectó (sin nombres ni títulos). */
  details: Record<string, unknown>;
  detectedAt: string;
  reviewNote: string | null;
  isFraud: boolean | null;
  evidence: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  teacherName: string | null;
  /** La suspensión por fraude que salió de esta alerta y falta confirmar, y si la propuso quien lee. */
  suspension: { id: string; mine: boolean } | null;
  /** El periodo todavía recibe latidos: se puede excluir y revertir. */
  canExclude: boolean;
  accounts: AlertAccount[];
  moreAccounts: number;
  exclusions: AlertExclusion[];
}

export interface FinanceAlerts {
  /** Las decisiones pasarían hoy la puerta sin pedir el código otra vez. */
  freshCode: boolean;
  /** Cuántas hay, aunque no quepan todas. */
  total: number;
  /** Las abiertas primero, por antigüedad, y las revisadas de los periodos abiertos. */
  alerts: FinanceAlert[];
}

/** Lo que contesta `private.review_alert()`. */
export const REVIEW_ANSWERS = ["reviewed", "marked_fraud", "already_reviewed", "self", "forbidden", "needs_fresh_code", "malformed", "not_found"] as const;
export type ReviewAnswer = (typeof REVIEW_ANSWERS)[number];
/** Lo que contesta `private.exclude_alert_account()`. */
export const EXCLUDE_ANSWERS = [
  "excluded",
  "already_excluded",
  "outside_window",
  "needs_fraud_decision",
  "not_related",
  "self",
  "proposer",
  "conflict",
  "not_found",
  "malformed",
  "forbidden",
  "needs_fresh_code",
] as const;
export type ExcludeAnswer = (typeof EXCLUDE_ANSWERS)[number];
/** Lo que contesta `private.revoke_exclusion()`. */
export const REVOKE_ANSWERS = ["revoked", "already_revoked", "outside_window", "self", "conflict", "not_found", "malformed", "forbidden", "needs_fresh_code"] as const;
export type RevokeAnswer = (typeof REVOKE_ANSWERS)[number];

/** Lo que contesta `private.propose_fraud_suspension()` (T-401, RN-17). */
export const PROPOSE_ANSWERS = [
  "proposed",
  "needs_fraud_decision",
  "invalid",
  "self",
  "already_suspended",
  "not_active",
  "already_pending",
  "alert_used",
  "forbidden",
  "needs_fresh_code",
] as const;
export type ProposeAnswer = (typeof PROPOSE_ANSWERS)[number];
/** Lo que contesta `private.withdraw_fraud_suspension()`. */
export const WITHDRAW_ANSWERS = ["withdrawn", "not_found", "not_yours", "forbidden", "needs_fresh_code"] as const;
export type WithdrawAnswer = (typeof WITHDRAW_ANSWERS)[number];

/**
 * Lo que este servicio le pregunta a la base, a nombre de las claims que se le pasan. La lectura
 * es nula cuando quien actúa no pasa la puerta del equipo con finanzas. Las decisiones lanzan si
 * la base no contestó algo de su lista: quien llama lo trata como «no se supo».
 */
export interface AnomalyStore {
  alerts(claims: VerifiedClaims): Promise<FinanceAlerts | null>;
  review(claims: VerifiedClaims, alertId: string, note: string | null, isFraud: boolean | null, evidence: string | null): Promise<ReviewAnswer>;
  exclude(claims: VerifiedClaims, alertId: string, account: string, reasonCode: ExclusionReason, reason: string): Promise<ExcludeAnswer>;
  revoke(claims: VerifiedClaims, exclusionId: string, reason: string): Promise<RevokeAnswer>;
  propose(claims: VerifiedClaims, alertId: string, reason: string): Promise<ProposeAnswer>;
  withdraw(claims: VerifiedClaims, requestId: string): Promise<WithdrawAnswer>;
}

type Refused = { kind: "refused" };
type Unavailable = { kind: "unavailable" };
type Unknown = { kind: "unknown" };
type Malformed = { kind: "malformed" };

export type AlertsRead = { kind: "alerts"; alerts: FinanceAlerts } | Unavailable;
export type AlertReviewed = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: ReviewAnswer };
export type AccountExcluded = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: ExcludeAnswer };
export type ExclusionRevoked = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: RevokeAnswer };
export type SuspensionProposed = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: ProposeAnswer };
export type SuspensionWithdrawn = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: WithdrawAnswer };
/** Dar el código otra vez para que las decisiones pasen su puerta (el bloque «Tu código»). */
export type FinanceCode =
  | Refused
  | Unavailable
  | { kind: "verified" }
  | { kind: "wrong_code" }
  /** El freno rechazó: Auth cerró todas sus sesiones. */
  | { kind: "throttled" }
  /** Su código fue el bueno, y aun así ninguna decisión pasaría: es configuración. */
  | { kind: "not_available" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[0-9a-f]{12}$/;

/** Un identificador con forma, o nulo. Solo minúsculas: dos iguales se escriben igual. */
const idOf = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);
/** Un texto con algo escrito y no más largo que `max`, sin los espacios de las puntas; o nulo. */
function textOf(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
}

export interface AnomalyCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  /** Dar el código del segundo factor (`team.ts`): el factor es el que dice la base. */
  giveSecondFactorCode: (jar: CookieJar, code: string) => Promise<CodeGiven>;
  store: AnomalyStore;
}

export function createAnomalyAlerts(deps: { report: (code: FailureCode) => Promise<void> }, core: AnomalyCore) {
  const { store } = core;

  /** Quien pide, si es del equipo con finanzas y su sesión pasa la puerta. */
  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "finance")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /** Una decisión: lo que la base contestó, o «no se supo» si no contestó algo de su lista. */
  async function decide<Answer>(work: () => Promise<Answer>): Promise<{ ok: true; answer: Answer } | { ok: false; result: Unknown }> {
    try {
      return { ok: true, answer: await work() };
    } catch {
      await deps.report("anomaly_decision_unavailable");
      return { ok: false, result: { kind: "unknown" } };
    }
  }

  /**
   * Las alertas, para la sección que ya pasó su guarda, con las claims que esa guarda dio. Leer
   * no pide el código reciente. Una lectura nula no vale: se le vuelve a preguntar a la guarda, y
   * solo si insiste en que pasa con finanzas se reporta. Las dos son «no se supo».
   */
  async function anomalyAlerts(reader: CookieReader, claims: VerifiedClaims): Promise<AlertsRead> {
    let alerts: FinanceAlerts | null;
    try {
      alerts = await store.alerts(claims);
    } catch {
      await deps.report("anomaly_alerts_unavailable");
      return { kind: "unavailable" };
    }
    if (alerts !== null) return { kind: "alerts", alerts };
    const team = await core.teamStanding(reader);
    if (team.kind === "team" && holds(team.standing, "finance")) await deps.report("anomaly_alerts_unavailable");
    return { kind: "unavailable" };
  }

  /** Marcar una alerta como revisada, con su nota (RF-406). No decide fraude. */
  async function reviewAlert(reader: CookieReader, input: { alert: unknown; note: unknown }): Promise<AlertReviewed> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const alert = idOf(input.alert);
    const note = textOf(input.note, NOTE_MAX);
    if (alert === null || note === null) return { kind: "malformed" };
    const result = await decide(() => store.review(admitted.claims, alert, note, null, null));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  /** Decidir que una alerta es fraude, con la evidencia escrita (RN-17). No se deshace. */
  async function decideFraud(reader: CookieReader, input: { alert: unknown; evidence: unknown }): Promise<AlertReviewed> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const alert = idOf(input.alert);
    const evidence = textOf(input.evidence, NOTE_MAX);
    if (alert === null || evidence === null) return { kind: "malformed" };
    const result = await decide(() => store.review(admitted.claims, alert, null, true, evidence));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  /** Proponer suspender al maestro de una alerta decidida como fraude: otra persona con Contenido la confirma (RN-17). */
  async function proposeSuspension(reader: CookieReader, input: { alert: unknown; reason: unknown }): Promise<SuspensionProposed> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const alert = idOf(input.alert);
    const reason = textOf(input.reason, NOTE_MAX);
    if (alert === null || reason === null) return { kind: "malformed" };
    const result = await decide(() => store.propose(admitted.claims, alert, reason));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  /** Retirar una propuesta: solo quien la hizo, y la base lo dice. */
  async function withdrawSuspension(reader: CookieReader, input: { request: unknown }): Promise<SuspensionWithdrawn> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const request = idOf(input.request);
    if (request === null) return { kind: "malformed" };
    const result = await decide(() => store.withdraw(admitted.claims, request));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  /** Excluir del reparto el consumo de una cuenta de una alerta, en el periodo de la alerta. */
  async function excludeAccount(
    reader: CookieReader,
    input: { alert: unknown; account: unknown; reasonCode: unknown; reason: unknown },
  ): Promise<AccountExcluded> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const alert = idOf(input.alert);
    const account = typeof input.account === "string" && ACCOUNT.test(input.account) ? input.account : null;
    const reasonCode = EXCLUSION_REASONS.find((each) => each === input.reasonCode) ?? null;
    const reason = textOf(input.reason, REASON_MAX);
    if (alert === null || account === null || reasonCode === null || reason === null) return { kind: "malformed" };
    const result = await decide(() => store.exclude(admitted.claims, alert, account, reasonCode, reason));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  /** Revertir una exclusión, con su motivo, mientras el periodo esté abierto. */
  async function revokeExclusion(reader: CookieReader, input: { exclusion: unknown; reason: unknown }): Promise<ExclusionRevoked> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const exclusion = idOf(input.exclusion);
    const reason = textOf(input.reason, REASON_MAX);
    if (exclusion === null || reason === null) return { kind: "malformed" };
    const result = await decide(() => store.revoke(admitted.claims, exclusion, reason));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  /**
   * Dar el código otra vez (PA-68, «Tu código»). Los de las otras secciones no sirven aquí:
   * comprueban lo reciente con su propia lectura, que pide otra capacidad. Este lo comprueba con
   * las alertas, que piden finanzas.
   */
  async function giveFinanceCode(jar: CookieJar, code: string): Promise<FinanceCode> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const given = await core.giveSecondFactorCode(jar, code);
    switch (given.kind) {
      case "verified":
        break;
      case "wrong_code":
      case "throttled":
      case "unavailable":
        return { kind: given.kind };
      default:
        // Dejó de ser del equipo, o su sesión ya no vale: decide la página.
        return { kind: "refused" };
    }
    // Con la sesión como quedó en ese tarro: verificar escribió su cookie.
    const again = await admit(jar);
    if (!again.ok) return again.result;
    let alerts: FinanceAlerts | null;
    try {
      alerts = await store.alerts(again.claims);
    } catch {
      await deps.report("anomaly_decision_unavailable");
      return { kind: "not_available" };
    }
    // Perdió finanzas entre una cosa y otra: decide la página.
    if (alerts === null) return { kind: "refused" };
    if (alerts.freshCode) return { kind: "verified" };
    await deps.report("anomaly_decision_unavailable");
    return { kind: "not_available" };
  }

  return { anomalyAlerts, reviewAlert, decideFraud, proposeSuspension, withdrawSuspension, excludeAccount, revokeExclusion, giveFinanceCode };
}
