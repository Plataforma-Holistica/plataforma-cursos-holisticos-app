import { clockTime, longDate, productDay, PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { admin } from "@/messages/es/admin";
import { plural, t } from "@/messages/format";
import type { DifferenceSide, FinancePeriod, Reconciliation, ReconciliationDifference } from "@/services/periods/periods";

import { EXPLAINABLE, reconcileButton, type AskedDifference, type ExplainableSide } from "./reconcile-outcomes";

// La conciliación con Stripe de PA-79 en palabras (T-303, cuarta solicitud; decisiones de Sergio del 2026-11-08). Todo aquí es puro y lo arma la página con lo
// que leyó: el navegador no decide qué se ofrece. Lo que la base da es la última comparación del periodo, con hasta 200 diferencias.
//
//   · Solo se explica con nota lo que Stripe cobró y el libro no tiene, o un cargo en otra moneda. Lo que el libro tiene y Stripe no, o con otro monto, frena el
//     cierre hasta corregirse: la fila lo dice, sin botón.
//   · «Comparar ahora» se ofrece en un periodo abierto ya terminado o en cierre, y no pide el código reciente; «Explicar» sí. En uno cerrado, solo se consulta.

const text = admin.periods.reconciliation;

const DAY_MS = 86_400_000;

const SIDES: Record<DifferenceSide, string> = {
  only_provider: text.sides.onlyProvider,
  only_own: text.sides.onlyOwn,
  amount: text.sides.amount,
  other_currency: text.sides.otherCurrency,
};

const formats = new Map<string, Intl.NumberFormat>();
/**
 * Centavos en su moneda, como se leen: «$1,234.56» en pesos, «USD 12.00» en dólares. Stripe da los montos en la unidad menor de la moneda, que no siempre
 * es de cien (el yen no tiene centavos): se divide por lo que dice la moneda. Un código que `Intl` no conoce se escribe con dos decimales y su código.
 */
export function amountIn(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  let format = formats.get(code);
  if (format === undefined) {
    try {
      format = new Intl.NumberFormat("es-MX", { style: "currency", currency: code, currencyDisplay: code === "MXN" ? "symbol" : "code" });
    } catch {
      return `${(cents / 100).toFixed(2)} ${code}`;
    }
    formats.set(code, format);
  }
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(cents / 10 ** digits);
}

/** Cuántos días de calendario, en la zona del producto, van de un momento a otro: «hoy», «hace 1 día». */
export function daysAgo(iso: string, now: string): string {
  const days = Math.round((Date.parse(productDay(new Date(now))) - Date.parse(productDay(new Date(iso)))) / DAY_MS);
  return days <= 0 ? text.today : t(plural(days, text.daysAgo), { count: days });
}

const isExplainable = (side: DifferenceSide): side is ExplainableSide => EXPLAINABLE.some((each) => each === side);

export interface DifferenceRow {
  key: string;
  side: string;
  charge: string;
  own: string;
  provider: string;
  /** Si ya se explicó: cuándo y su nota. */
  explained: string | null;
  /**
   * Lo que se ofrece: «Explicar» con la diferencia tal como se vio; la frase de que frena el cierre (lo que no se explica); o nada (ya explicada, o el periodo
   * cerrado, o sin el código reciente).
   */
  offer: { kind: "explain"; asked: AskedDifference; ask: string; confirm: string } | { kind: "blocks" } | { kind: "none" };
}

export interface ReconciliationView {
  /** El bloque solo se consulta: el periodo ya cerró. */
  readOnly: boolean;
  /** El valor del botón «Comparar ahora», o nulo si no se ofrece. */
  compare: string | null;
  /** El mes no ha terminado: todavía no se compara. */
  notYet: boolean;
  /** Quien mira tiene el código reciente: puede explicar. */
  canExplain: boolean;
  last:
    | { kind: "never" }
    | {
        kind: "compared";
        when: string;
        by: string;
        own: string;
        provider: string;
        verdict: string;
        tone: "success" | "warning";
        /** Lo que hace que no coincida, o que se lea con cuidado: incompleta, pendientes, más de 200, modo de prueba. */
        notes: string[];
        differences: DifferenceRow[];
      };
}

function differenceRow(difference: ReconciliationDifference, index: number, explainable: boolean): DifferenceRow {
  const own = difference.ownCents === null ? text.absent : amountIn(difference.ownCents, difference.currency);
  const provider = difference.providerCents === null ? text.absent : amountIn(difference.providerCents, difference.currency);
  let explained: string | null = null;
  if (difference.explained) {
    const date = difference.explainedAt === null ? "" : longDate(difference.explainedAt);
    explained = difference.note === null ? t(text.explainedAtNoNote, { date }) : t(text.explainedAt, { date, note: difference.note });
  }
  let offer: DifferenceRow["offer"] = { kind: "none" };
  if (!isExplainable(difference.side)) offer = { kind: "blocks" };
  else if (explainable && !difference.explained && difference.providerCents !== null) {
    const asked: AskedDifference = { side: difference.side, currency: difference.currency, cents: String(difference.providerCents), charge: difference.charge };
    offer = { kind: "explain", asked, ask: reconcileButton.askExplain(asked), confirm: reconcileButton.explain(asked) };
  }
  return { key: `${difference.side}:${difference.charge}:${index}`, side: SIDES[difference.side], charge: difference.charge, own, provider, explained, offer };
}

function verdictOf(reconciliation: Reconciliation): { verdict: string; tone: "success" | "warning" } {
  if (reconciliation.matches && reconciliation.current) return { verdict: text.matchesCurrent, tone: "success" };
  if (reconciliation.matches) return { verdict: text.matchesStale, tone: "warning" };
  // Por qué ya no vale aunque no tenga diferencias propias: lo dice la base, con lo de ahora.
  if (reconciliation.foreignProvider) return { verdict: text.foreignProvider, tone: "warning" };
  if (reconciliation.ownCountNow !== reconciliation.ownCount) {
    return { verdict: t(text.ledgerChanged, { then: reconciliation.ownCount, now: reconciliation.ownCountNow }), tone: "warning" };
  }
  return { verdict: text.mismatch, tone: "warning" };
}

export function reconciliationView(read: Extract<FinancePeriod, { period: object }>, now: string): ReconciliationView {
  const { period, reconciliation } = read;
  const closed = period.status === "closed" || period.status === "paid";
  const ended = period.status === "closing" || (period.status === "open" && Date.parse(period.endsAt) <= Date.parse(now));
  const explainable = !closed && read.freshCode;

  let last: ReconciliationView["last"] = { kind: "never" };
  if (reconciliation !== null) {
    const notes: string[] = [];
    if (!reconciliation.complete) notes.push(text.incomplete);
    if (reconciliation.providerPending > 0) notes.push(t(plural(reconciliation.providerPending, text.pending), { count: reconciliation.providerPending }));
    if (reconciliation.tooMany) notes.push(text.tooMany);
    if (!reconciliation.livemode) notes.push(text.testMode);
    last = {
      kind: "compared",
      when: t(text.last, {
        date: longDate(reconciliation.registeredAt),
        time: clockTime(reconciliation.registeredAt, PRODUCT_TIME_ZONE),
        ago: daysAgo(reconciliation.registeredAt, now),
      }),
      by: reconciliation.requested ? text.byPerson : text.bySchedule,
      // Los totales son del periodo, en pesos: lo que va en otra moneda es una diferencia aparte.
      own: t(plural(reconciliation.ownCount, text.own), { count: reconciliation.ownCount, amount: amountIn(reconciliation.ownCents, "mxn") }),
      provider: t(plural(reconciliation.providerCount, text.provider), { count: reconciliation.providerCount, amount: amountIn(reconciliation.providerCents, "mxn") }),
      ...verdictOf(reconciliation),
      notes,
      differences: reconciliation.differences.map((difference, index) => differenceRow(difference, index, explainable)),
    };
  }

  return {
    readOnly: closed,
    compare: !closed && ended ? reconcileButton.compare() : null,
    notYet: !closed && !ended,
    canExplain: explainable,
    last,
  };
}
