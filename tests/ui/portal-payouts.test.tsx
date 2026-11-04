import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MyPayouts, PayoutReportValue } from "@/services/teachers/payout-report-data";

// PA-46 y PA-47 (T-604, cuarta solicitud), servidas por el comodín del portal, con la guarda, el servicio y la acción simulados: que el comodín no lea nada
// antes de la guarda, que por alumno vayan el alias y los puntos y nunca pesos, lo que se ve antes y después de liberar, que el suspendido vea todo,
// «no se supo» con «Reintentar», y las reglas automáticas de accesibilidad. Lo que el servicio lee de verdad lo prueban las pruebas de base e integración.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  requireTeacher: vi.fn(),
  myPayouts: vi.fn(),
  payoutReport: vi.fn(),
  payoutCsvAction: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireTeacher: mocks.requireTeacher }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: vi.fn() }));
vi.mock("@/services/teachers/payout-report-data", () => ({ myPayouts: mocks.myPayouts, payoutReport: mocks.payoutReport }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/portal/_pagos/actions", () => ({ payoutCsvAction: mocks.payoutCsvAction }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import PortalRestPage from "@/app/portal/[...resto]/page";

import { a11yViolations } from "../setup/a11y";

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: null, issuedAt: 0 };
const TEACHER = "7e000000-0000-4000-8000-000000000001";

const row = (period: string, status: MyPayouts["periods"][number]["status"], extra: Partial<MyPayouts["periods"][number]> = {}): MyPayouts["periods"][number] => ({
  period,
  status,
  poolCents: 100_000,
  bonusesCents: 5_000,
  adjustmentsCents: -1_000,
  balanceAppliedCents: 0,
  netCents: null,
  carriedCents: null,
  invoiceDueOn: null,
  overdue: false,
  action: null,
  ...extra,
});

const MINE: MyPayouts = {
  balanceCents: 4_500,
  receiverReady: true,
  periods: [
    row("2030-11", "empty", { poolCents: 0, bonusesCents: 0, adjustmentsCents: 0 }),
    row("2031-01", "paid", { netCents: 98_000 }),
    row("2031-02", "awaiting_invoice", { netCents: 101_234, invoiceDueOn: "2031-03-05", overdue: true, action: "upload_invoice" }),
    row("2030-12", "carried_forward", { poolCents: 4_500, bonusesCents: 0, adjustmentsCents: 0, carriedCents: 4_500 }),
  ],
};

const REPORT: PayoutReportValue = {
  period: "2031-02",
  status: "awaiting_invoice",
  released: true,
  invoiceDueOn: "2031-03-05",
  overdue: false,
  summary: { poolCents: 5_000_000, poolBps: 6_000, nothingAssigned: false, assignedCents: 97_000, unconsumedCents: 3_000, totalCents: 100_000, halfPoints: 13, students: 2 },
  money: {
    poolCents: 100_000,
    bonusesCents: 5_000,
    adjustmentsCents: -1_000,
    balanceAppliedCents: 0,
    subtotalCents: 104_000,
    vatCents: 16_640,
    incomeTaxWithheldCents: 1_300,
    vatWithheldCents: 11_093,
    netCents: 108_247,
    bonuses: [{ kind: "founder", amountCents: 5_000 }],
    adjustments: [{ originPeriod: "2031-01", amountCents: -1_000 }],
  },
  invoice: { receiverRfc: "PLA010101AAA", latest: { status: "rejected", submittedAt: "2031-03-01T18:00:00Z", reviewedAt: "2031-03-02T18:00:00Z", rejectionReason: "El RFC no coincide" } },
  payment: null,
  students: [
    { alias: "Ceiba 42", halfPoints: 8 },
    { alias: "Río 17", halfPoints: 5 },
  ],
};

/** Lo que pinta el comodín en esa ruta, ya resuelta la sección del servidor. */
async function at(resto: string[]) {
  const page = (await PortalRestPage({ params: Promise.resolve({ resto }), searchParams: Promise.resolve({}) })) as ReactElement<object>;
  const section = page.type as (props: object) => unknown;
  return typeof section === "function" && section.name.endsWith("Section") ? ((await section(page.props)) as ReactElement) : page;
}

function teaches(status: "active" | "suspended") {
  mocks.requireTeacher.mockImplementation(() => {
    mocks.order.push("guarda");
    return Promise.resolve({ kind: "render", screen: "work", claims, teacher: { id: TEACHER, status, notice: null } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order = [];
  teaches("active");
  mocks.myPayouts.mockImplementation(() => {
    mocks.order.push("pagos");
    return Promise.resolve({ kind: "ready", value: { outcome: "ok", value: MINE } });
  });
  mocks.payoutReport.mockImplementation(() => {
    mocks.order.push("reporte");
    return Promise.resolve({ kind: "ready", value: { outcome: "ok", value: REPORT } });
  });
});

describe("PA-46 · Pagos", () => {
  it("corre la guarda con la ruta pedida antes de leer, y el menú marca Pagos, sin fallas de accesibilidad", async () => {
    const { container } = render(await at(["pagos"]));
    expect(mocks.requireTeacher).toHaveBeenCalledExactlyOnceWith("/portal/pagos", "work");
    expect(mocks.order).toEqual(["guarda", "pagos"]);
    expect(mocks.myPayouts).toHaveBeenCalledWith(claims);
    expect(screen.getByRole("heading", { level: 1, name: "Pagos" })).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "Pagos" })) expect(link).toHaveAttribute("aria-current", "page");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("la tabla, la más reciente primero, con su estado, su neto y lo que toca", async () => {
    render(await at(["pagos"]));
    const table = screen.getByRole("table", { name: "Tus liquidaciones" });
    const periods = within(table)
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent);
    expect(periods).toEqual(["Febrero de 2031", "Enero de 2031", "Diciembre de 2030", "Noviembre de 2030"]);
    const february = within(table).getByRole("rowheader", { name: "Febrero de 2031" }).closest("tr") as HTMLElement;
    expect(within(february).getByText("En espera de factura")).toBeInTheDocument();
    expect(within(february).getByText("$1,012.34")).toBeInTheDocument();
    expect(within(february).getByRole("link", { name: "Ya puedes facturar Febrero de 2031" })).toHaveAttribute("href", "/portal/pagos/2031-02");
    expect(within(february).getByText(/Venció la fecha para facturar/)).toBeInTheDocument();
    const december = within(table).getByRole("rowheader", { name: "Diciembre de 2030" }).closest("tr") as HTMLElement;
    expect(within(december).getByText("Acumulada")).toBeInTheDocument();
    expect(within(december).getByText("Pasa a tu siguiente pago: $45.00")).toBeInTheDocument();
    expect(within(december).getByText("No se paga")).toBeInTheDocument();
    const november = within(table).getByRole("rowheader", { name: "Noviembre de 2030" }).closest("tr") as HTMLElement;
    expect(within(november).getByText("En cero")).toBeInTheDocument();
    expect(within(november).getAllByText("$0.00")).toHaveLength(3);
    expect(within(november).getByRole("link", { name: "Ver la liquidación de Noviembre de 2030" })).toHaveAttribute("href", "/portal/pagos/2030-11");
  });

  it("sin el RFC de quien recibe (PQ-20) no ofrece facturar: solo ver la liquidación", async () => {
    mocks.myPayouts.mockResolvedValueOnce({ kind: "ready", value: { outcome: "ok", value: { ...MINE, receiverReady: false } } });
    render(await at(["pagos"]));
    const table = screen.getByRole("table", { name: "Tus liquidaciones" });
    const february = within(table).getByRole("rowheader", { name: "Febrero de 2031" }).closest("tr") as HTMLElement;
    expect(within(february).queryByRole("link", { name: "Ya puedes facturar Febrero de 2031" })).not.toBeInTheDocument();
    expect(within(february).getByRole("link", { name: "Ver la liquidación de Febrero de 2031" })).toHaveAttribute("href", "/portal/pagos/2031-02");
  });

  it("en teléfono, tarjetas en el mismo orden", async () => {
    render(await at(["pagos"]));
    const cards = within(screen.getByRole("list", { name: "Tus liquidaciones" })).getAllByRole("listitem");
    expect(cards.map((card) => card.querySelector("p")?.textContent)).toEqual(["Febrero de 2031", "Enero de 2031", "Diciembre de 2030", "Noviembre de 2030"]);
  });

  it("el saldo acumulado solo si hay, y el aviso de datos fiscales solo si faltan", async () => {
    render(await at(["pagos"]));
    expect(screen.getByText("Saldo acumulado")).toBeInTheDocument();
    expect(screen.queryByText("Capturar datos")).not.toBeInTheDocument();
  });

  it("sin saldo no hay cifra; con una liquidación sin datos fiscales, el aviso enlaza a capturarlos", async () => {
    mocks.myPayouts.mockResolvedValueOnce({ kind: "ready", value: { outcome: "ok", value: { balanceCents: null, periods: [row("2031-02", "tax_data_missing")] } } });
    render(await at(["pagos"]));
    expect(screen.queryByText("Saldo acumulado")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Capturar datos" })).toHaveAttribute("href", "/portal/datos-fiscales");
  });

  it("sin liquidaciones, lo dice", async () => {
    mocks.myPayouts.mockResolvedValueOnce({ kind: "ready", value: { outcome: "ok", value: { balanceCents: null, periods: [] } } });
    render(await at(["pagos"]));
    expect(screen.getByText("Tu primera liquidación aparece aquí al cerrar tu primer mes publicado.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("«no se supo» ofrece reintentar en la misma pantalla", async () => {
    mocks.myPayouts.mockResolvedValueOnce({ kind: "unavailable" });
    render(await at(["pagos"]));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/portal/pagos");
  });

  it("el suspendido lo ve todo, con la franja de solo lectura", async () => {
    teaches("suspended");
    render(await at(["pagos"]));
    expect(screen.getByText(/Tu cuenta está en solo lectura/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Tus liquidaciones" })).toBeInTheDocument();
  });

  it("si el servicio dice que no es maestro, no existe", async () => {
    mocks.myPayouts.mockResolvedValueOnce({ kind: "ready", value: { outcome: "not_teacher" } });
    await expect(at(["pagos"])).rejects.toThrow("no encontrado");
  });
});

describe("PA-47 · Liquidación del periodo", () => {
  it("el encabezado, la línea de pasos con el actual marcado, «Qué sigue» y el resumen, sin fallas de accesibilidad", async () => {
    const { container } = render(await at(["pagos", "2031-02"]));
    expect(mocks.requireTeacher).toHaveBeenCalledExactlyOnceWith("/portal/pagos/2031-02", "work");
    expect(mocks.order).toEqual(["guarda", "reporte"]);
    expect(mocks.payoutReport).toHaveBeenCalledWith(claims, "2031-02");
    expect(screen.getByRole("heading", { level: 1, name: "Febrero de 2031" })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Pasos de la liquidación" });
    expect(within(steps).getAllByRole("listitem").filter((item) => item.getAttribute("aria-current") === "step").map((item) => item.textContent)).toEqual(["En espera de factura"]);
    expect(screen.getByText("Ya puedes facturar por $1,082.47. Tu fecha límite es el 5 de marzo de 2031.")).toBeInTheDocument();
    expect(screen.getByText("Bote del periodo")).toBeInTheDocument();
    expect(screen.getByText("$50,000.00")).toBeInTheDocument();
    expect(screen.getByText("60 %")).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("el desglose de dinero, la factura con sus cinco montos, el RFC y la última factura con su motivo", async () => {
    render(await at(["pagos", "2031-02"]));
    const breakdown = screen.getByRole("region", { name: "Cómo se llega a tu pago" });
    expect(within(breakdown).getByText("Bono de fundador")).toBeInTheDocument();
    expect(within(breakdown).getByText("Ajuste de enero de 2031")).toBeInTheDocument();
    expect(within(breakdown).getByText("Neto a pagar")).toBeInTheDocument();
    const invoice = screen.getByRole("region", { name: "Factura" });
    expect(within(invoice).getByText("A nombre de: RFC PLA010101AAA")).toBeInTheDocument();
    for (const [label, amount] of [
      ["Subtotal", "$1,040.00"],
      ["IVA trasladado", "$166.40"],
      ["ISR retenido", "$13.00"],
      ["IVA retenido", "$110.93"],
      ["Total a facturar", "$1,082.47"],
    ] as const) {
      expect(within(within(invoice).getByText(label).parentElement as HTMLElement).getByText(amount)).toBeInTheDocument();
    }
    expect(within(invoice).getByText("Rechazada")).toBeInTheDocument();
    expect(within(invoice).getByText("Motivo: El RFC no coincide")).toBeInTheDocument();
    expect(within(invoice).queryByRole("button")).not.toBeInTheDocument();
  });

  it("por alumno, el alias y los puntos, y ninguna fila de alumno muestra pesos; los pesos van en el bote sin consumo y en el total", async () => {
    render(await at(["pagos", "2031-02"]));
    const table = screen.getByRole("table", { name: "Tus alumnos del periodo, con sus puntos" });
    for (const [alias, said] of [
      ["Ceiba 42", "4"],
      ["Río 17", "2.5"],
    ] as const) {
      const line = within(table).getByRole("rowheader", { name: alias }).closest("tr") as HTMLElement;
      expect(within(line).getByText(said)).toBeInTheDocument();
      expect(line.textContent).not.toMatch(/\$/);
    }
    const unconsumed = within(table).getByRole("rowheader", { name: "Bote sin consumo" }).closest("tr") as HTMLElement;
    expect(within(unconsumed).getByText("$30.00")).toBeInTheDocument();
    const total = within(table).getByRole("rowheader", { name: "Total" }).closest("tr") as HTMLElement;
    expect(within(total).getByText("6.5")).toBeInTheDocument();
    expect(within(total).getByText("$1,000.00")).toBeInTheDocument();
    expect(screen.getByText(/Su historial en otros cursos es privado, incluso para ti/)).toBeInTheDocument();
  });

  it("solo CSV, sin PDF; el archivo vuelve como dirección de datos con su nombre", async () => {
    mocks.payoutCsvAction.mockResolvedValue({ kind: "file", fileName: "reporte-2031-02.csv", href: "data:text/csv;charset=utf-8,x", attempt: 1 });
    const user = userEvent.setup();
    render(await at(["pagos", "2031-02"]));
    expect(screen.queryByRole("button", { name: /PDF/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Descargar CSV" }));
    expect(Object.fromEntries(mocks.payoutCsvAction.mock.calls[0]?.[1] as FormData)).toEqual({ do: "csv:2031-02" });
    const link = await screen.findByRole("link", { name: "Guardar el archivo" });
    expect(link).toHaveAttribute("download", "reporte-2031-02.csv");
    expect(link).toHaveAttribute("href", "data:text/csv;charset=utf-8,x");
  });

  it("si no se pudo preparar el CSV, lo dice", async () => {
    mocks.payoutCsvAction.mockResolvedValue({ kind: "failed", reason: "unavailable", attempt: 1 });
    const user = userEvent.setup();
    render(await at(["pagos", "2031-02"]));
    await user.click(screen.getByRole("button", { name: "Descargar CSV" }));
    await waitFor(() => expect(screen.getByText("No pudimos preparar el reporte. Intenta de nuevo en un momento.")).toBeInTheDocument());
  });

  it("antes de liberar: el resumen y el reparto, sin neto, sin desglose de dinero y sin factura", async () => {
    mocks.payoutReport.mockResolvedValueOnce({ kind: "ready", value: { outcome: "ok", value: { ...REPORT, status: "calculated", released: false, money: null } } });
    render(await at(["pagos", "2031-02"]));
    expect(screen.getByText("Estamos confirmando bonos y ajustes. Te avisamos cuando puedas facturar.")).toBeInTheDocument();
    expect(screen.getByText("Tu reparto")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Cómo se llega a tu pago" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Factura" })).not.toBeInTheDocument();
    expect(screen.queryByText("Neto a pagar")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Tus alumnos del periodo, con sus puntos" })).toBeInTheDocument();
  });

  it("sin el RFC de quien recibe, dice que todavía no se puede facturar", async () => {
    mocks.payoutReport.mockResolvedValueOnce({ kind: "ready", value: { outcome: "ok", value: { ...REPORT, invoice: { receiverRfc: null, latest: null } } } });
    render(await at(["pagos", "2031-02"]));
    const invoice = screen.getByRole("region", { name: "Factura" });
    expect(within(invoice).getByText(/Todavía no se puede facturar: nos falta el dato de La Plataforma/)).toBeInTheDocument();
    expect(within(invoice).getByText("Todavía no has enviado una factura de este periodo.")).toBeInTheDocument();
    // «Qué sigue» tampoco lo ofrece: diría lo contrario que el bloque de factura.
    expect(screen.queryByText(/Ya puedes facturar/)).not.toBeInTheDocument();
  });

  it("una acumulada lleva su bruto, que pasa al siguiente, sin IVA, retenciones ni neto", async () => {
    const money = { ...REPORT.money!, vatCents: 0, incomeTaxWithheldCents: 0, vatWithheldCents: 0, netCents: REPORT.money!.subtotalCents };
    mocks.payoutReport.mockResolvedValueOnce({ kind: "ready", value: { outcome: "ok", value: { ...REPORT, status: "carried_forward", money } } });
    render(await at(["pagos", "2031-02"]));
    expect(screen.getByRole("region", { name: "Cómo se llega a tu pago" })).toBeInTheDocument();
    expect(screen.queryByText("Neto a pagar")).not.toBeInTheDocument();
    expect(screen.queryByText("Retenciones")).not.toBeInTheDocument();
  });

  it("sin datos fiscales, el bloque de factura se sustituye por el aviso con «Capturar datos»", async () => {
    mocks.payoutReport.mockResolvedValueOnce({ kind: "ready", value: { outcome: "ok", value: { ...REPORT, status: "tax_data_missing" } } });
    render(await at(["pagos", "2031-02"]));
    expect(screen.queryByRole("region", { name: "Factura" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Capturar datos" })).toHaveAttribute("href", "/portal/datos-fiscales");
    expect(screen.queryByRole("list", { name: "Pasos de la liquidación" })).not.toBeInTheDocument();
  });

  it("vencida: el aviso, y se puede facturar igual", async () => {
    mocks.payoutReport.mockResolvedValueOnce({ kind: "ready", value: { outcome: "ok", value: { ...REPORT, overdue: true } } });
    render(await at(["pagos", "2031-02"]));
    expect(screen.getByText(/venció el 5 de marzo de 2031. Todavía puedes facturar/)).toBeInTheDocument();
  });

  it("pagada: fecha, referencia y neto", async () => {
    mocks.payoutReport.mockResolvedValueOnce({
      kind: "ready",
      value: { outcome: "ok", value: { ...REPORT, status: "paid", payment: { paidOn: "2031-03-10", reference: "TRF-9", amountCents: 108_247 } } },
    });
    render(await at(["pagos", "2031-02"]));
    expect(screen.getByText("Pagado el 10 de marzo de 2031. Referencia: TRF-9.")).toBeInTheDocument();
    const payment = screen.getByRole("region", { name: "Pago" });
    expect(within(payment).getByText("TRF-9")).toBeInTheDocument();
    expect(within(payment).getByText("$1,082.47")).toBeInTheDocument();
  });

  it("sin nada asignado en el periodo, el texto de RN-06", async () => {
    mocks.payoutReport.mockResolvedValueOnce({
      kind: "ready",
      value: { outcome: "ok", value: { ...REPORT, summary: { ...REPORT.summary, nothingAssigned: true }, students: [] } },
    });
    render(await at(["pagos", "2031-02"]));
    expect(screen.getByText(/ningún alumno con pago en el periodo vio lecciones en La Plataforma. El bote entero pasó al periodo siguiente./)).toBeInTheDocument();
    expect(screen.getByText("Ningún alumno vio tus lecciones en este periodo.")).toBeInTheDocument();
  });

  it("un periodo en cero se muestra en cero", async () => {
    mocks.payoutReport.mockResolvedValueOnce({ kind: "ready", value: { outcome: "empty", period: "2030-11", poolCents: 0, poolBps: 6_000, nothingAssigned: true } });
    render(await at(["pagos", "2030-11"]));
    expect(screen.getByRole("heading", { level: 1, name: "Noviembre de 2030" })).toBeInTheDocument();
    expect(screen.getByText("En cero")).toBeInTheDocument();
    expect(screen.getByText(/Este periodo quedó en cero/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Factura" })).not.toBeInTheDocument();
    // Un periodo en cero no tiene CSV: la base contestaría que no existe.
    expect(screen.queryByRole("button", { name: "Descargar CSV" })).not.toBeInTheDocument();
  });

  it.each(["not_found", "not_teacher"] as const)("«%s» no existe", async (outcome) => {
    mocks.payoutReport.mockResolvedValueOnce({ kind: "ready", value: { outcome } });
    await expect(at(["pagos", "2031-02"])).rejects.toThrow("no encontrado");
  });

  it.each([[["pagos", "2031-13"]], [["pagos", "203102"]], [["pagos", "2031-02", "otra"]]])("una ruta sin forma no existe, después de la guarda y sin leer: %j", async (resto) => {
    await expect(at(resto)).rejects.toThrow("no encontrado");
    expect(mocks.requireTeacher).toHaveBeenCalledOnce();
    expect(mocks.payoutReport).not.toHaveBeenCalled();
  });

  it("«no se supo» ofrece reintentar en la misma liquidación", async () => {
    mocks.payoutReport.mockResolvedValueOnce({ kind: "unavailable" });
    render(await at(["pagos", "2031-02"]));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/portal/pagos/2031-02");
  });

  it("el suspendido lo ve todo, con la franja de solo lectura", async () => {
    teaches("suspended");
    render(await at(["pagos", "2031-02"]));
    expect(screen.getByText(/Tu cuenta está en solo lectura/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Factura" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descargar CSV" })).toBeInTheDocument();
  });
});
