import { describe, expect, it } from "vitest";

import { ROUTES } from "@/services/account/navigation";

import { askedBy, billingButton, readBillingForm, resolveOutcome, retryOutcome } from "./outcomes";

const EVENT = "e0000000-0000-4000-8000-000000000001";

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) for (const each of [value].flat()) data.append(key, each);
  return data;
}

describe("lo que llega", () => {
  it("el botón dice qué, de qué aviso y con qué revisión", () => {
    expect(readBillingForm(form({ do: billingButton.retry(EVENT, 3) }))).toEqual({ step: "retry", event: EVENT, revision: "3", note: undefined });
    expect(readBillingForm(form({ do: billingButton.askResolve(EVENT, 3) }))).toMatchObject({ step: "ask_resolve", event: EVENT, revision: "3" });
    expect(readBillingForm(form({ do: billingButton.resolve(EVENT, 3), note: "Ya se aplicó a mano" }))).toEqual({
      step: "resolve",
      event: EVENT,
      revision: "3",
      note: "Ya se aplicó a mano",
    });
    expect(readBillingForm(form({ do: billingButton.cancel() }))).toEqual({ step: "cancel" });
  });

  it("un envío sin intención, con dos, o con un aviso sin forma no pide nada", () => {
    expect(readBillingForm(form({}))).toEqual({ step: "none" });
    expect(readBillingForm(form({ do: [billingButton.retry(EVENT, 3), billingButton.retry(EVENT, 3)] }))).toEqual({ step: "none" });
    expect(readBillingForm(form({ do: "retry:no-es-un-id:3" }))).toEqual({ step: "none" });
    expect(readBillingForm(form({ do: `retry:${EVENT}:3:mas` }))).toEqual({ step: "none" });
    expect(readBillingForm(form({ do: `borrar:${EVENT}:3` }))).toEqual({ step: "none" });
    expect(readBillingForm("no es un formulario")).toEqual({ step: "none" });
  });
});

describe("resolver se pregunta antes", () => {
  it("el primer paso pregunta sin llamar a nadie; confirmar sin nota vuelve a preguntar", () => {
    expect(askedBy({ step: "ask_resolve", event: EVENT, revision: "3", note: undefined })).toEqual({ event: EVENT, revision: "3", problem: null });
    expect(askedBy({ step: "resolve", event: EVENT, revision: "3", note: "   " })).toEqual({ event: EVENT, revision: "3", problem: "missing_note" });
    expect(askedBy({ step: "resolve", event: EVENT, revision: "3", note: "Nota" })).toBeNull();
    expect(askedBy({ step: "retry", event: EVENT, revision: "3", note: undefined })).toBeNull();
  });
});

describe("lo que contestó reintentar", () => {
  it("procesado, ya aplicado o en camino vuelven a la página con su aviso", () => {
    expect(retryOutcome({ kind: "ran", run: { kind: "processed" } })).toEqual({ kind: "leave", to: ROUTES.billingEvents, notice: "billing_event_processed" });
    expect(retryOutcome({ kind: "ran", run: { kind: "already_applied" } })).toMatchObject({ notice: "billing_event_already_applied" });
    for (const kind of ["busy", "still_pending"] as const) {
      expect(retryOutcome({ kind: "ran", run: { kind } })).toMatchObject({ notice: "billing_event_on_its_way" });
    }
  });

  it("si volvió a fallar o volvió a la fila, lo dice con su código", () => {
    expect(retryOutcome({ kind: "ran", run: { kind: "failed", code: "unknown_account" } })).toEqual({ kind: "failed", reason: "failed_again", code: "unknown_account" });
    expect(retryOutcome({ kind: "ran", run: { kind: "retry", code: "provider_unavailable" } })).toEqual({
      kind: "failed",
      reason: "requeued",
      code: "provider_unavailable",
    });
    expect(retryOutcome({ kind: "ran", run: { kind: "changed" } })).toEqual({ kind: "failed", reason: "changed" });
  });

  it("lo que dijo la base sin reabrirlo", () => {
    expect(retryOutcome({ kind: "answered", answer: "changed" })).toEqual({ kind: "failed", reason: "changed" });
    expect(retryOutcome({ kind: "answered", answer: "not_failed" })).toEqual({ kind: "failed", reason: "not_failed" });
    expect(retryOutcome({ kind: "answered", answer: "self" })).toEqual({ kind: "failed", reason: "self" });
    expect(retryOutcome({ kind: "answered", answer: "not_found" })).toEqual({ kind: "failed", reason: "not_found" });
    expect(retryOutcome({ kind: "answered", answer: "needs_fresh_code" })).toEqual({ kind: "failed", reason: "needs_code" });
    expect(retryOutcome({ kind: "answered", answer: "forbidden" })).toEqual({ kind: "leave", to: ROUTES.billingEvents, notice: null });
    expect(retryOutcome({ kind: "refused" })).toEqual({ kind: "leave", to: ROUTES.billingEvents, notice: null });
    expect(retryOutcome({ kind: "unavailable" })).toEqual({ kind: "failed", reason: "unavailable" });
    expect(retryOutcome({ kind: "unknown" })).toEqual({ kind: "failed", reason: "unknown" });
    expect(retryOutcome({ kind: "malformed" })).toEqual({ kind: "failed", reason: "not_found" });
  });
});

describe("lo que contestó resolver", () => {
  it("resuelto vuelve con su aviso; lo demás se dice", () => {
    expect(resolveOutcome({ kind: "answered", answer: "resolved" })).toEqual({ kind: "leave", to: ROUTES.billingEvents, notice: "billing_event_resolved" });
    expect(resolveOutcome({ kind: "answered", answer: "malformed" })).toEqual({ kind: "failed", reason: "missing_note" });
    expect(resolveOutcome({ kind: "malformed" })).toEqual({ kind: "failed", reason: "missing_note" });
    expect(resolveOutcome({ kind: "answered", answer: "changed" })).toEqual({ kind: "failed", reason: "changed" });
    expect(resolveOutcome({ kind: "answered", answer: "not_failed" })).toEqual({ kind: "failed", reason: "not_failed" });
    expect(resolveOutcome({ kind: "answered", answer: "self" })).toEqual({ kind: "failed", reason: "self" });
    expect(resolveOutcome({ kind: "answered", answer: "needs_fresh_code" })).toEqual({ kind: "failed", reason: "needs_code" });
    expect(resolveOutcome({ kind: "answered", answer: "forbidden" })).toMatchObject({ kind: "leave", notice: null });
    expect(resolveOutcome({ kind: "unknown" })).toEqual({ kind: "failed", reason: "unknown" });
  });
});
