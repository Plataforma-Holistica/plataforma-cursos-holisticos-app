import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { barStep, PeriodBars, type PeriodBar } from "@/ui/period-bars";

import { a11yViolations } from "../setup/a11y";

// Barras por periodo (diseño, sección 5.10; T-408): la gráfica es una ayuda que el lector de pantalla no lee, y los mismos datos van en una tabla que
// siempre está para él y que «Ver como tabla» muestra. Lo estimado se distingue por el contorno punteado y la palabra, no solo por el color. Que la tabla
// se vea al marcar la casilla lo hace el CSS (`:has(:checked)`), que el DOM simulado no aplica: se revisa en la muestra y en un navegador.

const BARS: PeriodBar[] = [
  { key: "2031-01", label: "Enero de 2031", amount: "$980.00", value: 98_000, estimated: false, href: "/portal/pagos/2031-01" },
  { key: "2030-12", label: "Diciembre de 2030", amount: "$0.00", value: 0, estimated: false, href: "/portal/pagos/2030-12" },
  { key: "2031-02", label: "Febrero de 2031", amount: "$1,960.00", value: 196_000, estimated: true, note: "Todavía sin cerrar" },
];

const renderBars = (bars = BARS) => render(<PeriodBars id="periodos" caption="Lo que te tocó en cada periodo" bars={bars} empty="Sin periodos todavía." />);

describe("PeriodBars", () => {
  it("la tabla de datos, con cada periodo, su monto y si es final o estimado, sin fallas de accesibilidad", async () => {
    const { container } = renderBars();
    const table = screen.getByRole("table", { name: "Lo que te tocó en cada periodo" });
    const rows = within(table).getAllByRole("rowheader").map((cell) => cell.textContent);
    expect(rows).toEqual(["Enero de 2031", "Diciembre de 2030", "Febrero de 2031"]);
    const closing = within(table).getByRole("rowheader", { name: "Febrero de 2031" }).closest("tr") as HTMLElement;
    expect(within(closing).getByText("$1,960.00")).toBeInTheDocument();
    expect(within(closing).getByText("Estimado")).toBeInTheDocument();
    expect(within(closing).getByText("Todavía sin cerrar")).toBeInTheDocument();
    const january = within(table).getByRole("rowheader", { name: "Enero de 2031" }).closest("tr") as HTMLElement;
    expect(within(january).getByText("Final")).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("cada cerrado enlaza a su liquidación desde la tabla; el estimado, no", () => {
    renderBars();
    expect(screen.getByRole("link", { name: "Enero de 2031" })).toHaveAttribute("href", "/portal/pagos/2031-01");
    expect(screen.getByRole("link", { name: "Diciembre de 2030" })).toHaveAttribute("href", "/portal/pagos/2030-12");
    expect(screen.queryByRole("link", { name: "Febrero de 2031" })).not.toBeInTheDocument();
  });

  it("la gráfica no la lee el lector de pantalla, y sus enlaces quedan fuera del teclado", async () => {
    const { container } = renderBars();
    const chart = container.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(chart).not.toBeNull();
    for (const link of chart.querySelectorAll("a")) expect(link).toHaveAttribute("tabindex", "-1");
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Ver como tabla" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Enero de 2031" })).toHaveFocus();
  });

  it("lo estimado va con contorno punteado y la palabra; lo cerrado, relleno: no depende del color", () => {
    const { container } = renderBars();
    const chart = container.querySelector("[aria-hidden='true']") as HTMLElement;
    const columns = [...chart.querySelectorAll("li")];
    expect(columns).toHaveLength(3);
    const [january, , february] = columns as unknown as [HTMLElement, HTMLElement, HTMLElement];
    expect(january.querySelector(".bg-text-2")).not.toBeNull();
    expect(january.querySelector(".border-dashed")).toBeNull();
    expect(within(january).queryByText("Estimado")).not.toBeInTheDocument();
    expect(february.querySelector(".border-dashed")).not.toBeNull();
    expect(february.querySelector(".bg-text-2")).toBeNull();
    expect(within(february).getByText("Estimado")).toBeInTheDocument();
    // La más alta llena la gráfica; un cero no tiene alto.
    expect(february.querySelector(".h-full")).not.toBeNull();
    expect((columns[1] as HTMLElement).querySelector(".h-0")).not.toBeNull();
  });

  it("sin cifra no pinta una barra: dice que no hay datos", () => {
    const { container } = renderBars([{ key: "2031-02", label: "Febrero de 2031", amount: null, value: null, estimated: true }]);
    const chart = container.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(chart.querySelector(".border-dashed")).toBeNull();
    expect(within(chart).getByText("Sin datos todavía")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Lo que te tocó en cada periodo" });
    expect(within(table).getByText("Sin datos todavía")).toBeInTheDocument();
  });

  it("sin periodos, lo dice y no pinta gráfica ni tabla", () => {
    renderBars([]);
    expect(screen.getByText("Sin periodos todavía.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it.each([
    [0, 100, 0],
    [100, 100, 12],
    [50, 100, 6],
    [1, 1_000, 1],
    [-5, 100, 0],
    [5, 0, 0],
  ])("el alto de %d contra %d es %d doceavos", (value, max, step) => {
    expect(barStep(value, max)).toBe(step);
  });
});
