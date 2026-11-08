import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-84, los avisos de cobro sin procesar (T-303, tercera solicitud). Las acciones de servidor son la frontera con los servicios: aquí se cambian por lo que
// contestarían.
const actions = vi.hoisted(() => ({ billingCodeAction: vi.fn(), billingEventsAction: vi.fn() }));
vi.mock("@/app/admin/_avisos/actions", () => actions);

import { billingButton, type BillingState } from "@/app/admin/_avisos/outcomes";
import { billingView } from "@/app/admin/_avisos/rows";
import { BillingEventsScreen } from "@/app/admin/_avisos/screen";
import { admin } from "@/messages/es/admin";
import type { BillingQueueData, BillingQueueEvent } from "@/services/billing/billing";

import { a11yViolations } from "../setup/a11y";

const text = admin.billingEvents;

beforeEach(() => {
  vi.resetAllMocks();
});

const FAILED: BillingQueueEvent = {
  id: "e0000000-0000-4000-8000-000000000001",
  revision: 4,
  providerEventId: "evt_falla",
  eventType: "invoice.paid",
  livemode: false,
  objectId: "in_1",
  occurredAt: "2026-11-07T18:00:00+00:00",
  receivedAt: "2026-11-07T18:00:05+00:00",
  status: "failed",
  attempts: 1,
  nextAttemptAt: "2026-11-07T18:01:00+00:00",
  lastError: "zero_invoice",
  isSelf: false,
};
const REFUND: BillingQueueEvent = { ...FAILED, id: "e0000000-0000-4000-8000-000000000002", providerEventId: "evt_reembolso", eventType: "charge.refunded", status: "deferred", lastError: "refund_waits_t307" };
const MINE: BillingQueueEvent = { ...FAILED, id: "e0000000-0000-4000-8000-000000000003", providerEventId: "evt_mio", isSelf: true };
const queue = (events: BillingQueueEvent[], freshCode = true): BillingQueueData => ({ freshCode, total: events.length, events });

describe("la cola de los avisos", () => {
  it("una fila por aviso, con el código en palabras, los ids y el enlace a Stripe, y sin fallas de accesibilidad", async () => {
    const { container } = render(<BillingEventsScreen view={billingView(queue([FAILED, REFUND, MINE]))} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(text.title);
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const first = within(rows[0]!);
    expect(first.getByText(text.errors.zeroInvoice)).toBeInTheDocument();
    expect(first.getByText("Aviso: evt_falla")).toBeInTheDocument();
    expect(first.getByRole("link", { name: /^Ver en Stripe el aviso evt_falla en el panel de Stripe/ })).toHaveAttribute(
      "href",
      "https://dashboard.stripe.com/test/events/evt_falla",
    );
    expect(first.getByRole("button", { name: "Reintentar el aviso evt_falla" })).toHaveAttribute("value", billingButton.retry(FAILED.id, 4));
    expect(first.getByRole("button", { name: "Resolver a mano el aviso evt_falla" })).toBeInTheDocument();
    // Lo que espera a T-307 y el pago propio no ofrecen nada, y dicen por qué.
    expect(within(rows[1]!).queryAllByRole("button")).toHaveLength(0);
    expect(within(rows[1]!).getByText(text.waitsT307)).toBeInTheDocument();
    expect(within(rows[2]!).queryAllByRole("button")).toHaveLength(0);
    expect(within(rows[2]!).getByText(text.yours)).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin avisos lo dice", () => {
    render(<BillingEventsScreen view={billingView(queue([]))} />);
    expect(screen.getByText(text.empty)).toBeInTheDocument();
  });

  it("en el teléfono solo se consulta: las acciones van ocultas por debajo del ancho de tableta, y se dice dónde hacerlo", () => {
    render(<BillingEventsScreen view={billingView(queue([FAILED]))} />);
    expect(screen.getByText(text.phoneOnly)).toHaveClass("md:hidden");
    const form = screen.getByRole("button", { name: /Reintentar/ }).closest("form");
    expect(form).toHaveClass("hidden");
    expect(form).toHaveClass("md:flex");
  });

  it("sin el código reciente no ofrece acciones y pide el código", () => {
    render(<BillingEventsScreen view={billingView(queue([FAILED], false))} />);
    expect(screen.queryByRole("button", { name: /Reintentar/ })).not.toBeInTheDocument();
    expect(screen.getByText(text.codeBody)).toBeInTheDocument();
  });

  it("funciona sin JavaScript: cada fila es un formulario con su botón", () => {
    const html = renderToString(<BillingEventsScreen view={billingView(queue([FAILED]))} />);
    expect(html).toContain("<form");
    expect(html).toContain(`value="${billingButton.retry(FAILED.id, 4)}"`);
  });

  it("resolver pregunta en su fila con la nota, y confirmar manda la revisión vista", async () => {
    const asking: BillingState = { kind: "confirming", asked: { event: FAILED.id, revision: "4", problem: null }, note: undefined, attempt: 1 };
    actions.billingEventsAction.mockResolvedValueOnce(asking);
    render(<BillingEventsScreen view={billingView(queue([FAILED]))} />);
    await userEvent.click(screen.getByRole("button", { name: /Resolver a mano/ }));
    const note = await screen.findByLabelText(text.noteLabel);
    expect(note).toHaveAttribute("maxlength", "500");
    expect(screen.getByRole("button", { name: text.confirmResolve })).toHaveAttribute("value", billingButton.resolve(FAILED.id, "4"));
  });

  it("si volvió a fallar, lo dice con el código para pasárselo al desarrollador", async () => {
    actions.billingEventsAction.mockResolvedValueOnce({ kind: "failed", reason: "failed_again", code: "unknown_account", event: FAILED.id, note: undefined, attempt: 1 });
    render(<BillingEventsScreen view={billingView(queue([FAILED]))} />);
    await userEvent.click(screen.getByRole("button", { name: /Reintentar/ }));
    await waitFor(() => expect(screen.getByText(/Pásalo al desarrollador con este código: unknown_account\./)).toBeInTheDocument(), { timeout: 3_000 });
  });

  it("llega con el aviso de lo hecho", () => {
    render(<BillingEventsScreen view={billingView(queue([]))} done="billing_event_already_applied" />);
    expect(screen.getByText(text.done.alreadyApplied)).toBeInTheDocument();
  });
});
