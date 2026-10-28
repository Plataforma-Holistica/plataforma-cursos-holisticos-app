import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-78, PA-79 y PA-80: los periodos, el panel de uno y su ensayo y cierre (T-605). Las acciones de
// servidor son la frontera con los servicios: aquí se cambian por lo que contestarían.
const actions = vi.hoisted(() => ({ periodCodeAction: vi.fn(), panelAction: vi.fn(), closeAction: vi.fn(), downloadAction: vi.fn() }));
vi.mock("@/app/admin/_periodos/actions", () => actions);

import { CloseScreen } from "@/app/admin/_periodos/close-screen";
import { PeriodsScreen } from "@/app/admin/_periodos/list-screen";
import { csvHref, periodsButton } from "@/app/admin/_periodos/outcomes";
import { PeriodScreen } from "@/app/admin/_periodos/panel-screen";
import { closeView, periodsView, periodView } from "@/app/admin/_periodos/rows";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { periodClosePath, periodPath, ROUTES } from "@/services/account/navigation";
import type { FinanceClose, FinancePeriod, RunTeacher } from "@/services/periods/periods";

import { a11yViolations } from "../setup/a11y";

const text = admin.periods;
const RUN = "c1000000-0000-4000-8000-000000000001";
const NOW = "2027-11-02T18:00:00.000Z";

beforeEach(() => {
  vi.resetAllMocks();
});

type Period = Extract<FinancePeriod, { period: object }>;
type Close = Extract<FinanceClose, { period: object }>;

const figures = {
  runId: RUN,
  activeStudents: 120,
  poolBps: 6000,
  netRevenueCents: 2_000_000,
  poolCents: 1_200_000,
  assignedCents: 1_150_000,
  unconsumedCents: 50_000,
  carriedOutCents: 0,
};
const teacher: RunTeacher = {
  teacherId: "7e000000-0000-4000-8000-000000000001",
  name: "Ana",
  assignedCents: 1_150_000,
  unconsumedCents: 50_000,
  totalCents: 1_200_000,
  founderBonusCents: 0,
  estimateCents: 1_200_000,
  belowMinimum: false,
};

function period(overrides: Partial<Period> = {}, status: Period["period"]["status"] = "closing"): Period {
  return {
    freshCode: true,
    period: {
      periodId: 202710,
      status,
      startsAt: "2027-10-01T06:00:00Z",
      endsAt: "2027-11-01T06:00:00Z",
      enteredClosingAt: "2027-11-01T09:00:00Z",
      activeStudents: 120,
      poolBps: 6000,
      carriedInCents: 0,
      closedAt: null,
      payoutsReleasedAt: null,
      paidAt: null,
    },
    collected: { charges: 130, grossCents: 4_537_000, netCents: 3_911_200 },
    assigned: { students: 120, baseCents: 3_800_000 },
    close: null,
    rehearsal: { ...figures, studentPoolsCents: 1_200_000, at: "2027-11-02T10:00:00Z", statusAtRun: "closing" },
    openAlerts: 0,
    unconsumedAlertBps: 1500,
    unconsumedOver: false,
    lastRollup: { status: "succeeded", mode: "full", startedAt: "2027-11-02T09:00:00Z", finishedAt: "2027-11-02T09:05:00Z" },
    lastGoodRollup: { mode: "full", startedAt: "2027-11-02T09:00:00Z", finishedAt: "2027-11-02T09:05:00Z" },
    rollupRequest: null,
    ...overrides,
  };
}

function close(overrides: Partial<Close> = {}, status: Close["period"]["status"] = "closing"): Close {
  return {
    freshCode: true,
    period: { periodId: 202710, status, endsAt: "2027-11-01T06:00:00Z", enteredClosingAt: "2027-11-01T09:00:00Z" },
    checks: { openAlerts: 0, finalRehearsal: true, lastRollup: "succeeded", rollupMarks: false },
    rehearsal: { ...figures, at: "2027-11-02T10:00:00Z", status: "succeeded", statusAtRun: "closing", carriedInCents: 0, teachers: [teacher] },
    close: null,
    ...overrides,
  };
}

const sent = (action: ReturnType<typeof vi.fn>, call = 0) => {
  const args = action.mock.calls[call] ?? [];
  return Object.fromEntries(args[args.length - 1] as FormData);
};

describe("PA-78, los periodos", () => {
  const list = periodsView(
    {
      freshCode: true,
      periods: [
        { periodId: 202710, status: "closing", startsAt: "2027-10-01T06:00:00Z", endsAt: "2027-11-01T06:00:00Z", activeStudents: 120, poolBps: 6000, poolCents: 1_200_000, unconsumedCents: 0, rehearsedAt: "2027-11-02T10:00:00Z", payouts: { total: 0, paid: 0 } },
        { periodId: 202711, status: "open", startsAt: "2027-11-01T06:00:00Z", endsAt: "2027-12-01T06:00:00Z", activeStudents: null, poolBps: null, poolCents: null, unconsumedCents: null, rehearsedAt: null, payouts: { total: 0, paid: 0 } },
      ],
    },
    NOW,
  );

  it("una tabla con su título, el en curso arriba y marcado, y cada periodo se abre desde su nombre", async () => {
    const { container } = render(<PeriodsScreen view={list} />);
    const table = screen.getByRole("table", { name: text.listCaption });
    const [first, second] = within(table).getAllByRole("rowheader");
    expect(within(first!).getByRole("link", { name: "noviembre de 2027" })).toHaveAttribute("href", periodPath(202711));
    expect(within(first!).getByText(text.current)).toBeInTheDocument();
    expect(within(second!).queryByText(text.current)).not.toBeInTheDocument();
    expect(within(table).getByText(text.statuses.closing)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("PA-79, el panel de un periodo", () => {
  it("el encabezado: el periodo, su estado y los pasos con el actual marcado", async () => {
    const { container } = render(<PeriodScreen view={periodView(period(), null, NOW)} />);
    expect(screen.getByRole("heading", { level: 1, name: "octubre de 2027" })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: text.steps });
    expect(within(steps).getByText(text.statuses.closing)).toHaveAttribute("aria-current", "step");
    expect(within(steps).getByText(text.statuses.open)).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: text.rehearseAndClose })).toHaveAttribute("href", periodClosePath(202710));
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("las cifras, cada una con su nombre; sin ensayo, sin datos y lo dice", () => {
    render(<PeriodScreen view={periodView(period({ rehearsal: null }), null, NOW)} />);
    expect(screen.getByText(text.collected)).toBeInTheDocument();
    expect(screen.getByText("$45,370.00")).toBeInTheDocument();
    expect(screen.getByText(text.figuresNeedRehearsal)).toBeInTheDocument();
    expect(screen.getAllByText(text.noFigure).length).toBeGreaterThan(0);
  });

  it("las alertas sin revisar se avisan arriba con el enlace a las alertas", () => {
    render(<PeriodScreen view={periodView(period({ openAlerts: 2 }), null, NOW)} />);
    expect(screen.getByText("Hay 2 alertas sin revisar. No se puede cerrar hasta revisarlas.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: text.goToAlerts })[0]).toHaveAttribute("href", ROUTES.alerts);
  });

  it("«Recalcular» manda su botón, y lo que contesta se dice en su bloque", async () => {
    actions.panelAction.mockResolvedValue({ kind: "failed", reason: "not_rollable", attempt: 1 });
    const user = userEvent.setup();
    render(<PeriodScreen view={periodView(period(), null, NOW)} />);
    await user.click(screen.getByRole("button", { name: text.recalculate }));
    expect(sent(actions.panelAction)).toEqual({ do: periodsButton.rollup(202710) });
    expect(await screen.findByText(text.failures.notRollable)).toBeInTheDocument();
  });

  it("con un recálculo pedido: dice cuándo, y «Recalcular» no se ofrece", () => {
    render(<PeriodScreen view={periodView(period({ rollupRequest: { status: "pending", requestedAt: "2027-11-02T11:00:00Z", startedAt: null, finishedAt: null } }), null, NOW)} />);
    expect(screen.getByText(/^Recálculo pedido el 2 de noviembre de 2027/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.recalculate })).not.toBeInTheDocument();
  });

  it("llegó con el aviso del recálculo pedido", () => {
    render(<PeriodScreen view={periodView(period(), null, NOW)} done />);
    expect(screen.getByText(text.done.rollupRequested)).toBeInTheDocument();
  });

  it("sin el código reciente: el bloque del código, y nada que decidir", () => {
    render(<PeriodScreen view={periodView(period({ freshCode: false }), null, NOW)} />);
    expect(screen.getByRole("heading", { name: admin.code.title })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.recalculate })).not.toBeInTheDocument();
  });

  it("cerrado: solo lectura, sin «Recalcular» y sin pedir el código", () => {
    render(<PeriodScreen view={periodView(period({ freshCode: false, close: figures }, "closed"), null, NOW)} />);
    expect(screen.getByText(text.readOnly)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.recalculate })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: admin.code.title })).not.toBeInTheDocument();
  });

  it("la consolidación fallida se avisa, con la última que terminó bien", () => {
    render(<PeriodScreen view={periodView(period({ lastRollup: { status: "failed", mode: "dirty", startedAt: "2027-11-03T09:00:00Z", finishedAt: "2027-11-03T09:01:00Z" } }), null, NOW)} />);
    expect(screen.getByText(new RegExp(text.rollupFailed))).toBeInTheDocument();
  });
});

describe("PA-80, el ensayo y el cierre", () => {
  it("el resultado del ensayo: la marca de datos finales, las cifras, la suma y la tabla por maestro con totales", async () => {
    const { container } = render(<CloseScreen view={closeView(close())} />);
    expect(screen.getByText(text.finalBanner)).toBeInTheDocument();
    expect(screen.getByText(text.sumOk)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: t(text.teachersCaption) });
    expect(within(table).getByRole("rowheader", { name: "Ana" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: text.total })).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("«Ensayar» manda su botón; demasiado pronto, lo dice", async () => {
    actions.closeAction.mockResolvedValue({ kind: "failed", reason: "too_soon", step: "rehearse", attempt: 1 });
    const user = userEvent.setup();
    render(<CloseScreen view={closeView(close())} />);
    await user.click(screen.getByRole("button", { name: text.rehearse }));
    expect(sent(actions.closeAction)).toEqual({ do: periodsButton.rehearse(202710) });
    expect(await screen.findByText(text.failures.tooSoon)).toBeInTheDocument();
  });

  it("la lista de lo que falta, cada cosa con su estado en palabras; sin la lista completa, no se ofrece cerrar", () => {
    render(<CloseScreen view={closeView(close({ checks: { openAlerts: 2, finalRehearsal: true, lastRollup: "succeeded", rollupMarks: false } }))} />);
    const item = screen.getByText("Todas las alertas revisadas: faltan 2").closest("li") as HTMLElement;
    expect(within(item).getByText(text.checkMissing)).toBeInTheDocument();
    expect(within(item).getByRole("link", { name: text.goToAlerts })).toHaveAttribute("href", ROUTES.alerts);
    expect(screen.getByText(text.closeWaits)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.closeButton })).not.toBeInTheDocument();
  });

  it("el mes no ha terminado: no aparece «Cerrar periodo», solo se ensaya", () => {
    render(<CloseScreen view={closeView(close({ checks: { ...close().checks, finalRehearsal: false } }, "open"))} />);
    expect(screen.queryByRole("button", { name: text.closeButton })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.rehearse })).toBeInTheDocument();
    expect(screen.getByText(text.checks.monthOpen)).toBeInTheDocument();
  });

  it("cerrar abre el diálogo irreversible, que pide marcar la casilla", async () => {
    actions.closeAction.mockResolvedValueOnce({ kind: "confirming", period: 202710, run: RUN, missingUnderstood: false, attempt: 1 });
    actions.closeAction.mockResolvedValueOnce({ kind: "confirming", period: 202710, run: RUN, missingUnderstood: true, attempt: 2 });
    const user = userEvent.setup();
    render(<CloseScreen view={closeView(close())} />);
    await user.click(screen.getByRole("button", { name: text.closeButton }));
    expect(sent(actions.closeAction)).toEqual({ do: periodsButton.askClose(202710, RUN) });
    const dialog = await screen.findByRole("dialog", { name: "¿Cerrar octubre de 2027?" });
    expect(within(dialog).getByText(text.dialogUndo)).toBeInTheDocument();
    // Cancelar primero.
    const [first, second] = within(dialog).getAllByRole("button");
    expect(first).toHaveAccessibleName(text.keepReviewing);
    expect(second).toHaveAccessibleName(text.confirmClose);
    await user.click(within(dialog).getByRole("button", { name: text.confirmClose }));
    expect(sent(actions.closeAction, 1)).toEqual({ do: periodsButton.close(202710, RUN) });
    expect(await screen.findByText(text.missingUnderstood)).toBeInTheDocument();
    // El error se oye: el foco va a la casilla, que lo tiene como descripción.
    const box = within(screen.getByRole("dialog")).getByRole("checkbox", { name: text.understood });
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAccessibleDescription(text.missingUnderstood);
  });

  it("el diálogo de un ensayo que ya no es el que se ve no se pinta (alguien ensayó después y la página se volvió a leer)", async () => {
    actions.closeAction.mockResolvedValueOnce({ kind: "confirming", period: 202710, run: "c2000000-0000-4000-8000-000000000002", missingUnderstood: false, attempt: 1 });
    const user = userEvent.setup();
    render(<CloseScreen view={closeView(close())} />);
    await user.click(screen.getByRole("button", { name: text.closeButton }));
    await waitFor(() => expect(actions.closeAction).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("si alguien ensayó después, confirmar no cierra y lo dice", async () => {
    actions.closeAction.mockResolvedValueOnce({ kind: "failed", reason: "rehearsal_superseded", step: "close", attempt: 1 });
    const user = userEvent.setup();
    render(<CloseScreen view={closeView(close())} />);
    await user.click(screen.getByRole("button", { name: text.closeButton }));
    expect(await screen.findByText(text.failures.rehearsalSuperseded)).toBeInTheDocument();
  });

  it("marcada la casilla, confirmar la manda; la suma que no cuadra se dice sin monto", async () => {
    actions.closeAction.mockResolvedValueOnce({ kind: "confirming", period: 202710, run: RUN, missingUnderstood: false, attempt: 1 });
    actions.closeAction.mockResolvedValueOnce({ kind: "failed", reason: "unbalanced", step: "close", attempt: 2 });
    const user = userEvent.setup();
    render(<CloseScreen view={closeView(close())} />);
    await user.click(screen.getByRole("button", { name: text.closeButton }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: text.understood }));
    await user.click(within(dialog).getByRole("button", { name: text.confirmClose }));
    expect(sent(actions.closeAction, 1)).toEqual({ do: periodsButton.close(202710, RUN), understood: "yes" });
    expect(await screen.findByText(text.failures.unbalanced)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cerrado: solo lectura, quién cerró, y la descarga, que vuelve como enlace para guardar", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    actions.downloadAction.mockResolvedValue({ kind: "file", filename: "cierre-2027-10.csv", rows: 1, href: csvHref("x"), attempt: 1 });
    const user = userEvent.setup();
    const run = { ...figures, at: "2027-11-03T18:00:00Z", closedBy: "Finanzas", export: { rows: 1, sha256: "ab".repeat(32), createdAt: "2027-11-03T18:00:00Z" }, teachers: [teacher] };
    render(<CloseScreen view={closeView(close({ close: run }, "closed"))} done="period_closed" />);
    expect(screen.getByText(text.done.periodClosed)).toBeInTheDocument();
    expect(screen.getByText(/por Finanzas\.$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.rehearse })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: text.download }));
    expect(sent(actions.downloadAction)).toEqual({ do: periodsButton.download(RUN) });
    // La acción va atada a su periodo.
    expect(actions.downloadAction.mock.calls[0]?.[0]).toBe(202710);
    const link = await screen.findByRole("link", { name: text.saveFile });
    expect(link).toHaveAttribute("href", csvHref("x"));
    expect(link).toHaveAttribute("download", "cierre-2027-10.csv");
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    click.mockRestore();
  });

  it("dar el código va atado a la página de donde se dio", async () => {
    actions.periodCodeAction.mockResolvedValue({ kind: "failed", reason: "wrong_code", attempt: 1 });
    const user = userEvent.setup();
    render(<CloseScreen view={closeView(close({ freshCode: false }))} />);
    await user.type(screen.getByRole("textbox"), "123456");
    await user.click(screen.getByRole("button", { name: admin.code.submit }));
    expect(actions.periodCodeAction.mock.calls[0]?.[0]).toEqual({ period: 202710, page: "close" });
  });
});
