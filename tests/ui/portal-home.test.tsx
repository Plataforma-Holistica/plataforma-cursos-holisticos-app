import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardRead, DashboardValue } from "@/services/teachers/dashboard-data";

// PA-41 · Panel (T-408), el inicio del portal, con la guarda y los servicios simulados: que no lea nada antes de la guarda, las cuatro cifras con el
// aviso del estimado, sin corrida, la corrida que falló, «Para empezar» a quien no ha publicado, el suspendido, «no se supo», y que ninguna cifra por
// alumno aparezca. Lo que el servicio lee de verdad lo prueban la 82 y la integración 110.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  requireTeacher: vi.fn(),
  readNotice: vi.fn(),
  taxProfileState: vi.fn(),
  teacherDashboard: vi.fn(),
}));
vi.mock("@/app/_lib/guard", () => ({ requireTeacher: mocks.requireTeacher }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/services/account/notice", () => ({ readNotice: mocks.readNotice }));
vi.mock("@/services/teachers/tax-data", () => ({ taxProfileState: mocks.taxProfileState }));
vi.mock("@/services/teachers/dashboard-data", () => ({ teacherDashboard: mocks.teacherDashboard }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import PortalHomePage from "@/app/portal/page";

import { a11yViolations } from "../setup/a11y";

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: null, issuedAt: 0 };
const TEACHER = "7e000000-0000-4000-8000-000000000001";
const COURSE = "c0000000-0000-4000-8000-000000000001";
const OTHER = "c0000000-0000-4000-8000-000000000002";

const RUN = { estimatedCents: 123_456, fullLessons: 214, halfLessons: 37, students: 58, updatedAt: "2031-03-12T11:40:00.000Z" };
const VALUE: DashboardValue = {
  hasPublished: true,
  current: { period: "2031-03", run: RUN, lastFailed: false, stale: false },
  courses: [
    { courseId: COURSE, title: "Respirar para volver", owned: true, figures: { fullLessons: 150, halfLessons: 22, students: 41 } },
    { courseId: OTHER, title: "Meditación para empezar", owned: true, figures: { fullLessons: 64, halfLessons: 15, students: 23 } },
  ],
  series: [
    { period: "2031-01", cents: 98_000, estimated: false },
    { period: "2031-02", cents: 101_234, estimated: true },
  ],
};
const TAX = { version: 1, updatedAt: null, canSave: true, clabeWaitsUntil: null, clabeNoticePending: false, clabeRecapture: false };

const ready = (value: DashboardValue): DashboardRead => ({ kind: "ready", value: { outcome: "ok", value } });

function teaches(status: "active" | "suspended", notice: string | null = null) {
  mocks.requireTeacher.mockImplementation(() => {
    mocks.order.push("guarda");
    return Promise.resolve({ kind: "render", screen: "work", claims, teacher: { id: TEACHER, status, notice } });
  });
}

function answers(read: DashboardRead) {
  mocks.teacherDashboard.mockImplementation(() => {
    mocks.order.push("panel");
    return Promise.resolve(read);
  });
}

const home = async () => render((await PortalHomePage()) as ReactElement);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order = [];
  teaches("active");
  mocks.readNotice.mockReturnValue(null);
  mocks.taxProfileState.mockImplementation(() => {
    mocks.order.push("fiscal");
    return Promise.resolve(TAX);
  });
  answers(ready(VALUE));
});

describe("PA-41 · Panel", () => {
  it("corre la guarda antes de leer, y el menú marca el inicio, sin fallas de accesibilidad", async () => {
    const { container } = await home();
    expect(mocks.requireTeacher).toHaveBeenCalledExactlyOnceWith("/portal");
    expect(mocks.order[0]).toBe("guarda");
    expect(mocks.order).toHaveLength(3);
    expect(mocks.teacherDashboard).toHaveBeenCalledWith(claims);
    expect(screen.getByRole("heading", { level: 1, name: "Panel" })).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "Inicio" })) expect(link).toHaveAttribute("aria-current", "page");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con estimado: el mes en curso, la fecha, las cuatro cifras y el aviso de lo que no incluye", async () => {
    await home();
    const month = screen.getByRole("region", { name: "Marzo de 2031, en curso" });
    expect(within(month).getByText(/^Actualizado el 12 de marzo de 2031 a las 5:40/)).toBeInTheDocument();
    for (const [label, value] of [
      ["Lecciones terminadas", "214"],
      ["Lecciones a medias", "37"],
      ["Alumnos distintos", "58"],
      ["Llevas ganado", "$1,234.56"],
    ] as const) {
      const tile = within(month).getByText(label).parentElement as HTMLElement;
      expect(within(tile).getByText(value)).toBeInTheDocument();
    }
    // La estimada se lee «Estimado» antes que la cifra, con su fecha y que puede subir o bajar.
    const estimated = within(month).getByText("Llevas ganado").parentElement as HTMLElement;
    expect(estimated.textContent).toMatch(/Estimado\$1,234\.56Actualizado el 12 de marzo de 2031\. La cifra final sale al cierre y puede subir o bajar/);
    expect(estimated).toHaveClass("border-dashed");
    // Lo ganado va primero, en el teléfono y en escritorio, como en el diseño.
    const grid = estimated.parentElement?.parentElement as HTMLElement;
    expect(grid.firstElementChild).toContainElement(estimated);
    const reordered = [...month.querySelectorAll("[class]")].filter((node) => [...node.classList].some((name) => /(^|:)order-/.test(name)));
    expect(reordered).toEqual([]);
    expect(within(month).getByText(/No incluye tu parte del bote sin consumo, los bonos ni los ajustes/)).toBeInTheDocument();
    expect(screen.queryByText(/No se pudieron actualizar tus cifras/)).not.toBeInTheDocument();
    expect(screen.queryByText("Todavía no hay vistas que cuenten para el reparto este mes.")).not.toBeInTheDocument();
  });

  it("la tabla por curso, cada fila con su enlace al curso", async () => {
    await home();
    const table = screen.getByRole("table", { name: "Tus cursos este mes" });
    const row = within(table).getByRole("rowheader", { name: "Respirar para volver" }).closest("tr") as HTMLElement;
    for (const value of ["150", "22", "41"]) expect(within(row).getByText(value)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Respirar para volver" })).toHaveAttribute("href", `/portal/cursos/${COURSE}`);
    expect(within(screen.getByRole("list", { name: "Tus cursos este mes" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("la fila de un curso que ya no es suyo va con sus cifras y sin enlace", async () => {
    answers(ready({ ...VALUE, courses: [{ ...VALUE.courses[0]!, owned: false }, VALUE.courses[1]!] }));
    await home();
    const table = screen.getByRole("table", { name: "Tus cursos este mes" });
    const row = within(table).getByRole("rowheader", { name: "Respirar para volver" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("150")).toBeInTheDocument();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Respirar para volver" })).not.toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Meditación para empezar" })).toHaveAttribute("href", `/portal/cursos/${OTHER}`);
  });

  it("los periodos anteriores: el cerrado con su total y su liquidación, el que todavía no cierra como estimado", async () => {
    await home();
    const periods = screen.getByRole("region", { name: "Periodos anteriores" });
    const table = within(periods).getByRole("table", { name: "Lo que te tocó en cada periodo" });
    const january = within(table).getByRole("rowheader", { name: "Enero de 2031" }).closest("tr") as HTMLElement;
    expect(within(january).getByText("$980.00")).toBeInTheDocument();
    expect(within(january).getByRole("link", { name: "Enero de 2031" })).toHaveAttribute("href", "/portal/pagos/2031-01");
    const february = within(table).getByRole("rowheader", { name: "Febrero de 2031" }).closest("tr") as HTMLElement;
    expect(within(february).getByText("Estimado")).toBeInTheDocument();
    expect(within(february).getByText("Todavía sin cerrar")).toBeInTheDocument();
    expect(within(february).queryByRole("link")).not.toBeInTheDocument();
  });

  it("sin barras por día ni porcentaje del bote", async () => {
    const { container } = await home();
    expect(screen.queryByText(/por día/i)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/%/);
  });

  it("publicado y sin vistas: ceros, con su frase", async () => {
    answers(ready({ ...VALUE, current: { period: "2031-03", run: { ...RUN, estimatedCents: 0, fullLessons: 0, halfLessons: 0, students: 0 }, lastFailed: false, stale: false } }));
    await home();
    expect(screen.getByText("Todavía no hay vistas que cuenten para el reparto este mes.")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("sin corrida: ninguna cifra ni un cero, y lo dice", async () => {
    answers(ready({ ...VALUE, current: { period: "2031-03", run: null, lastFailed: false, stale: false }, courses: [{ courseId: COURSE, title: "Respirar para volver", owned: true, figures: null }] }));
    await home();
    const month = screen.getByRole("region", { name: "Marzo de 2031, en curso" });
    expect(within(month).getAllByText("Sin datos todavía")).toHaveLength(4);
    expect(within(month).queryByText(/Actualizado el/)).not.toBeInTheDocument();
    expect(within(month).queryByText(/\$/)).not.toBeInTheDocument();
    expect(within(month).getByText("Todavía no hay cifras de este mes: se calculan cada noche.")).toBeInTheDocument();
    const row = within(screen.getByRole("table", { name: "Tus cursos este mes" })).getByRole("rowheader", { name: "Respirar para volver" }).closest("tr") as HTMLElement;
    expect(within(row).getAllByText("Sin datos todavía")).toHaveLength(3);
  });

  it("la corrida que falló: lo dice con la fecha de lo que se ve, sin cifra inventada", async () => {
    answers(ready({ ...VALUE, current: { period: "2031-03", run: RUN, lastFailed: true, stale: false } }));
    await home();
    expect(screen.getByText("No se pudieron actualizar tus cifras. Estas son del 12 de marzo de 2031.")).toBeInTheDocument();
    expect(screen.getByText("$1,234.56")).toBeInTheDocument();

    answers(ready({ ...VALUE, current: { period: "2031-03", run: null, lastFailed: true, stale: false } }));
    const again = await home();
    expect(within(again.container).getByText("No se pudieron actualizar tus cifras. Todavía no hay cifras de este mes.")).toBeInTheDocument();
    const month = within(again.container).getByRole("region", { name: "Marzo de 2031, en curso" });
    expect(within(month).queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("la corrida buena vieja (la noche no la renovó): lo dice con su fecha, sin cifra inventada", async () => {
    answers(ready({ ...VALUE, current: { period: "2031-03", run: RUN, lastFailed: false, stale: true } }));
    await home();
    const month = screen.getByRole("region", { name: "Marzo de 2031, en curso" });
    expect(within(month).getByText("No se pudieron actualizar tus cifras. Estas son del 12 de marzo de 2031.")).toBeInTheDocument();
    expect(within(month).getByText("$1,234.56")).toBeInTheDocument();
    expect(screen.queryByText(/anoche/)).not.toBeInTheDocument();
  });

  it("sin cursos publicados: «Para empezar» con sus pasos y «Ir a mis cursos», sin cifras", async () => {
    mocks.taxProfileState.mockResolvedValueOnce({ ...TAX, version: 0 });
    answers(ready({ hasPublished: false, current: { period: "2031-03", run: null, lastFailed: false, stale: false }, courses: [], series: [] }));
    const { container } = await home();
    const start = screen.getByRole("region", { name: "Para empezar" });
    const steps = within(start).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual(["Captura tus datos fiscales y bancariosPendiente", "Crea y envía tu primer cursoPendiente"]);
    expect(within(start).getByRole("link", { name: "Captura tus datos fiscales y bancarios" })).toHaveAttribute("href", "/portal/datos-fiscales");
    expect(within(start).getByRole("link", { name: "Crea y envía tu primer curso" })).toHaveAttribute("href", "/portal/cursos");
    expect(screen.getByText("Tus números aparecen aquí cuando publiques tu primer curso.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir a mis cursos" })).toHaveAttribute("href", "/portal/cursos");
    // El aviso de datos fiscales sigue, con su propio enlace.
    expect(screen.getByRole("link", { name: "Capturar mis datos fiscales" })).toHaveAttribute("href", "/portal/datos-fiscales");
    expect(screen.queryByRole("region", { name: "Marzo de 2031, en curso" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con los datos fiscales capturados, ese paso está listo y no enlaza", async () => {
    answers(ready({ hasPublished: false, current: { period: "2031-03", run: null, lastFailed: false, stale: false }, courses: [], series: [] }));
    await home();
    const start = screen.getByRole("region", { name: "Para empezar" });
    expect(within(start).queryByRole("link", { name: "Captura tus datos fiscales y bancarios" })).not.toBeInTheDocument();
    expect(within(start).getByText("Listo")).toBeInTheDocument();
  });

  it("el suspendido en «Para empezar»: no se le ofrece crear un curso", async () => {
    teaches("suspended");
    mocks.taxProfileState.mockResolvedValueOnce({ ...TAX, version: 0 });
    answers(ready({ hasPublished: false, current: { period: "2031-03", run: null, lastFailed: false, stale: false }, courses: [], series: [] }));
    const { container } = await home();
    expect(screen.getByText(/Tu cuenta está en solo lectura/)).toBeInTheDocument();
    const start = screen.getByRole("region", { name: "Para empezar" });
    expect(within(start).getByText("Crea y envía tu primer curso")).toBeInTheDocument();
    expect(within(start).queryByRole("link", { name: "Crea y envía tu primer curso" })).not.toBeInTheDocument();
    // Sus datos fiscales sí los captura: de ellos depende su pago (decisión de Sergio del 2026-11-01).
    expect(within(start).getByRole("link", { name: "Captura tus datos fiscales y bancarios" })).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("el suspendido lo ve todo, con la franja de solo lectura y el texto que se escribió para él", async () => {
    teaches("suspended", "Tu cuenta está en pausa mientras revisamos un caso.");
    await home();
    expect(screen.getByText(/Tu cuenta está en solo lectura/)).toBeInTheDocument();
    expect(screen.getByText("Tu cuenta está en pausa mientras revisamos un caso.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Marzo de 2031, en curso" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Tus cursos este mes" })).toBeInTheDocument();
  });

  it.each<[string, DashboardRead]>([
    ["no se supo", { kind: "unavailable" }],
    ["la base ya no lo tiene por maestro", { kind: "ready", value: { outcome: "not_teacher" } }],
  ])("%s: lo dice con «Reintentar», y los avisos del inicio siguen", async (_name, read) => {
    mocks.taxProfileState.mockResolvedValueOnce({ ...TAX, version: 0 });
    answers(read);
    const { container } = await home();
    expect(screen.getByText("No pudimos leer tus cifras. Intenta de nuevo en un momento.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/portal");
    expect(screen.getByRole("link", { name: "Capturar mis datos fiscales" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("si la guarda no supo, no lee nada y ofrece reintentar", async () => {
    mocks.requireTeacher.mockResolvedValueOnce({ kind: "unavailable" });
    await home();
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/portal");
    expect(mocks.teacherDashboard).not.toHaveBeenCalled();
    expect(mocks.taxProfileState).not.toHaveBeenCalled();
  });

  it("ninguna cifra por alumno: ni alias, ni identificadores, ni pesos fuera de lo estimado y de la serie", async () => {
    const { container } = await home();
    const shown = container.textContent ?? "";
    expect(shown).not.toMatch(/Ceiba|Río \d|alias|profile|a0000000/i);
    expect(screen.queryByRole("table", { name: /alumnos/i })).not.toBeInTheDocument();
    // Los únicos pesos: lo estimado del mes y la serie.
    expect(shown.match(/\$[\d,.]+/g)?.sort()).toEqual(["$1,012.34", "$1,012.34", "$1,234.56", "$980.00", "$980.00"].sort());
  });
});
