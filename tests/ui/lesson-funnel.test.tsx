import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { LessonFunnel, type FunnelRow } from "@/ui/lesson-funnel";

import { a11yViolations } from "../setup/a11y";

// Avance por lección (diseño, sección 5.10; PA-51; T-408): una fila por lección en el orden del temario, con su título, una barra horizontal y cuántos
// la terminaron. No es un embudo de ventas: no hay porcentajes de caída. Como `PeriodBars`, la gráfica es una ayuda que el lector de pantalla no lee, y
// los mismos datos van en una tabla que «Ver como tabla» muestra (lo hace el CSS, que el DOM simulado no aplica).

const ROWS: FunnelRow[] = [
  { key: "uno", label: "1. Respirar", value: 30, amount: "30" },
  { key: "dos", label: "2. Soltar", value: 12, amount: "12" },
  { key: "tres", label: "3. Volver", value: 0, amount: "0" },
];

const renderFunnel = (rows = ROWS, max = 41) =>
  render(<LessonFunnel id="lecciones" caption="Cuántos terminaron cada lección" rows={rows} max={max} empty="Este curso no tiene lecciones." />);

describe("LessonFunnel", () => {
  it("la tabla de datos, con cada lección en su orden y cuántos la terminaron, sin fallas de accesibilidad", async () => {
    const { container } = renderFunnel();
    const table = screen.getByRole("table", { name: "Cuántos terminaron cada lección" });
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["1. Respirar", "2. Soltar", "3. Volver"]);
    const second = within(table).getByRole("rowheader", { name: "2. Soltar" }).closest("tr") as HTMLElement;
    expect(within(second).getByText("12")).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("la gráfica no la lee el lector de pantalla, y el teclado llega a la casilla", async () => {
    const { container } = renderFunnel();
    expect(container.querySelector("[aria-hidden='true'] ol")).not.toBeNull();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Ver como tabla" })).toHaveFocus();
  });

  it("una fila por lección, en el orden del temario, con su título, su barra y su número, y sin porcentajes", () => {
    const { container } = renderFunnel();
    const chart = container.querySelector("[aria-hidden='true']") as HTMLElement;
    const rows = [...chart.querySelectorAll("li")] as HTMLElement[];
    expect(rows.map((row) => row.textContent)).toEqual(["1. Respirar30", "2. Soltar12", "3. Volver0"]);
    expect(chart.textContent).not.toMatch(/%/);
    // El ancho, contra quien lo empezó: 30 de 41 son 9 doceavos; un cero no tiene ancho.
    expect(rows[0]!.querySelector(".w-9\\/12")).not.toBeNull();
    expect(rows[1]!.querySelector(".w-4\\/12")).not.toBeNull();
    expect(rows[2]!.querySelector(".w-0")).not.toBeNull();
  });

  it("sin cifra no pinta una barra: dice que no hay datos", () => {
    const { container } = renderFunnel([{ key: "uno", label: "1. Respirar", value: null, amount: null }]);
    const chart = container.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(chart.querySelector("[class*='bg-']")).toBeNull();
    expect(within(chart).getByText("Sin datos todavía")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Sin datos todavía")).toBeInTheDocument();
  });

  it("sin lecciones, lo dice y no pinta gráfica ni tabla", () => {
    renderFunnel([]);
    expect(screen.getByText("Este curso no tiene lecciones.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
