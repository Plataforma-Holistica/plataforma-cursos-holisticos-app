import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-81: las liquidaciones de un periodo (T-605, cuarta solicitud). Las acciones de servidor son la frontera con
// los servicios: aquí se cambian por lo que contestarían.
const actions = vi.hoisted(() => ({ periodCodeAction: vi.fn(), payoutsAction: vi.fn() }));
vi.mock("@/app/admin/_periodos/actions", () => actions);

import { payoutsButton } from "@/app/admin/_periodos/payouts-outcomes";
import { payoutsView } from "@/app/admin/_periodos/payouts-rows";
import { PayoutsScreen } from "@/app/admin/_periodos/payouts-screen";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import type { FinancePayouts, PayoutRow } from "@/services/periods/periods";

import { a11yViolations } from "../setup/a11y";

const text = admin.periods.payouts;
const SEEN = "ab".repeat(32);
const UNHOLD = "cd".repeat(32);
const Y1 = "d1000000-0000-4000-8000-000000000001";
const Y2 = "d1000000-0000-4000-8000-000000000002";
const B1 = "e1000000-0000-4000-8000-000000000001";

type Read = Extract<FinancePayouts, { period: object }>;

beforeEach(() => {
  vi.resetAllMocks();
});

const row = (over: Partial<PayoutRow>): PayoutRow => ({
  teacherId: "a1000000-0000-4000-8000-000000000001",
  name: "Ana",
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
  taxState: "not_needed",
  hasTaxData: true,
  holdKind: null,
  vatCents: 0,
  incomeTaxWithheldCents: 0,
  vatWithheldCents: 0,
  netCents: 0,
  reachesMinimum: true,
  unholdFingerprint: null,
  ...over,
});

const BETO = row({
  teacherId: "a1000000-0000-4000-8000-000000000002",
  name: "Beto",
  payoutId: Y2,
  poolCents: 3350,
  subtotalCents: 3350,
  reachesMinimum: false,
  founderBonus: { bonusId: B1, status: "proposed", amountCents: 502, basisCents: 3350 },
});

const read = (over: Partial<Read> = {}, period: Partial<Read["period"]> = {}): Read => ({
  freshCode: true,
  period: { periodId: 202710, status: "closed", closedAt: "2027-11-02T10:00:00Z", payoutsReleasedAt: null, paidAt: null, minimumCents: 10000, changedAt: null, ...period },
  release: { fingerprint: SEEN, pendingFounderBonuses: 0 },
  payouts: [row({}), row({ ...BETO, founderBonus: { ...BETO.founderBonus!, status: "confirmed" }, subtotalCents: 3852 })],
  ...over,
});

const sent = (action: ReturnType<typeof vi.fn>, call = 0) => {
  const args = action.mock.calls[call] ?? [];
  return Object.fromEntries(args[args.length - 1] as FormData);
};

describe("PA-81, las liquidaciones del periodo", () => {
  it("una tabla con su título, sus cifras estimadas y sus totales, sin violaciones de accesibilidad", async () => {
    const { container } = render(<PayoutsScreen view={payoutsView(read())} />);
    const table = screen.getByRole("table", { name: t(text.caption) });
    expect(within(table).getByRole("rowheader", { name: "Ana" })).toBeInTheDocument();
    expect(within(table).getByText("$244.94 (estimado)")).toBeInTheDocument();
    expect(within(table).getByText("Confirmado: $5.02")).toBeInTheDocument();
    expect(screen.getByText(text.estimatedNote)).toBeInTheDocument();
    expect(screen.getByText("Pago mínimo del periodo: $100.00.")).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("liberar abre el diálogo irreversible con la huella de lo que se ve, y pide la casilla", async () => {
    actions.payoutsAction.mockResolvedValueOnce({ kind: "asking", ask: { what: "release", seen: SEEN }, missing: null, attempt: 1 });
    actions.payoutsAction.mockResolvedValueOnce({ kind: "asking", ask: { what: "release", seen: SEEN }, missing: "understood", attempt: 2 });
    const user = userEvent.setup();
    render(<PayoutsScreen view={payoutsView(read())} />);
    await user.click(screen.getByRole("button", { name: text.release }));
    expect(sent(actions.payoutsAction)).toEqual({ do: payoutsButton.askRelease(202710, SEEN) });
    // La acción va atada a su periodo.
    expect(actions.payoutsAction.mock.calls[0]?.[0]).toBe(202710);
    const dialog = await screen.findByRole("dialog", { name: "¿Liberar las liquidaciones de octubre de 2027?" });
    expect(within(dialog).getByText(/^1 liquidación pasa a «en espera de factura» y 1 a «acumulada»/)).toBeInTheDocument();
    const [first, second] = within(dialog).getAllByRole("button");
    expect(first).toHaveAccessibleName(text.keepReviewing);
    expect(second).toHaveAccessibleName(text.confirmRelease);
    await user.click(within(dialog).getByRole("button", { name: text.confirmRelease }));
    expect(sent(actions.payoutsAction, 1)).toEqual({ do: payoutsButton.release(202710, SEEN) });
    // La casilla se arma de nuevo con la respuesta: una referencia tomada antes puede ser de la que ya se fue.
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("checkbox", { name: text.understood })).toHaveFocus());
    expect(within(screen.getByRole("dialog")).getByRole("checkbox", { name: text.understood })).toHaveAccessibleDescription(text.missingUnderstood);
  });

  // Cambió con la revisión del diff: antes no se pintaba nada, y la persona pulsaba «Liberar» sin respuesta.
  it("el diálogo de una vista que ya no es la que se ve no se pinta, y se dice que las cifras cambiaron", async () => {
    actions.payoutsAction.mockResolvedValueOnce({ kind: "asking", ask: { what: "release", seen: "ef".repeat(32) }, missing: null, attempt: 1 });
    const user = userEvent.setup();
    render(<PayoutsScreen view={payoutsView(read())} />);
    await user.click(screen.getByRole("button", { name: text.release }));
    expect(await screen.findByText(text.failures.previewChanged)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("mientras se pregunta liberar, la tabla muestra todas, aunque haya un filtro puesto", async () => {
    actions.payoutsAction.mockResolvedValueOnce({ kind: "asking", ask: { what: "release", seen: SEEN }, missing: null, attempt: 1 });
    const user = userEvent.setup();
    render(<PayoutsScreen view={payoutsView(read({ payouts: [row({}), row({ ...BETO, status: "on_hold", founderBonus: null })] }))} />);
    await user.click(within(screen.getByRole("group", { name: text.filterLabel })).getByRole("button", { name: "Retenida (1)" }));
    expect(within(screen.getByRole("table")).queryByRole("rowheader", { name: "Ana" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: text.release }));
    await screen.findByRole("dialog");
    expect(within(screen.getByRole("table")).getByRole("rowheader", { name: "Ana" })).toBeInTheDocument();
  });

  it("si las cifras cambiaron desde que se vio, liberar no libera y lo dice", async () => {
    actions.payoutsAction.mockResolvedValueOnce({ kind: "failed", reason: "preview_changed", attempt: 1 });
    const user = userEvent.setup();
    render(<PayoutsScreen view={payoutsView(read())} />);
    await user.click(screen.getByRole("button", { name: text.release }));
    expect(await screen.findByText(text.failures.previewChanged)).toBeInTheDocument();
  });

  it("con un bono de fundador por decidir, «Liberar» no se ofrece; el bono se confirma o se anula desde su fila", async () => {
    actions.payoutsAction.mockResolvedValueOnce({ kind: "asking", ask: { what: "void", bonus: B1 }, missing: null, attempt: 1 });
    const user = userEvent.setup();
    render(<PayoutsScreen view={payoutsView(read({ release: { fingerprint: SEEN, pendingFounderBonuses: 1 }, payouts: [row({}), BETO] }))} />);
    expect(screen.queryByRole("button", { name: text.release })).not.toBeInTheDocument();
    expect(screen.getByText("Liberar liquidaciones: falta decidir 1 bono de fundador.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.confirmBonus })).toHaveAttribute("value", payoutsButton.confirmBonus(B1));
    await user.click(screen.getByRole("button", { name: text.voidBonus }));
    expect(sent(actions.payoutsAction)).toEqual({ do: payoutsButton.askVoid(B1) });
    expect(await screen.findByRole("textbox", { name: text.voidReason })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.confirmVoid })).toHaveAttribute("value", payoutsButton.void(B1));
  });

  it("retener abre su motivo en la fila, con el estado que se vio, y las demás filas no pintan botones", async () => {
    actions.payoutsAction.mockResolvedValueOnce({ kind: "asking", ask: { what: "hold", payout: Y1, status: "calculated" }, missing: null, attempt: 1 });
    actions.payoutsAction.mockResolvedValueOnce({ kind: "asking", ask: { what: "hold", payout: Y1, status: "calculated" }, missing: "reason", attempt: 2 });
    const user = userEvent.setup();
    render(<PayoutsScreen view={payoutsView(read())} />);
    const [first] = screen.getAllByRole("button", { name: text.hold });
    await user.click(first!);
    expect(sent(actions.payoutsAction)).toEqual({ do: payoutsButton.askHold(Y1, "calculated") });
    const reason = await screen.findByRole("textbox", { name: text.holdReason });
    // El botón pulsado se fue con la respuesta: el foco va al motivo.
    await waitFor(() => expect(reason).toHaveFocus());
    expect(screen.queryAllByRole("button", { name: text.hold })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: text.release })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: text.confirmHold }));
    expect(sent(actions.payoutsAction, 1)).toEqual({ do: payoutsButton.hold(Y1, "calculated"), reason: "" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: text.holdReason })).toHaveFocus());
    expect(screen.getByRole("textbox", { name: text.holdReason })).toHaveAccessibleDescription(text.holdReasonMissing);
    expect(reason).toBeDefined();
  });

  it("soltar una retenida de un periodo liberado la libera: el diálogo es irreversible y dice el bruto", async () => {
    actions.payoutsAction.mockResolvedValueOnce({ kind: "asking", ask: { what: "unhold", payout: Y1, seen: UNHOLD }, missing: null, attempt: 1 });
    const user = userEvent.setup();
    const held = row({ status: "on_hold", heldFromStatus: "calculated", holdReason: "Se investiga.", unholdFingerprint: UNHOLD, subtotalCents: 3852, reachesMinimum: false });
    render(<PayoutsScreen view={payoutsView(read({ release: null, payouts: [held] }, { payoutsReleasedAt: "2027-11-02T12:00:00Z" }))} />);
    expect(screen.getByText("Retenida: Se investiga.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: text.unhold }));
    expect(sent(actions.payoutsAction)).toEqual({ do: payoutsButton.askUnhold(Y1, UNHOLD) });
    const dialog = await screen.findByRole("dialog", { name: "¿Soltar la liquidación de Ana?" });
    expect(within(dialog).getByText("Este periodo ya se liberó: soltarla la libera ahora, con un bruto de $38.52. Queda «Acumulada».")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: text.understood })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: text.confirmUnhold })).toHaveAttribute("value", payoutsButton.unhold(Y1, UNHOLD, true));
  });

  it("liberado: la fecha, sin «Liberar», con las cifras escritas; llegó con su aviso", () => {
    render(
      <PayoutsScreen
        view={payoutsView(read({ release: null, payouts: [row({ status: "awaiting_invoice", estimated: false })] }, { payoutsReleasedAt: "2027-11-02T12:00:00Z" }))}
        done="payouts_released"
      />,
    );
    expect(screen.getByText(text.done.released)).toBeInTheDocument();
    expect(screen.getByText(/^Liberadas el /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.release })).not.toBeInTheDocument();
    expect(screen.getByText("$244.94", { selector: "span" })).toBeInTheDocument();
  });

  it("sin el código reciente: el bloque del código, y nada que decidir", () => {
    render(<PayoutsScreen view={payoutsView(read({ freshCode: false }))} />);
    expect(screen.getByText(text.codeBody)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.release })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.hold })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: text.columns.actions })).not.toBeInTheDocument();
  });

  it("en cierre: las liquidaciones nacen al cerrar, con el enlace al cierre", () => {
    render(<PayoutsScreen view={payoutsView(read({ release: null, payouts: [] }, { status: "closing" }))} />);
    expect(screen.getByText(text.notClosed, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: text.goToClose })).toHaveAttribute("href", "/admin/periodos/2027-10/cierre");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("el filtro por estado, con JavaScript, deja ver solo las de un estado", async () => {
    const user = userEvent.setup();
    render(<PayoutsScreen view={payoutsView(read({ payouts: [row({}), row({ ...BETO, status: "on_hold", founderBonus: null })] }))} />);
    const group = screen.getByRole("group", { name: text.filterLabel });
    await user.click(within(group).getByRole("button", { name: "Retenida (1)" }));
    expect(within(group).getByRole("button", { name: "Retenida (1)" })).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table");
    expect(within(table).queryByRole("rowheader", { name: "Ana" })).not.toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Beto" })).toBeInTheDocument();
  });
});
