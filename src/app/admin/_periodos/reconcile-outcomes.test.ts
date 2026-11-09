import { describe, expect, it } from "vitest";

import { periodPath } from "@/services/account/navigation";
import { EXPLAIN_ANSWERS, EXPLAIN_NOTE_MAX, RECORD_ANSWERS, WINDOW_ANSWERS } from "@/services/billing/reconcile";
import { EXPLAINABLE_SIDES } from "@/services/periods/periods";

import { answerTone, RECONCILE_ANSWERS, RECONCILE_FAILURES, reconcileToneOf } from "./reconcile-failures";
import {
  askedBy,
  compareOutcome,
  EXPLAINABLE,
  explainOutcome,
  NOTE_MAX,
  readReconcileForm,
  reconcileButton,
  type AskedDifference,
  type ReconcileFailure,
} from "./reconcile-outcomes";

// La tabla de la conciliación de PA-79 (T-303, cuarta solicitud): lo que llega, lo que contesta cada servicio y lo que se dice. Pura: sin servicios ni base.

const PERIOD = 202710;
const PANEL = { kind: "leave", to: periodPath(PERIOD), notice: null };
const failed = (reason: ReconcileFailure) => ({ kind: "failed", reason });
const ONLY_PROVIDER: AskedDifference = { side: "only_provider", currency: "mxn", cents: "34900", charge: "ch_3Abc" };

function formWith(...values: [string, string | Blob][]) {
  const form = new FormData();
  for (const [name, value] of values) form.append(name, value);
  return form;
}

describe("lo que copia de la base", () => {
  it("lo que se explica y el tope de la nota son los del servicio", () => {
    expect([...EXPLAINABLE]).toEqual([...EXPLAINABLE_SIDES]);
    expect(NOTE_MAX).toBe(EXPLAIN_NOTE_MAX);
  });
});

describe("readReconcileForm", () => {
  it("lee los valores que arma reconcileButton, con la nota", () => {
    expect(readReconcileForm(formWith(["do", reconcileButton.compare()]))).toEqual({ step: "compare" });
    expect(readReconcileForm(formWith(["do", reconcileButton.cancel()]))).toEqual({ step: "cancel" });
    expect(readReconcileForm(formWith(["do", reconcileButton.askExplain(ONLY_PROVIDER)]))).toEqual({ step: "ask_explain", ...ONLY_PROVIDER, note: undefined });
    expect(readReconcileForm(formWith(["do", reconcileButton.explain(ONLY_PROVIDER)], ["note", "Un cargo de prueba"]))).toEqual({
      step: "explain",
      ...ONLY_PROVIDER,
      note: "Un cargo de prueba",
    });
  });

  it("un cargo con «:» llega entero, y la nota se corta un poco después del tope para que el servicio la rechace", () => {
    const odd: AskedDifference = { side: "other_currency", currency: "usd", cents: "0", charge: "py_1:2:3" };
    expect(readReconcileForm(formWith(["do", reconcileButton.explain(odd)]))).toMatchObject({ step: "explain", charge: "py_1:2:3", currency: "usd", cents: "0" });
    const long = readReconcileForm(formWith(["do", reconcileButton.explain(ONLY_PROVIDER)], ["note", "x".repeat(2_000)]));
    expect(long.step === "explain" && long.note?.length).toBe(600);
  });

  it.each([
    ["sin botón", formWith()],
    ["dos botones", formWith(["do", "compare"], ["do", "compare"])],
    ["comparar con algo", formWith(["do", "compare:202710"])],
    ["un lado que no se explica", formWith(["do", "explain:only_own:mxn:100:ch_1"])],
    ["otro monto", formWith(["do", "ask_explain:amount:mxn:100:ch_1"])],
    ["un lado desconocido", formWith(["do", "explain:other:mxn:100:ch_1"])],
    ["una moneda sin forma", formWith(["do", "explain:only_provider:MXN:100:ch_1"])],
    ["centavos negativos", formWith(["do", "explain:only_provider:mxn:-1:ch_1"])],
    ["centavos con ceros a la izquierda", formWith(["do", "explain:only_provider:mxn:0100:ch_1"])],
    ["sin cargo", formWith(["do", "explain:only_provider:mxn:100:"])],
    ["un cargo con espacios", formWith(["do", "explain:only_provider:mxn:100:ch 1"])],
    ["un verbo desconocido", formWith(["do", "undo:only_provider:mxn:100:ch_1"])],
    ["un archivo", formWith(["do", new Blob(["compare"])])],
    ["desmedido", formWith(["do", `explain:only_provider:mxn:100:${"c".repeat(400)}`])],
  ])("%s no es nada", (_name, form) => {
    expect(readReconcileForm(form)).toEqual({ step: "none" });
  });

  it("lo que no es un formulario no es nada", () => {
    expect(readReconcileForm(null)).toEqual({ step: "none" });
    expect(readReconcileForm({ do: "compare" })).toEqual({ step: "none" });
  });
});

describe("askedBy", () => {
  it("el primer paso pregunta; confirmar sin nota (o con solo espacios) vuelve a preguntar; con nota, no", () => {
    expect(askedBy({ step: "ask_explain", ...ONLY_PROVIDER, note: undefined })).toEqual({ asked: ONLY_PROVIDER, note: undefined, problem: null });
    expect(askedBy({ step: "explain", ...ONLY_PROVIDER, note: "  " })).toEqual({ asked: ONLY_PROVIDER, note: "  ", problem: "missing_note" });
    expect(askedBy({ step: "explain", ...ONLY_PROVIDER, note: undefined })).toMatchObject({ problem: "missing_note" });
    expect(askedBy({ step: "explain", ...ONLY_PROVIDER, note: "Ya se registró" })).toBeNull();
    expect(askedBy({ step: "compare" })).toBeNull();
  });
});

describe("compareOutcome", () => {
  it("lo que salió: coincide, no coincide, o incompleta (que nunca coincide)", () => {
    const recorded = (matches: boolean, complete: boolean) => ({ kind: "compared" as const, result: { kind: "recorded" as const, matches, complete, differences: 0 } });
    expect(compareOutcome(recorded(true, true), PERIOD)).toEqual({ kind: "done", answer: "matches" });
    expect(compareOutcome(recorded(false, true), PERIOD)).toEqual({ kind: "done", answer: "mismatch" });
    expect(compareOutcome(recorded(false, false), PERIOD)).toEqual({ kind: "done", answer: "incomplete" });
  });

  it.each([...new Set([...WINDOW_ANSWERS, ...RECORD_ANSWERS])])("cada respuesta de la base tiene su caso: %s", (answer) => {
    expect(compareOutcome({ kind: "compared", result: { kind: "refused", answer } }, PERIOD)).toBeDefined();
  });

  it("lo demás", () => {
    const refused = (answer: (typeof RECORD_ANSWERS)[number]) => compareOutcome({ kind: "compared", result: { kind: "refused", answer } }, PERIOD);
    expect(refused("forbidden")).toEqual(PANEL);
    expect(refused("not_found")).toEqual(failed("not_found"));
    expect(refused("closed")).toEqual(failed("closed"));
    expect(refused("too_early")).toEqual(failed("too_early"));
    expect(refused("rate_limited")).toEqual(failed("rate_limited"));
    expect(refused("malformed")).toEqual(failed("unknown"));
    expect(compareOutcome({ kind: "compared", result: { kind: "no_stripe" } }, PERIOD)).toEqual(failed("no_stripe"));
    expect(compareOutcome({ kind: "compared", result: { kind: "unknown" } }, PERIOD)).toEqual(failed("unknown"));
    expect(compareOutcome({ kind: "refused" }, PERIOD)).toEqual(PANEL);
    expect(compareOutcome({ kind: "unavailable" }, PERIOD)).toEqual(failed("unavailable"));
  });
});

describe("explainOutcome", () => {
  it.each(EXPLAIN_ANSWERS)("cada respuesta tiene su caso: %s", (answer) => {
    expect(explainOutcome({ kind: "answered", answer }, PERIOD)).toBeDefined();
  });

  it("explicada, o ya estaba; lo demás se dice", () => {
    expect(explainOutcome({ kind: "answered", answer: "explained" }, PERIOD)).toEqual({ kind: "done", answer: "explained" });
    expect(explainOutcome({ kind: "answered", answer: "exists" }, PERIOD)).toEqual({ kind: "done", answer: "already_explained" });
    expect(explainOutcome({ kind: "answered", answer: "not_explainable" }, PERIOD)).toEqual(failed("not_explainable"));
    expect(explainOutcome({ kind: "answered", answer: "not_in_comparison" }, PERIOD)).toEqual(failed("not_in_comparison"));
    expect(explainOutcome({ kind: "answered", answer: "closed" }, PERIOD)).toEqual(failed("closed"));
    expect(explainOutcome({ kind: "answered", answer: "not_found" }, PERIOD)).toEqual(failed("not_found"));
    expect(explainOutcome({ kind: "answered", answer: "malformed" }, PERIOD)).toEqual(failed("missing_note"));
    expect(explainOutcome({ kind: "answered", answer: "needs_fresh_code" }, PERIOD)).toEqual(failed("needs_code"));
    expect(explainOutcome({ kind: "answered", answer: "forbidden" }, PERIOD)).toEqual(PANEL);
    expect(explainOutcome({ kind: "malformed" }, PERIOD)).toEqual(failed("missing_note"));
    expect(explainOutcome({ kind: "refused" }, PERIOD)).toEqual(PANEL);
    expect(explainOutcome({ kind: "unavailable" }, PERIOD)).toEqual(failed("unavailable"));
    expect(explainOutcome({ kind: "unknown" }, PERIOD)).toEqual(failed("unknown"));
  });
});

describe("los textos", () => {
  it("cada respuesta tiene su texto y su tono: lo que no se supo y la falta de llave, de peligro", () => {
    for (const [reason, said] of Object.entries(RECONCILE_FAILURES)) expect(said.length, reason).toBeGreaterThan(0);
    for (const [answer, said] of Object.entries(RECONCILE_ANSWERS)) expect(said.length, answer).toBeGreaterThan(0);
    expect(reconcileToneOf("unknown")).toBe("danger");
    expect(reconcileToneOf("no_stripe")).toBe("danger");
    expect(reconcileToneOf("rate_limited")).toBe("warning");
    expect(answerTone("matches")).toBe("success");
    expect(answerTone("explained")).toBe("success");
    expect(answerTone("mismatch")).toBe("warning");
    expect(answerTone("incomplete")).toBe("warning");
  });
});
