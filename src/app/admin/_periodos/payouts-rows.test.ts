import { describe, expect, it } from "vitest";

import type { FinancePayouts, PayoutRow } from "@/services/periods/periods";

import { payoutsButton } from "./payouts-outcomes";
import { acceptedReleaseNotice, payoutsView } from "./payouts-rows";

// Lo que PA-81 pinta con cada lectura: qué se ofrece, con qué valor viaja cada botón y cómo se dicen las
// cifras. Pura: sin servicios ni base.

const PERIOD = 202710;
const SEEN = "ab".repeat(32);
const UNHOLD = "cd".repeat(32);
const T1 = "a1000000-0000-4000-8000-000000000001";
const T2 = "a1000000-0000-4000-8000-000000000002";
const T3 = "a1000000-0000-4000-8000-000000000003";
const Y1 = "d1000000-0000-4000-8000-000000000001";
const Y2 = "d1000000-0000-4000-8000-000000000002";
const B1 = "e1000000-0000-4000-8000-000000000001";

type Read = Extract<FinancePayouts, { period: object }>;

const row = (over: Partial<PayoutRow>): PayoutRow => ({
  teacherId: T1,
  name: "Maestra Uno",
  payoutId: Y1,
  status: "calculated",
  isSelf: false,
  heldFromStatus: null,
  holdReason: null,
  heldAt: null,
  releasedAt: null,
  poolCents: 24494,
  founderBonus: null,
  manualBonusesCents: 0,
  adjustmentsCents: 0,
  balanceCents: 0,
  subtotalCents: 24494,
  estimated: true,
  reachesMinimum: true,
  unholdFingerprint: null,
  ...over,
});

const read = (over: Partial<Read> = {}, period: Partial<Read["period"]> = {}): Read => ({
  freshCode: true,
  period: { periodId: PERIOD, status: "closed", closedAt: "2027-11-02T10:00:00Z", payoutsReleasedAt: null, paidAt: null, minimumCents: 10000, changedAt: null, ...period },
  release: { fingerprint: SEEN, pendingFounderBonuses: 0 },
  payouts: [row({})],
  ...over,
});

describe("liberar", () => {
  it("se ofrece con la huella de la vista, en los dos pasos", () => {
    const view = payoutsView(read());
    expect(view.release).toMatchObject({ kind: "offered", seen: SEEN, ask: payoutsButton.askRelease(PERIOD, SEEN), confirm: payoutsButton.release(PERIOD, SEEN) });
  });

  it("el diálogo dice cuántas se pagan y cuántas se acumulan; las retenidas no cuentan", () => {
    const view = payoutsView(
      read({
        payouts: [
          row({}),
          row({ teacherId: T2, payoutId: Y2, reachesMinimum: false, subtotalCents: 3852 }),
          row({ teacherId: T3, payoutId: null, status: null, reachesMinimum: false }),
          row({ teacherId: "a1000000-0000-4000-8000-000000000004", payoutId: "d1000000-0000-4000-8000-000000000004", status: "on_hold" }),
        ],
      }),
    );
    expect(view.release.kind === "offered" && view.release.body).toMatch(/^1 liquidación pasa a «en espera de factura» y 2 a «acumulada»/);
  });

  it("con bonos de fundador por decidir no se ofrece: dice cuántos faltan", () => {
    expect(payoutsView(read({ release: { fingerprint: SEEN, pendingFounderBonuses: 2 } })).release).toEqual({
      kind: "waits",
      text: "Liberar liquidaciones: falta decidir 2 bonos de fundador.",
    });
  });

  it("sin el código reciente, o ya liberado, no se ofrece", () => {
    expect(payoutsView(read({ freshCode: false })).release).toEqual({ kind: "none" });
    expect(payoutsView(read({ release: null }, { payoutsReleasedAt: "2027-11-02T12:00:00Z" })).release).toEqual({ kind: "none" });
  });
});

describe("la liquidación de quien lee (T-401)", () => {
  it("se marca como suya, y no se retiene, no se suelta ni se decide su bono", () => {
    const bonus = { bonusId: "e1000000-0000-4000-8000-000000000009", status: "proposed" as const, amountCents: 502, basisCents: 3350 };
    const [mine, other] = payoutsView(
      read({ payouts: [row({ isSelf: true, founderBonus: bonus }), row({ teacherId: T2, payoutId: Y2, name: "Maestra Dos" })] }),
    ).rows;
    expect(mine?.teacher).toBe("Maestra Uno (tú)");
    expect(mine?.hold).toBeNull();
    expect(mine?.founderBonus).toBeNull();
    expect(other?.teacher).toBe("Maestra Dos");
    expect(other?.hold).not.toBeNull();
    const held = payoutsView(read({ payouts: [row({ isSelf: true, status: "on_hold", heldFromStatus: "calculated", unholdFingerprint: UNHOLD })] })).rows[0];
    expect(held?.unhold).toBeNull();
  });

  it("liberar no se bloquea, pero el diálogo dice que incluye la suya", () => {
    const view = payoutsView(read({ payouts: [row({ isSelf: true }), row({ teacherId: T2, payoutId: Y2 })] }));
    expect(view.release.kind === "offered" && view.release.body).toMatch(/Incluye tu liquidación como maestro\.$/);
    expect(payoutsView(read()).release.kind === "offered" && payoutsView(read()).release).not.toMatchObject({ body: expect.stringMatching(/Incluye/) });
  });
});

describe("las filas", () => {
  it("sin liberar, el bruto se dice estimado; liberado, no", () => {
    expect(payoutsView(read()).rows[0]?.subtotal).toMatch(/^\$244\.94 \(estimado\)$/);
    expect(payoutsView(read({ release: null, payouts: [row({ estimated: false, status: "awaiting_invoice" })] }, { payoutsReleasedAt: "2027-11-02T12:00:00Z" })).rows[0]?.subtotal).toBe("$244.94");
  });

  it("retener lleva el estado que se vio; una acumulada o una pagada no se retiene", () => {
    const [calculated, carried] = payoutsView(read({ payouts: [row({}), row({ teacherId: T2, payoutId: Y2, status: "carried_forward" })] })).rows;
    expect(calculated?.hold).toEqual({ ask: payoutsButton.askHold(Y1, "calculated"), confirm: payoutsButton.hold(Y1, "calculated"), status: "calculated" });
    expect(carried?.hold).toBeNull();
  });

  it("soltar una retenida desde calculada en un periodo liberado la libera: el botón pide la casilla y dice el bruto", () => {
    const held = row({ status: "on_hold", heldFromStatus: "calculated", unholdFingerprint: UNHOLD, subtotalCents: 3852, reachesMinimum: false, holdReason: "Se investiga." });
    const [view] = payoutsView(read({ release: null, payouts: [held] }, { payoutsReleasedAt: "2027-11-02T12:00:00Z" })).rows;
    expect(view?.unhold).toMatchObject({ ask: payoutsButton.askUnhold(Y1, UNHOLD), confirm: payoutsButton.unhold(Y1, UNHOLD, true), releases: true });
    expect(view?.unhold?.body).toBe("Este periodo ya se liberó: soltarla la libera ahora, con un bruto de $38.52. Queda «Acumulada».");
    expect(view?.holdReason).toBe("Retenida: Se investiga.");
  });

  it("antes de liberar, soltar solo la devuelve a donde estaba", () => {
    const held = row({ status: "on_hold", heldFromStatus: "calculated", unholdFingerprint: UNHOLD });
    const [view] = payoutsView(read({ payouts: [held] })).rows;
    expect(view?.unhold).toMatchObject({ confirm: payoutsButton.unhold(Y1, UNHOLD, false), releases: false, body: "Vuelve a «Calculada»." });
  });

  it("el bono del fundador propuesto se confirma o se anula desde la fila, solo sin liberar", () => {
    const founder = row({ founderBonus: { bonusId: B1, status: "proposed", amountCents: 502, basisCents: 3350 } });
    const [open] = payoutsView(read({ payouts: [founder] })).rows;
    expect(open?.founder).toBe("Propuesto: $5.02");
    expect(open?.founderBonus).toEqual({ id: B1, confirm: payoutsButton.confirmBonus(B1), askVoid: payoutsButton.askVoid(B1), void: payoutsButton.void(B1) });
    const [released] = payoutsView(read({ release: null, payouts: [founder] }, { payoutsReleasedAt: "2027-11-02T12:00:00Z" })).rows;
    expect(released?.founderBonus).toBeNull();
  });

  it("sin el código reciente, o con el periodo pagado, no se ofrece ningún cambio", () => {
    for (const view of [payoutsView(read({ freshCode: false })), payoutsView(read({}, { status: "paid" }))]) {
      expect(view.canChange).toBe(false);
      expect(view.rows.every((each) => each.hold === null && each.unhold === null && each.founderBonus === null)).toBe(true);
    }
  });

  it("quien no tiene liquidación todavía y quien no tiene nombre publicado se distinguen", () => {
    const [pending] = payoutsView(read({ payouts: [row({ payoutId: null, status: null, name: null })] })).rows;
    expect(pending?.status).toBe("Sin liquidación todavía");
    expect(pending?.teacher).toBe("Sin nombre publicado (a1000000)");
    expect(pending?.hold).toBeNull();
  });

  it("los totales suman lo que se ve", () => {
    const view = payoutsView(read({ payouts: [row({}), row({ teacherId: T2, payoutId: Y2, poolCents: 1, subtotalCents: 1 })] }));
    expect(view.totals).toMatchObject({ pool: "$244.95", subtotal: "$244.95" });
  });

  it("el filtro: todas y uno por estado, con su cuenta", () => {
    const view = payoutsView(read({ payouts: [row({}), row({ teacherId: T2, payoutId: Y2, status: "on_hold" }), row({ teacherId: T3, payoutId: null, status: null })] }));
    expect(view.filters.map((each) => each.label)).toEqual(["Todas (3)", "Calculada (1)", "Retenida (1)", "Sin liquidación todavía (1)"]);
  });
});

describe("el periodo", () => {
  it("abierto o en cierre no tiene liquidaciones", () => {
    expect(payoutsView(read({ release: null, payouts: [] }, { status: "closing" })).notClosed).toBe(true);
  });

  it("el aviso de liberado solo se pinta si este periodo se liberó hace un momento", () => {
    const at = "2027-11-02T12:00:00.000Z";
    expect(acceptedReleaseNotice(read({}, { payoutsReleasedAt: at }), "2027-11-02T12:01:00.000Z")).toBe(true);
    expect(acceptedReleaseNotice(read({}, { payoutsReleasedAt: at }), "2027-11-02T12:05:00.000Z")).toBe(false);
    expect(acceptedReleaseNotice(read(), "2027-11-02T12:01:00.000Z")).toBe(false);
  });
});
