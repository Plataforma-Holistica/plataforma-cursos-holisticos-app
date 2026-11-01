import { clockTime, longDate, PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { admin } from "@/messages/es/admin";
import { plural, t } from "@/messages/format";
import { periodClosePath, periodPath } from "@/services/account/navigation";
import type { FinancePayouts, PayoutRow, PayoutStatus } from "@/services/periods/periods";

import { PAYOUT_STATUS_TEXT } from "./payouts-failures";
import { payoutsButton } from "./payouts-outcomes";
import { money, periodName, type StatusTone } from "./rows";

// Lo que PA-81 pinta, ya en palabras y con los valores de sus botones (T-605, cuarta solicitud). Lo arma la
// página con lo que leyó: el navegador no decide qué se ofrece, ni sabe leer fechas o centavos. Cada botón
// lleva lo que se vio: liberar, la huella de la vista; retener, el estado de la fila; soltar, la huella de la
// fila. Sin liberar, las cifras son las que liberar escribiría ahora, y se dicen estimadas.

const text = admin.periods.payouts;
const periodsText = admin.periods;

type Read = Extract<FinancePayouts, { period: object }>;

const PERIOD_TONES: Record<Read["period"]["status"], StatusTone> = { open: "neutral", closing: "active", closed: "good", paid: "good" };
/** Los tonos de cada estado de una liquidación (diseño, `StatusBadge`). */
export type PayoutTone = "neutral" | "active" | "attention" | "good" | "bad";
const TONES: Record<PayoutStatus, PayoutTone> = {
  calculated: "neutral",
  awaiting_invoice: "active",
  invoice_in_review: "active",
  invoice_rejected: "bad",
  ready_to_pay: "active",
  paid: "good",
  carried_forward: "attention",
  on_hold: "bad",
  payment_returned: "bad",
};
/** Los estados que se retienen (`hold_payout`): todos menos acumulada, pagada, devuelta y la ya retenida. */
const HOLDABLE: readonly PayoutStatus[] = ["calculated", "awaiting_invoice", "invoice_in_review", "invoice_rejected", "ready_to_pay"];

/** El filtro de una fila: su estado, o «pendiente» si todavía no tiene liquidación. */
export type PayoutFilter = PayoutStatus | "pending";

export interface PayoutViewRow {
  key: string;
  filter: PayoutFilter;
  teacher: string;
  status: string;
  tone: PayoutTone;
  pool: string;
  founder: string;
  bonuses: string;
  adjustments: string;
  balance: string;
  subtotal: string;
  vat: string;
  withheld: string;
  net: string;
  /** Lo que detiene liberarla, en palabras: sin datos o sin regla. */
  taxNote: string | null;
  /** Si llega al mínimo, en palabras; nulo si no se sabe. */
  minimum: string | null;
  holdReason: string | null;
  /** Retener: el valor del primer paso y el de confirmar, con el estado que se vio. */
  hold: { ask: string; confirm: string; status: PayoutStatus } | null;
  /** Retener porque le falta algo: el valor del botón. Nulo si no se ofrece. */
  holdForTax: string | null;
  /** Soltar: con la huella de la fila; `releases` si la libera ahí mismo (pide la casilla). */
  unhold: { ask: string; confirm: string; seen: string; releases: boolean; title: string; body: string } | null;
  /** El bono del fundador propuesto: confirmarlo, o anularlo con su motivo. */
  founderBonus: { id: string; confirm: string; askVoid: string; void: string } | null;
}

export interface PayoutsView {
  periodId: number;
  name: string;
  status: string;
  tone: StatusTone;
  panelHref: string;
  closeHref: string;
  canChange: boolean;
  /** Abierto o en cierre: las liquidaciones nacen al cerrar. */
  notClosed: boolean;
  releasedLine: string | null;
  paid: boolean;
  /** Sin liberar: las cifras son estimadas. */
  estimated: boolean;
  minimumLine: string;
  release:
    | { kind: "none" }
    | { kind: "waits"; text: string }
    | { kind: "offered"; seen: string; ask: string; confirm: string; title: string; body: string };
  rows: PayoutViewRow[];
  totals: { pool: string; bonuses: string; adjustments: string; balance: string; subtotal: string; net: string };
  /** Todas, y un botón por estado con su cuenta; solo con JavaScript. */
  filters: { key: PayoutFilter | "all"; label: string }[];
}

const shortId = (id: string) => id.slice(0, 8);

function statusOf(row: PayoutRow): string {
  return row.status === null ? text.pending : PAYOUT_STATUS_TEXT[row.status];
}

function founderOf(row: PayoutRow): string {
  const bonus = row.founderBonus;
  if (bonus === null) return text.noFounder;
  const amount = money(bonus.amountCents);
  if (bonus.status === "proposed") return t(text.founderStatuses.proposed, { amount });
  if (bonus.status === "confirmed") return t(text.founderStatuses.confirmed, { amount });
  return text.founderStatuses.void;
}

function minimumOf(row: PayoutRow): string | null {
  if (row.reachesMinimum === null) return null;
  return row.reachesMinimum ? text.reaches : text.belowMinimum;
}

/** A dónde vuelve una retenida al soltarla, y si soltarla la libera ahí mismo. */
function unholdOf(row: PayoutRow, name: string, periodReleased: boolean): PayoutViewRow["unhold"] {
  if (row.status !== "on_hold" || row.payoutId === null || row.unholdFingerprint === null || row.heldFromStatus === null) return null;
  const releases = row.heldFromStatus === "calculated" && periodReleased;
  const to: PayoutStatus = releases ? (row.reachesMinimum ? "awaiting_invoice" : "carried_forward") : row.heldFromStatus;
  return {
    ask: payoutsButton.askUnhold(row.payoutId, row.unholdFingerprint),
    confirm: payoutsButton.unhold(row.payoutId, row.unholdFingerprint, releases),
    seen: row.unholdFingerprint,
    releases,
    title: t(text.unholdDialogTitle, { name }),
    body: releases ? t(text.unholdReleases, { amount: money(row.subtotalCents), status: PAYOUT_STATUS_TEXT[to] }) : t(text.unholdBack, { status: PAYOUT_STATUS_TEXT[to] }),
  };
}

export function payoutsView(read: Read): PayoutsView {
  const { period, release } = read;
  const name = periodName(period.periodId);
  const notClosed = period.status === "open" || period.status === "closing";
  const released = period.payoutsReleasedAt !== null;
  // Lo que cambia algo se ofrece solo con el código reciente y el periodo sin pagar.
  const canChange = read.freshCode && period.status === "closed";

  const rows: PayoutViewRow[] = read.payouts.map((row) => {
    const named = row.name ?? t(text.noName, { id: shortId(row.teacherId) });
    const teacher = row.isSelf ? t(text.yours, { name: named }) : named;
    // La suya no la cambia quien lee: lo hace otra persona de finanzas (T-401).
    const mine = row.isSelf;
    const amount = (cents: number) => (row.estimated ? t(text.estimated, { amount: money(cents) }) : money(cents));
    // Una retenida por datos también: si aparece otra causa pasa a investigación, y eso sí detiene la purga.
    const holdable = canChange && !mine && row.payoutId !== null && row.status !== null && (HOLDABLE.includes(row.status) || row.holdKind === "tax_data");
    const bonus = row.founderBonus;
    return {
      key: row.teacherId,
      filter: row.status ?? "pending",
      teacher,
      status: statusOf(row),
      tone: row.status === null ? "neutral" : TONES[row.status],
      pool: money(row.poolCents),
      founder: founderOf(row),
      bonuses: money(row.manualBonusesCents),
      adjustments: money(row.adjustmentsCents),
      balance: money(row.balanceCents),
      subtotal: amount(row.subtotalCents),
      vat: row.vatCents === null ? text.noTaxYet : amount(row.vatCents),
      withheld: row.incomeTaxWithheldCents === null || row.vatWithheldCents === null ? text.noTaxYet : amount(row.incomeTaxWithheldCents + row.vatWithheldCents),
      net: row.netCents === null ? text.noTaxYet : amount(row.netCents),
      taxNote: row.taxState === "no_data" ? text.taxNoData : row.taxState === "no_rule" ? text.taxNoRule : !row.hasTaxData && row.status === "on_hold" && row.reachesMinimum === true ? text.taxNoData : null,
      minimum: minimumOf(row),
      holdReason: row.status === "on_hold" && row.holdReason !== null ? t(text.heldBecause, { reason: row.holdReason }) : null,
      hold:
        holdable && row.payoutId !== null && row.status !== null
          ? { ask: payoutsButton.askHold(row.payoutId, row.status), confirm: payoutsButton.hold(row.payoutId, row.status), status: row.status }
          : null,
      holdForTax:
        canChange && !mine && row.payoutId !== null && row.status === "calculated" && (row.taxState === "no_data" || row.taxState === "no_rule")
          ? payoutsButton.holdForTax(row.payoutId, row.status)
          : null,
      unhold: canChange && !mine ? unholdOf(row, named, released) : null,
      founderBonus:
        canChange && !mine && !released && bonus !== null && bonus.status === "proposed"
          ? { id: bonus.bonusId, confirm: payoutsButton.confirmBonus(bonus.bonusId), askVoid: payoutsButton.askVoid(bonus.bonusId), void: payoutsButton.void(bonus.bonusId) }
          : null,
    };
  });

  // Los totales suman lo que se ve: el bono del fundador va en el bruto, no en su columna, que dice su estado.
  const sum = (pick: (row: PayoutRow) => number) => money(read.payouts.reduce((total, row) => total + pick(row), 0));

  // Lo que liberarían: las calculadas y las que todavía no tienen liquidación; las retenidas se quedan.
  const releasing = read.payouts.filter((row) => row.status === "calculated" || row.status === null);
  const reaching = releasing.filter((row) => row.reachesMinimum === true).length;
  let releaseBlock: PayoutsView["release"] = { kind: "none" };
  if (release !== null && read.freshCode) {
    releaseBlock =
      release.pendingFounderBonuses > 0
        ? { kind: "waits", text: t(plural(release.pendingFounderBonuses, text.releaseWaits), { count: release.pendingFounderBonuses }) }
        : {
            kind: "offered",
            seen: release.fingerprint,
            ask: payoutsButton.askRelease(period.periodId, release.fingerprint),
            confirm: payoutsButton.release(period.periodId, release.fingerprint),
            title: t(text.releaseDialogTitle, { period: name }),
            body:
              t(plural(reaching, text.releaseDialogBody), { count: reaching, carried: releasing.length - reaching }) +
              (releasing.some((row) => row.isSelf) ? " " + t(text.releaseIncludesSelf) : ""),
          };
  }

  const counts = new Map<PayoutFilter, number>();
  for (const row of rows) counts.set(row.filter, (counts.get(row.filter) ?? 0) + 1);
  const filters = [
    { key: "all" as const, label: t(text.filterAll, { count: rows.length }) },
    ...[...counts.entries()].map(([key, count]) => ({ key, label: t(text.filterOption, { status: key === "pending" ? text.pending : PAYOUT_STATUS_TEXT[key], count }) })),
  ];

  return {
    periodId: period.periodId,
    name,
    status: periodsText.statuses[period.status],
    tone: PERIOD_TONES[period.status],
    panelHref: periodPath(period.periodId),
    closeHref: periodClosePath(period.periodId),
    canChange,
    notClosed,
    releasedLine:
      period.payoutsReleasedAt === null
        ? null
        : t(text.releasedAt, { date: longDate(period.payoutsReleasedAt), time: clockTime(period.payoutsReleasedAt, PRODUCT_TIME_ZONE) }),
    paid: period.status === "paid",
    estimated: !notClosed && !released,
    minimumLine: period.minimumCents === null ? text.noMinimum : t(text.minimum, { amount: money(period.minimumCents) }),
    release: releaseBlock,
    rows,
    totals: {
      pool: sum((row) => row.poolCents),
      bonuses: sum((row) => row.manualBonusesCents),
      adjustments: sum((row) => row.adjustmentsCents),
      balance: sum((row) => row.balanceCents),
      subtotal: sum((row) => row.subtotalCents),
      // Lo que se transfiere: una acumulada no. Si falta alguno, no hay total que decir.
      net: read.payouts.some((row) => row.reachesMinimum === true && row.netCents === null) ? text.noTaxYet : sum((row) => (row.reachesMinimum === true ? (row.netCents ?? 0) : 0)),
    },
    filters,
  };
}

const recent = (at: string | null, now: string): boolean => {
  if (at === null) return false;
  const age = new Date(now).getTime() - new Date(at).getTime();
  return age >= 0 && age < 120_000;
};

/** El aviso de que se liberó (cookie sin periodo): solo si este periodo se liberó hace un momento. */
export function acceptedReleaseNotice(read: Read, now: string): boolean {
  return recent(read.period.payoutsReleasedAt, now);
}

/** El aviso «Listo» de las demás decisiones (cookie sin periodo): solo si este periodo cambió hace un momento. */
export function acceptedUpdateNotice(read: Read, now: string): boolean {
  return recent(read.period.changedAt, now);
}
