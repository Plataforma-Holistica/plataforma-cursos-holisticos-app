import { describe, expect, it } from "vitest";

import { ROUTES } from "@/services/account/navigation";
import { EXCLUDE_ANSWERS, REVIEW_ANSWERS, REVOKE_ANSWERS } from "@/services/anomalies/anomalies";

import {
  alertsButton,
  alertsCodeOutcome,
  askedBy,
  excludeOutcome,
  fraudOutcome,
  readAlertsForm,
  reviewOutcome,
  revokeOutcome,
  type AlertsOutcome,
  type AlertsRequest,
} from "./outcomes";

// La tabla de PA-68 mínima: lo que llega, lo que contesta cada servicio y a dónde va. Pura: sin
// servicios ni base.

const ALERT = "a1e70000-0000-4000-8000-000000000002";
const EXCLUSION = "e0000000-0000-4000-8000-000000000003";
const ACCOUNT = "0123456789ab";
const TO_PAGE = { kind: "leave", to: ROUTES.alerts, notice: null };
const NO_DRAFTS = { note: undefined, evidence: undefined, reason: undefined, reasonCode: undefined };

function formWith(...values: [string, string | Blob][]) {
  const form = new FormData();
  for (const [name, value] of values) form.append(name, value);
  return form;
}

describe("readAlertsForm", () => {
  it("lee los valores que arma alertsButton, con lo escrito", () => {
    expect(readAlertsForm(formWith(["do", alertsButton.review(ALERT)], ["note", "La revisé."]))).toEqual({
      step: "review",
      alert: ALERT,
      drafts: { ...NO_DRAFTS, note: "La revisé." },
    });
    expect(readAlertsForm(formWith(["do", alertsButton.askFraud(ALERT)]))).toEqual({ step: "ask_fraud", alert: ALERT, drafts: NO_DRAFTS });
    expect(readAlertsForm(formWith(["do", alertsButton.fraud(ALERT)], ["evidence", "Once cuentas."]))).toEqual({
      step: "fraud",
      alert: ALERT,
      drafts: { ...NO_DRAFTS, evidence: "Once cuentas." },
    });
    expect(readAlertsForm(formWith(["do", alertsButton.askExclusion(ALERT, ACCOUNT)]))).toEqual({
      step: "ask_exclude",
      alert: ALERT,
      account: ACCOUNT,
      drafts: NO_DRAFTS,
    });
    expect(
      readAlertsForm(formWith(["do", alertsButton.exclude(ALERT, ACCOUNT)], ["reason_code", "test_account"], ["reason", "Es de prueba."])),
    ).toEqual({ step: "exclude", alert: ALERT, account: ACCOUNT, drafts: { ...NO_DRAFTS, reason: "Es de prueba.", reasonCode: "test_account" } });
    expect(readAlertsForm(formWith(["do", alertsButton.askRevocation(ALERT, EXCLUSION)]))).toEqual({
      step: "ask_revoke",
      alert: ALERT,
      exclusion: EXCLUSION,
      drafts: NO_DRAFTS,
    });
    expect(readAlertsForm(formWith(["do", alertsButton.revoke(ALERT, EXCLUSION)], ["reason", "Era un error."]))).toEqual({
      step: "revoke",
      alert: ALERT,
      exclusion: EXCLUSION,
      drafts: { ...NO_DRAFTS, reason: "Era un error." },
    });
    expect(readAlertsForm(formWith(["do", alertsButton.cancel()]))).toEqual({ step: "cancel" });
  });

  it("un campo que no es texto cuenta como vacío; uno desmedido se lee recortado, para que la base lo rechace", () => {
    const read = readAlertsForm(formWith(["do", alertsButton.review(ALERT)], ["note", new Blob(["x"])], ["reason", "y".repeat(10_000)]));
    expect(read).toMatchObject({ step: "review", drafts: { note: undefined } });
    expect((read as Extract<AlertsRequest, { step: "review" }>).drafts.reason).toHaveLength(4_100);
  });

  it.each([
    ["no es un formulario", "texto"],
    ["sin do", formWith()],
    ["dos do", formWith(["do", alertsButton.review(ALERT)], ["do", alertsButton.fraud(ALERT)])],
    ["un do que no es texto", formWith(["do", new Blob([alertsButton.review(ALERT)])])],
    ["un do vacío", formWith(["do", ""])],
    ["un do desmedido", formWith(["do", `review:${ALERT}${"x".repeat(200)}`])],
    ["un verbo que no existe", formWith(["do", `suspend:${ALERT}`])],
    ["una alerta sin forma", formWith(["do", "review:no-es-un-id"])],
    ["una alerta en mayúsculas", formWith(["do", `review:${ALERT.toUpperCase()}`])],
    ["revisar con una cuenta", formWith(["do", `review:${ALERT}:${ACCOUNT}`])],
    ["excluir sin cuenta", formWith(["do", `exclude:${ALERT}`])],
    ["excluir con un identificador por cuenta", formWith(["do", `exclude:${ALERT}:${EXCLUSION}`])],
    ["excluir con la cuenta en mayúsculas", formWith(["do", `exclude:${ALERT}:${ACCOUNT.toUpperCase()}`])],
    ["excluir con una huella corta", formWith(["do", `exclude:${ALERT}:${ACCOUNT.slice(1)}`])],
    ["excluir con una huella larga", formWith(["do", `exclude:${ALERT}:${ACCOUNT}0`])],
    ["revertir con una huella por exclusión", formWith(["do", `revoke:${ALERT}:${ACCOUNT}`])],
    ["revertir sin alerta", formWith(["do", `revoke:${EXCLUSION}`])],
    ["partes de más", formWith(["do", `exclude:${ALERT}:${ACCOUNT}:otra`])],
    ["cancelar con alerta", formWith(["do", `cancel:${ALERT}`])],
  ])("%s: none", (_what, form) => {
    expect(readAlertsForm(form)).toEqual({ step: "none" });
  });
});

describe("askedBy", () => {
  const request = (step: string, drafts = {}) =>
    ({ step, alert: ALERT, account: ACCOUNT, exclusion: EXCLUSION, drafts: { ...NO_DRAFTS, ...drafts } }) as AlertsRequest;

  it("el primer paso pregunta, sin problema", () => {
    expect(askedBy(request("ask_fraud"))).toEqual({ confirming: { step: "fraud", alert: ALERT }, problem: null });
    expect(askedBy(request("ask_exclude"))).toEqual({ confirming: { step: "exclude", alert: ALERT, account: ACCOUNT }, problem: null });
    expect(askedBy(request("ask_revoke"))).toEqual({ confirming: { step: "revoke", alert: ALERT, exclusion: EXCLUSION }, problem: null });
  });

  it("confirmar sin lo que hay que escribir vuelve a preguntar, con lo que falta", () => {
    expect(askedBy(request("fraud", { evidence: "  " }))).toEqual({ confirming: { step: "fraud", alert: ALERT }, problem: "missing_evidence" });
    expect(askedBy(request("exclude", { reasonCode: "other" }))).toMatchObject({ problem: "missing_reason" });
    expect(askedBy(request("exclude", { reason: "Un motivo." }))).toMatchObject({ problem: "missing_reason" });
    expect(askedBy(request("exclude", { reasonCode: "", reason: "Un motivo." }))).toMatchObject({ problem: "missing_reason" });
    expect(askedBy(request("revoke", { reason: "\n" }))).toEqual({
      confirming: { step: "revoke", alert: ALERT, exclusion: EXCLUSION },
      problem: "missing_reason",
    });
  });

  it("con lo escrito, o lo que no pregunta, sigue al servicio", () => {
    expect(askedBy(request("fraud", { evidence: "Once cuentas." }))).toBeNull();
    expect(askedBy(request("exclude", { reasonCode: "other", reason: "Un motivo." }))).toBeNull();
    expect(askedBy(request("revoke", { reason: "Era un error." }))).toBeNull();
    expect(askedBy(request("review"))).toBeNull();
    expect(askedBy({ step: "none" })).toBeNull();
    expect(askedBy({ step: "cancel" })).toBeNull();
  });
});

const failed = (reason: string) => ({ kind: "failed", reason }) as AlertsOutcome;
const done = (notice: string) => ({ kind: "leave", to: ROUTES.alerts, notice }) as AlertsOutcome;

describe("reviewOutcome", () => {
  const cases: Record<(typeof REVIEW_ANSWERS)[number], AlertsOutcome> = {
    reviewed: done("alert_reviewed"),
    // Revisar no decide fraude: si la base contestara esto, ya estaba revisada.
    marked_fraud: failed("already_reviewed"),
    already_reviewed: failed("already_reviewed"),
    forbidden: TO_PAGE as AlertsOutcome,
    needs_fresh_code: failed("needs_code"),
    malformed: failed("missing_note"),
    not_found: failed("not_found"),
  };

  it.each(REVIEW_ANSWERS)("la base contesta %s", (answer) => {
    expect(reviewOutcome({ kind: "answered", answer })).toEqual(cases[answer]);
  });

  it("refused, no se supo y sin forma", () => {
    expect(reviewOutcome({ kind: "refused" })).toEqual(TO_PAGE);
    expect(reviewOutcome({ kind: "unavailable" })).toEqual(failed("unavailable"));
    expect(reviewOutcome({ kind: "unknown" })).toEqual(failed("unknown"));
    expect(reviewOutcome({ kind: "malformed" })).toEqual(failed("missing_note"));
  });
});

describe("fraudOutcome", () => {
  const cases: Record<(typeof REVIEW_ANSWERS)[number], AlertsOutcome> = {
    // Con la alerta abierta, la revisa y la decide a la vez.
    reviewed: done("fraud_decided"),
    marked_fraud: done("fraud_decided"),
    already_reviewed: failed("already_fraud"),
    forbidden: TO_PAGE as AlertsOutcome,
    needs_fresh_code: failed("needs_code"),
    malformed: failed("missing_evidence"),
    not_found: failed("not_found"),
  };

  it.each(REVIEW_ANSWERS)("la base contesta %s", (answer) => {
    expect(fraudOutcome({ kind: "answered", answer })).toEqual(cases[answer]);
  });

  it("refused, no se supo y sin forma", () => {
    expect(fraudOutcome({ kind: "refused" })).toEqual(TO_PAGE);
    expect(fraudOutcome({ kind: "unavailable" })).toEqual(failed("unavailable"));
    expect(fraudOutcome({ kind: "unknown" })).toEqual(failed("unknown"));
    expect(fraudOutcome({ kind: "malformed" })).toEqual(failed("missing_evidence"));
  });
});

describe("excludeOutcome", () => {
  const cases: Record<(typeof EXCLUDE_ANSWERS)[number], AlertsOutcome> = {
    excluded: done("account_excluded"),
    already_excluded: failed("already_excluded"),
    outside_window: failed("closed"),
    needs_fraud_decision: failed("needs_fraud_decision"),
    not_related: failed("not_found"),
    not_found: failed("not_found"),
    malformed: failed("missing_reason"),
    forbidden: TO_PAGE as AlertsOutcome,
    needs_fresh_code: failed("needs_code"),
  };

  it.each(EXCLUDE_ANSWERS)("la base contesta %s", (answer) => {
    expect(excludeOutcome({ kind: "answered", answer })).toEqual(cases[answer]);
  });

  it("refused, no se supo y sin forma", () => {
    expect(excludeOutcome({ kind: "refused" })).toEqual(TO_PAGE);
    expect(excludeOutcome({ kind: "unavailable" })).toEqual(failed("unavailable"));
    expect(excludeOutcome({ kind: "unknown" })).toEqual(failed("unknown"));
    expect(excludeOutcome({ kind: "malformed" })).toEqual(failed("missing_reason"));
  });
});

describe("revokeOutcome", () => {
  const cases: Record<(typeof REVOKE_ANSWERS)[number], AlertsOutcome> = {
    revoked: done("exclusion_revoked"),
    already_revoked: failed("already_revoked"),
    outside_window: failed("closed"),
    not_found: failed("not_found"),
    malformed: failed("missing_reason"),
    forbidden: TO_PAGE as AlertsOutcome,
    needs_fresh_code: failed("needs_code"),
  };

  it.each(REVOKE_ANSWERS)("la base contesta %s", (answer) => {
    expect(revokeOutcome({ kind: "answered", answer })).toEqual(cases[answer]);
  });

  it("refused, no se supo y sin forma", () => {
    expect(revokeOutcome({ kind: "refused" })).toEqual(TO_PAGE);
    expect(revokeOutcome({ kind: "unavailable" })).toEqual(failed("unavailable"));
    expect(revokeOutcome({ kind: "unknown" })).toEqual(failed("unknown"));
    expect(revokeOutcome({ kind: "malformed" })).toEqual(failed("missing_reason"));
  });
});

describe("alertsCodeOutcome", () => {
  it("dado el código, a esta página; sin él, se dice", () => {
    expect(alertsCodeOutcome({ kind: "verified" })).toEqual(TO_PAGE);
    expect(alertsCodeOutcome({ kind: "refused" })).toEqual(TO_PAGE);
    expect(alertsCodeOutcome({ kind: "wrong_code" })).toEqual({ kind: "failed", reason: "wrong_code" });
    expect(alertsCodeOutcome({ kind: "not_available" })).toEqual({ kind: "failed", reason: "not_available" });
  });
});
