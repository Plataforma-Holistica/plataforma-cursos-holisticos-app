import { describe, expect, it } from "vitest";

import { periodPayoutsPath, ROUTES } from "@/services/account/navigation";
import { CONFIRM_ANSWERS, HOLD_ANSWERS, PAYOUT_STATUSES, RELEASE_ANSWERS, UNHOLD_ANSWERS, VOID_ANSWERS } from "@/services/periods/periods";

import { payoutFailureText, payoutToneOf } from "./payouts-failures";
import {
  confirmOutcome,
  holdOutcome,
  payoutsButton,
  payoutsPeriodFrom,
  readPayoutsForm,
  releaseOutcome,
  unholdOutcome,
  voidOutcome,
  type PayoutFailure,
} from "./payouts-outcomes";

// La tabla de PA-81: lo que llega, lo que contesta cada servicio y a dónde va. Pura: sin servicios ni base.

const PERIOD = 202710;
const PAYOUT = "d1000000-0000-4000-8000-000000000001";
const BONUS = "e1000000-0000-4000-8000-000000000001";
const SEEN = "ab".repeat(32);
const PAGE = { kind: "leave", to: periodPayoutsPath(PERIOD), notice: null };
const UPDATED = { kind: "leave", to: periodPayoutsPath(PERIOD), notice: "payouts_updated" };
const failed = (reason: PayoutFailure) => ({ kind: "failed", reason });

function formWith(...values: [string, string | Blob][]) {
  const form = new FormData();
  for (const [name, value] of values) form.append(name, value);
  return form;
}

describe("readPayoutsForm", () => {
  it("lee los valores que arma payoutsButton, con lo que se vio", () => {
    expect(readPayoutsForm(formWith(["do", payoutsButton.askRelease(PERIOD, SEEN)]))).toEqual({ step: "ask_release", period: PERIOD, seen: SEEN });
    expect(readPayoutsForm(formWith(["do", payoutsButton.release(PERIOD, SEEN)], ["understood", "yes"]))).toEqual({
      step: "release",
      period: PERIOD,
      seen: SEEN,
      understood: true,
    });
    expect(readPayoutsForm(formWith(["do", payoutsButton.askHold(PAYOUT, "awaiting_invoice")]))).toEqual({ step: "ask_hold", payout: PAYOUT, status: "awaiting_invoice" });
    expect(readPayoutsForm(formWith(["do", payoutsButton.hold(PAYOUT, "calculated")], ["reason", "  Se revisa.  "]))).toEqual({
      step: "hold",
      payout: PAYOUT,
      status: "calculated",
      reason: "Se revisa.",
    });
    expect(readPayoutsForm(formWith(["do", payoutsButton.askUnhold(PAYOUT, SEEN)]))).toEqual({ step: "ask_unhold", payout: PAYOUT, seen: SEEN });
    expect(readPayoutsForm(formWith(["do", payoutsButton.unhold(PAYOUT, SEEN, false)], ["note", "Todo bien."]))).toEqual({
      step: "unhold",
      payout: PAYOUT,
      seen: SEEN,
      releases: false,
      note: "Todo bien.",
      understood: false,
    });
    expect(readPayoutsForm(formWith(["do", payoutsButton.unhold(PAYOUT, SEEN, true)], ["understood", "yes"]))).toMatchObject({ step: "unhold", releases: true, understood: true });
    expect(readPayoutsForm(formWith(["do", payoutsButton.confirmBonus(BONUS)]))).toEqual({ step: "confirm_bonus", bonus: BONUS });
    expect(readPayoutsForm(formWith(["do", payoutsButton.askVoid(BONUS)]))).toEqual({ step: "ask_void", bonus: BONUS });
    expect(readPayoutsForm(formWith(["do", payoutsButton.void(BONUS)], ["reason", "No aplica."]))).toEqual({ step: "void", bonus: BONUS, reason: "No aplica." });
    expect(readPayoutsForm(formWith(["do", payoutsButton.cancel()]))).toEqual({ step: "cancel" });
  });

  it("cada estado de una liquidación viaja en el botón de retener", () => {
    for (const status of PAYOUT_STATUSES) expect(readPayoutsForm(formWith(["do", payoutsButton.askHold(PAYOUT, status)]))).toMatchObject({ status });
  });

  it.each([
    ["sin do", formWith(["reason", "x"])],
    ["dos do", formWith(["do", payoutsButton.cancel()], ["do", payoutsButton.cancel()])],
    ["un do vacío", formWith(["do", ""])],
    ["un archivo", formWith(["do", new Blob(["cancel"])])],
    ["una huella sin forma", formWith(["do", `release:${PERIOD}:${"AB".repeat(32)}`])],
    ["una huella corta", formWith(["do", `release:${PERIOD}:abc`])],
    ["liberar sin huella", formWith(["do", `release:${PERIOD}`])],
    ["un periodo sin forma", formWith(["do", `release:202713:${SEEN}`])],
    ["un estado que no existe", formWith(["do", `hold:${PAYOUT}:frozen`])],
    ["retener sin estado", formWith(["do", `hold:${PAYOUT}`])],
    ["una liquidación sin forma", formWith(["do", `ask_unhold:${PAYOUT.toUpperCase()}:${SEEN}`])],
    ["un bono con algo más", formWith(["do", `confirm_bonus:${BONUS}:x`])],
    ["un paso que no existe", formWith(["do", `pay:${PAYOUT}`])],
    ["un pedazo de más", formWith(["do", `release:${PERIOD}:${SEEN}:x`])],
    ["cancelar con algo más", formWith(["do", "cancel:x"])],
  ])("%s no se entiende", (_name, form) => {
    expect(readPayoutsForm(form)).toEqual({ step: "none" });
  });

  it("lo que no es un formulario no se entiende", () => {
    expect(readPayoutsForm({ do: "cancel" })).toEqual({ step: "none" });
  });

  it("un motivo que no es texto, que viene dos veces o que pasa del tope cuenta como vacío", () => {
    expect(readPayoutsForm(formWith(["do", payoutsButton.void(BONUS)], ["reason", new Blob(["x"])]))).toMatchObject({ reason: "" });
    expect(readPayoutsForm(formWith(["do", payoutsButton.void(BONUS)], ["reason", "a"], ["reason", "b"]))).toMatchObject({ reason: "" });
    expect(readPayoutsForm(formWith(["do", payoutsButton.void(BONUS)], ["reason", "x".repeat(2001)]))).toMatchObject({ reason: "" });
  });

  it("la casilla solo cuenta con su valor", () => {
    expect(readPayoutsForm(formWith(["do", payoutsButton.release(PERIOD, SEEN)], ["understood", "on"]))).toMatchObject({ understood: false });
  });
});

describe("el periodo atado a la acción", () => {
  it("uno con forma sigue; sin forma, a la lista de periodos", () => {
    expect(payoutsPeriodFrom(PERIOD)).toEqual({ period: PERIOD });
    expect(payoutsPeriodFrom("202710")).toEqual({ leave: { kind: "leave", to: ROUTES.periods, notice: null } });
  });
});

describe("liberar", () => {
  it("cada respuesta de la base tiene su caso", () => {
    for (const answer of RELEASE_ANSWERS) {
      const outcome = releaseOutcome({ kind: "answered", answer, blockingPeriod: 202709, periodStatus: "closed", teachers: [] }, PERIOD);
      expect(outcome.kind, answer).toMatch(/^(leave|failed)$/);
    }
  });

  it("liberado vuelve a la página con su aviso", () => {
    expect(releaseOutcome({ kind: "answered", answer: "released", blockingPeriod: null, periodStatus: "paid", teachers: [] }, PERIOD)).toEqual({
      kind: "leave",
      to: periodPayoutsPath(PERIOD),
      notice: "payouts_released",
    });
  });

  it("lo que cambió desde que se vio, y el periodo que falta liberar, se dicen", () => {
    expect(releaseOutcome({ kind: "answered", answer: "preview_changed", blockingPeriod: null, periodStatus: null, teachers: [] }, PERIOD)).toEqual(failed("preview_changed"));
    expect(releaseOutcome({ kind: "answered", answer: "previous_not_released", blockingPeriod: 202709, periodStatus: null, teachers: [] }, PERIOD)).toEqual({
      kind: "failed",
      reason: "previous_not_released",
      detail: { period: 202709 },
    });
    expect(payoutFailureText("previous_not_released", { period: 202709 })).toContain("septiembre de 2027");
  });

  it("sin finanzas, a la página, donde decide su guarda; sin código reciente, se pide", () => {
    expect(releaseOutcome({ kind: "refused" }, PERIOD)).toEqual(PAGE);
    expect(releaseOutcome({ kind: "answered", answer: "forbidden", blockingPeriod: null, periodStatus: null, teachers: [] }, PERIOD)).toEqual(PAGE);
    expect(releaseOutcome({ kind: "answered", answer: "needs_fresh_code", blockingPeriod: null, periodStatus: null, teachers: [] }, PERIOD)).toEqual(failed("needs_code"));
  });

  it("el freno de producción: sin reglas, y sin los datos de alguien, se dice; no es una falla de la Plataforma", () => {
    const answer = (name: "withholding_rules_missing" | "tax_data_missing") => ({ kind: "answered" as const, answer: name, blockingPeriod: null, periodStatus: null, teachers: ["b0000000-0000-4000-8000-000000000002"] });
    expect(releaseOutcome(answer("withholding_rules_missing"), PERIOD)).toEqual(failed("rules_missing"));
    expect(releaseOutcome(answer("tax_data_missing"), PERIOD)).toEqual(failed("tax_data_missing"));
    for (const reason of ["rules_missing", "tax_data_missing", "unhold_no_data", "unhold_no_rule"] as const) {
      expect(payoutToneOf(reason), reason).toBe("warning");
      expect(payoutFailureText(reason).length, reason).toBeGreaterThan(0);
    }
  });

  it("retener por datos: el botón se lee, y a quien ya los tiene se le dice", () => {
    const form = new FormData();
    form.set("do", payoutsButton.holdForTax("d1000000-0000-4000-8000-000000000001", "calculated"));
    expect(readPayoutsForm(form)).toEqual({ step: "hold_for_tax", payout: "d1000000-0000-4000-8000-000000000001", status: "calculated" });
    expect(holdOutcome({ kind: "answered", answer: "has_tax_data", status: null }, PERIOD)).toEqual(failed("has_tax_data"));
    expect(payoutFailureText("has_tax_data").length).toBeGreaterThan(0);
  });

  it("soltar sin datos o sin regla se dice por separado: la liquidación sigue retenida", () => {
    expect(unholdOutcome({ kind: "answered", answer: "tax_data_missing", to: null }, PERIOD)).toEqual(failed("unhold_no_data"));
    expect(unholdOutcome({ kind: "answered", answer: "withholding_rules_missing", to: null }, PERIOD)).toEqual(failed("unhold_no_rule"));
  });

  it("el tope de tiempo y lo que no cuadra se dicen por su nombre; no se supo nunca es hecho", () => {
    expect(releaseOutcome({ kind: "timed_out" }, PERIOD)).toEqual(failed("timed_out"));
    expect(releaseOutcome({ kind: "unbalanced" }, PERIOD)).toEqual(failed("unbalanced"));
    expect(releaseOutcome({ kind: "unknown" }, PERIOD)).toEqual(failed("unknown"));
    expect(releaseOutcome({ kind: "malformed" }, PERIOD)).toEqual(failed("unknown"));
    expect(releaseOutcome({ kind: "unavailable" }, PERIOD)).toEqual(failed("unavailable"));
  });
});

describe("retener, soltar y el bono del fundador", () => {
  it("cada respuesta de la base tiene su caso", () => {
    for (const answer of HOLD_ANSWERS) expect(holdOutcome({ kind: "answered", answer, status: "paid" }, PERIOD).kind, answer).toMatch(/^(leave|failed)$/);
    for (const answer of UNHOLD_ANSWERS) expect(unholdOutcome({ kind: "answered", answer, to: null }, PERIOD).kind, answer).toMatch(/^(leave|failed)$/);
    for (const answer of CONFIRM_ANSWERS) expect(confirmOutcome({ kind: "answered", answer, status: null }, PERIOD).kind, answer).toMatch(/^(leave|failed)$/);
    for (const answer of VOID_ANSWERS) expect(voidOutcome({ kind: "answered", answer }, PERIOD).kind, answer).toMatch(/^(leave|failed)$/);
  });

  it("lo que sale bien vuelve a la página con el aviso de la tabla", () => {
    expect(holdOutcome({ kind: "answered", answer: "held", status: null }, PERIOD)).toEqual(UPDATED);
    expect(unholdOutcome({ kind: "answered", answer: "released_from_hold", to: "awaiting_invoice" }, PERIOD)).toEqual(UPDATED);
    expect(confirmOutcome({ kind: "answered", answer: "confirmed", status: null }, PERIOD)).toEqual(UPDATED);
    expect(voidOutcome({ kind: "answered", answer: "voided" }, PERIOD)).toEqual(UPDATED);
  });

  it("retener lo que ya se liberó dice que cambió; una acumulada, en qué estado está", () => {
    expect(holdOutcome({ kind: "answered", answer: "changed", status: "awaiting_invoice" }, PERIOD)).toEqual(failed("changed"));
    expect(holdOutcome({ kind: "answered", answer: "not_holdable", status: "carried_forward" }, PERIOD)).toEqual({
      kind: "failed",
      reason: "not_holdable",
      detail: { status: "carried_forward" },
    });
    expect(payoutFailureText("not_holdable", { status: "carried_forward" })).toContain("Acumulada");
  });

  it("un bono ya decidido dice cómo quedó: confirmado o anulado no son lo mismo", () => {
    expect(confirmOutcome({ kind: "answered", answer: "already_decided", status: "confirmed" }, PERIOD)).toEqual(failed("already_confirmed"));
    expect(confirmOutcome({ kind: "answered", answer: "already_decided", status: "void" }, PERIOD)).toEqual(failed("already_void"));
  });

  it("soltar puede liberar: el tope de tiempo y lo que no cuadra se dicen por su nombre", () => {
    expect(unholdOutcome({ kind: "timed_out" }, PERIOD)).toEqual(failed("timed_out"));
    expect(unholdOutcome({ kind: "unbalanced" }, PERIOD)).toEqual(failed("unbalanced"));
    expect(unholdOutcome({ kind: "answered", answer: "changed", to: null }, PERIOD)).toEqual(failed("changed"));
  });

  it("lo que la pantalla no ofrece solo llega armado a mano, y no se pinta como hecho", () => {
    expect(holdOutcome({ kind: "answered", answer: "no_alert", status: null }, PERIOD)).toEqual(failed("unknown"));
    expect(confirmOutcome({ kind: "answered", answer: "not_founder", status: null }, PERIOD)).toEqual(failed("unknown"));
  });
});
