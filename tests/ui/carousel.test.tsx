import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Carousel } from "@/ui/carousel";

import { a11yViolations } from "../setup/a11y";

// El carrusel (diseño, sección 5.3; T-210): la fila es una lista nombrada por su título, las
// flechas aparecen solo cuando hay más de ese lado, y la que tiene el foco no se desmonta al
// llegar al final (lo encontró la revisión del diff). El DOM simulado no mide: el ancho y el
// desplazamiento se fijan a mano.

function measured(list: HTMLElement, { left, client, scroll }: { left: number; client: number; scroll: number }) {
  Object.defineProperty(list, "scrollLeft", { configurable: true, value: left });
  Object.defineProperty(list, "clientWidth", { configurable: true, value: client });
  Object.defineProperty(list, "scrollWidth", { configurable: true, value: scroll });
  list.scrollBy = () => {};
  act(() => {
    fireEvent.scroll(list);
  });
}

function row() {
  return render(
    <Carousel id="nuevos" title="Nuevos">
      <a href="#uno">Uno</a>
      {null}
      <a href="#dos">Dos</a>
    </Carousel>,
  );
}

describe("el carrusel", () => {
  it("es una sección y una lista nombradas por su título, sin lo vacío", async () => {
    const { container } = row();
    expect(screen.getByRole("heading", { level: 2, name: "Nuevos" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Nuevos" }).querySelectorAll("li")).toHaveLength(2);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("las flechas aparecen solo cuando hay más de ese lado", () => {
    row();
    const list = screen.getByRole("list", { name: "Nuevos" });
    measured(list, { left: 0, client: 300, scroll: 900 });
    expect(screen.queryByRole("button", { name: "Ver anteriores de Nuevos" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ver más de Nuevos" })).toBeInTheDocument();
    measured(list, { left: 300, client: 300, scroll: 900 });
    expect(screen.getByRole("button", { name: "Ver anteriores de Nuevos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver más de Nuevos" })).toBeInTheDocument();
  });

  it("la flecha con el foco no se desmonta al llegar al final: queda inactiva hasta que el foco se va", () => {
    row();
    const list = screen.getByRole("list", { name: "Nuevos" });
    measured(list, { left: 0, client: 300, scroll: 900 });
    const next = screen.getByRole("button", { name: "Ver más de Nuevos" });
    act(() => next.focus());
    measured(list, { left: 600, client: 300, scroll: 900 });
    expect(next).toBeInTheDocument();
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    act(() => next.blur());
    expect(screen.queryByRole("button", { name: "Ver más de Nuevos" })).toBeNull();
  });
});
