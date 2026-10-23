import { longDate } from "@/app/_lib/dates";
import { admin } from "@/messages/es/admin";
import { plural, t } from "@/messages/format";
import type {
  AgeTier,
  AlertAccount,
  AlertExclusion,
  AlertKind,
  ExclusionReason,
  FinanceAlert,
  FinanceAlerts,
  ShareTier,
} from "@/services/anomalies/anomalies";
import { NOTE_MAX, REASON_MAX } from "@/services/anomalies/anomalies";

import { alertsButton } from "./outcomes";

// Lo que PA-68 mínima pinta, ya en palabras y con los valores de sus botones (T-208). Lo arma la
// página con lo que leyó: el navegador no decide qué se ofrece. Una cuenta es su huella en esa
// alerta: nada de aquí trae un identificador, un correo ni un nombre de alumna.

const text = admin.alerts;

/** Una línea de lo que se sabe de una cuenta: qué es y cuánto. */
export interface Fact {
  label: string;
  value: string;
}

export interface AccountRow {
  /** La huella, para la llave de la fila y la de su confirmación. */
  account: string;
  title: string;
  facts: Fact[];
  excluded: boolean;
  /**
   * Se ofrece excluirla: el periodo sigue abierto, y no está excluida ya o, con la alerta decidida
   * como fraude, lo está por otro motivo (la base acepta excluir por fraude encima de otra causa).
   */
  canExclude: boolean;
  /** Los motivos que se ofrecen: fraude solo con la alerta decidida como fraude, y solo fraude si ya está excluida. */
  reasons: { value: ExclusionReason; label: string }[];
  confirmTitle: string;
  /** Qué pasa al excluirla: sale su consumo del periodo de la alerta. */
  confirmBody: string;
  buttons: { ask: string; confirm: string };
}

export interface ExclusionRow {
  id: string;
  /** Qué se excluyó, por qué, quién y cuándo. */
  summary: string;
  /** Quién la revirtió, cuándo y por qué; nulo si sigue vigente. */
  revoked: string | null;
  /** Se ofrece revertirla: vigente, y el periodo sigue abierto. */
  canRevoke: boolean;
  buttons: { ask: string; confirm: string };
}

export interface AlertCard {
  id: string;
  title: string;
  period: string;
  open: boolean;
  status: string;
  trigger: string;
  /** Las cifras: con cuáles se detectó y cómo están hoy. */
  facts: string[];
  detected: string;
  /** Quién la revisó, cuándo, y su nota; nulo si sigue abierta. */
  reviewed: string | null;
  note: string | null;
  /** Ya se decidió que es fraude, con su evidencia. */
  fraud: string | null;
  /** Se ofrece decidir fraude: la alerta ya está revisada y todavía no se decidió (la base pide la nota de la revisión antes). */
  canDecideFraud: boolean;
  /** Todavía no se decidió, pero la alerta sigue abierta: se dice que primero se revisa. */
  fraudWaits: boolean;
  /** El periodo ya no recibe latidos: se dice, y no se ofrece excluir ni revertir. */
  closed: string | null;
  accountsTitle: string;
  accounts: AccountRow[];
  moreAccounts: string | null;
  exclusions: ExclusionRow[];
  buttons: { review: string; askFraud: string; fraud: string };
}

export interface AlertsView {
  /** El código de quien mira es reciente: se ofrece decidir. */
  canChange: boolean;
  alerts: AlertCard[];
  /** Cuántas hay que no caben, en palabras; nulo si caben todas. */
  more: string | null;
  /** Los topes de los textos, los de la base: el campo no deja escribir más. */
  limits: { note: number; reason: number };
}

// Lo que dice cada valor de la base. Escritas enteras: un valor nuevo no compila sin su texto.
const KINDS: Record<AlertKind, string> = {
  teacher_points_jump: t(text.kinds.teacherPointsJump),
  impossible_completion: text.kinds.impossibleCompletion,
  unconsumed_pool_ratio: text.kinds.unconsumedPoolRatio,
};
const TRIGGERS: Record<AlertKind, string> = {
  teacher_points_jump: text.triggers.teacherPointsJump,
  impossible_completion: text.triggers.impossibleCompletion,
  unconsumed_pool_ratio: text.triggers.unconsumedPoolRatio,
};
const AGES: Record<AgeTier, string> = {
  under_7: text.ages.under7,
  under_30: text.ages.under30,
  under_90: text.ages.under90,
  over_90: text.ages.over90,
};
const SHARES: Record<ShareTier, string> = {
  only: t(text.shares.only),
  most: text.shares.most,
  less_than_half: text.shares.lessThanHalf,
};
/** En el orden en que se ofrecen al excluir. */
export const REASON_LABELS: Record<ExclusionReason, string> = {
  technical_error: text.reasons.technicalError,
  test_account: text.reasons.testAccount,
  other: text.reasons.other,
  fraud: text.reasons.fraud,
};

const PERIOD = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" });
const PERCENT = new Intl.NumberFormat("es-MX", { style: "percent", maximumFractionDigits: 1 });
const COUNT = new Intl.NumberFormat("es-MX");

/** «octubre de 2026», de un periodo `AAAAMM`; vacío si no tiene forma. */
export function periodText(period: number): string {
  const year = Math.floor(period / 100);
  const month = period % 100;
  if (!Number.isInteger(period) || month < 1 || month > 12 || year < 2000) return "";
  return PERIOD.format(new Date(Date.UTC(year, month - 1, 1)));
}

/** «66.7 %», de puntos base. */
export function percentText(basisPoints: number): string {
  return Number.isFinite(basisPoints) ? PERCENT.format(basisPoints / 10_000) : "";
}

const MONEY = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

/** «$171.48», de centavos. */
export function moneyText(cents: number): string {
  return Number.isFinite(cents) ? MONEY.format(cents / 100) : "";
}

/** «12 h 5 min», «40 min»: un tiempo largo, a minutos. */
export function spanText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? t(text.hoursMinutes, { hours: COUNT.format(hours), minutes: String(minutes % 60) })
    : t(text.minutesOnly, { minutes: String(minutes) });
}

/** Un número de los detalles de la alerta, o nulo si no viene como número. */
function detail(alert: FinanceAlert, key: string): number | null {
  const value = alert.details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function factsOf(alert: FinanceAlert): string[] {
  switch (alert.kind) {
    case "teacher_points_jump": {
      const facts = [t(text.teacher, { name: alert.teacherName ?? text.someone })];
      const before = detail(alert, "before");
      const after = detail(alert, "after");
      if (before !== null && after !== null) facts.push(t(text.jumpPoints, { before: COUNT.format(before), after: COUNT.format(after) }));
      facts.push(t(text.jumpRise, { metric: percentText(alert.metric), threshold: percentText(alert.threshold) }));
      if (alert.today !== null) facts.push(t(text.jumpToday, { today: percentText(alert.today) }));
      return facts;
    }
    case "impossible_completion": {
      const facts = [t(text.impossibleNeeded, { metric: spanText(alert.metric), threshold: spanText(alert.threshold) })];
      if (alert.today !== null) facts.push(t(text.impossibleToday, { today: spanText(alert.today) }));
      return facts;
    }
    case "unconsumed_pool_ratio": {
      // No señala a nadie: sus cifras son las del bote del periodo (T-407).
      const facts = [t(text.unconsumedRatio, { metric: percentText(alert.metric), threshold: percentText(alert.threshold) })];
      const unconsumed = detail(alert, "unconsumed_cents");
      const pool = detail(alert, "pool_cents");
      if (unconsumed !== null && pool !== null) facts.push(t(text.unconsumedAmount, { unconsumed: moneyText(unconsumed), pool: moneyText(pool) }));
      const students = detail(alert, "students");
      const without = detail(alert, "students_without_points");
      if (students !== null && without !== null) {
        facts.push(t(text.unconsumedStudents, { without: COUNT.format(without), students: COUNT.format(students) }));
      }
      return facts;
    }
  }
}

function accountFacts(row: AlertAccount): Fact[] {
  const { columns } = text;
  const facts: Fact[] = [{ label: columns.age, value: AGES[row.age] }];
  if (row.share !== null) facts.push({ label: columns.share, value: SHARES[row.share] });
  if (row.halfPoints !== null) facts.push({ label: columns.halfPoints, value: COUNT.format(row.halfPoints) });
  if (row.halfPointsBefore !== null) facts.push({ label: columns.before, value: COUNT.format(row.halfPointsBefore) });
  facts.push({ label: columns.lessons, value: COUNT.format(row.lessons) });
  if (row.coveredSeconds !== null) facts.push({ label: columns.covered, value: spanText(row.coveredSeconds) });
  return facts;
}

const reasonsOf = (codes: readonly ExclusionReason[]) => codes.map((value) => ({ value, label: REASON_LABELS[value] }));

function accountRow(alert: FinanceAlert, row: AlertAccount): AccountRow {
  const fraud = alert.isFraud === true;
  // Excluida por esta alerta con fraude ya no se excluye otra vez; por otro motivo, sí, por fraude.
  const byFraud = alert.exclusions.some((each) => each.account === row.account && each.revokedAt === null && each.reasonCode === "fraud");
  const codes = (Object.keys(REASON_LABELS) as ExclusionReason[]).filter((reason) => (row.excluded ? reason === "fraud" : reason !== "fraud" || fraud));
  return {
    account: row.account,
    title: t(text.account, { account: row.account }),
    facts: accountFacts(row),
    excluded: row.excluded,
    canExclude: alert.canExclude && (!row.excluded || (fraud && !byFraud)),
    reasons: reasonsOf(codes),
    confirmTitle: t(text.confirmExcludeTitle, { account: row.account }),
    confirmBody: t(text.confirmExcludeBody, { period: periodText(alert.period) }),
    buttons: { ask: alertsButton.askExclusion(alert.id, row.account), confirm: alertsButton.exclude(alert.id, row.account) },
  };
}

function exclusionRow(alert: FinanceAlert, row: AlertExclusion): ExclusionRow {
  const { revokedAt } = row;
  const live = revokedAt === null;
  return {
    id: row.id,
    summary: t(text.exclusion, {
      account: row.account,
      scope: text.scopes[row.scope],
      reason: REASON_LABELS[row.reasonCode],
      text: row.reason,
      name: row.createdByName ?? text.someone,
      date: longDate(row.createdAt),
    }),
    revoked: live
      ? null
      : t(text.revokedBy, { date: longDate(revokedAt), name: row.revokedByName ?? text.someone, text: row.revokeReason ?? "" }),
    canRevoke: alert.canExclude && live,
    buttons: { ask: alertsButton.askRevocation(alert.id, row.id), confirm: alertsButton.revoke(alert.id, row.id) },
  };
}

function alertCard(alert: FinanceAlert): AlertCard {
  const open = alert.status === "open";
  return {
    id: alert.id,
    title: KINDS[alert.kind],
    period: t(text.period, { period: periodText(alert.period) }),
    open,
    status: open ? text.open : text.reviewed,
    trigger: TRIGGERS[alert.kind],
    facts: factsOf(alert),
    detected: t(text.detected, { date: longDate(alert.detectedAt) }),
    reviewed:
      open || alert.reviewedAt === null ? null : t(text.reviewedBy, { date: longDate(alert.reviewedAt), name: alert.reviewedByName ?? text.someone }),
    note: alert.reviewNote === null ? null : t(text.note, { note: alert.reviewNote }),
    fraud: alert.isFraud === true ? (alert.evidence === null ? text.fraudDecided : `${text.fraudDecided} ${t(text.evidence, { evidence: alert.evidence })}`) : null,
    canDecideFraud: !open && alert.isFraud !== true,
    fraudWaits: open && alert.isFraud !== true,
    closed: alert.canExclude ? null : text.closed,
    accountsTitle: alert.kind === "impossible_completion" ? text.accountTitle : text.accountsTitle,
    accounts: alert.accounts.map((row) => accountRow(alert, row)),
    moreAccounts: alert.moreAccounts > 0 ? t(plural(alert.moreAccounts, text.moreAccounts), { count: COUNT.format(alert.moreAccounts) }) : null,
    exclusions: alert.exclusions.map((row) => exclusionRow(alert, row)),
    buttons: { review: alertsButton.review(alert.id), askFraud: alertsButton.askFraud(alert.id), fraud: alertsButton.fraud(alert.id) },
  };
}

export function alertsView(read: FinanceAlerts): AlertsView {
  const hidden = read.total - read.alerts.length;
  return {
    canChange: read.freshCode,
    alerts: read.alerts.map(alertCard),
    more: hidden > 0 ? t(plural(hidden, text.moreAlerts), { count: COUNT.format(hidden) }) : null,
    limits: { note: NOTE_MAX, reason: REASON_MAX },
  };
}
