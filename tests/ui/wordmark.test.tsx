import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { terms } from "@/messages/es/terms";
import { Wordmark } from "@/ui/wordmark";

// El logotipo provisional (diseño, sección 3.12; T-614): el nombre del catálogo de textos en la
// tipografía de títulos, con el punto de oro al final (la variante A, elegida por Sergio el
// 2026-11-05). Cambiar al definitivo es reemplazar este componente.

describe("Wordmark", () => {
  it("dice el nombre del catálogo de textos, y nada más", () => {
    const { container } = render(<Wordmark />);
    expect(container.textContent).toBe(terms.Plataforma);
  });

  it("va en la tipografía de títulos, en negrita y sin partirse", () => {
    const { container } = render(<Wordmark />);
    expect(container.firstElementChild).toHaveClass("font-display", "font-bold", "whitespace-nowrap");
  });

  it("el punto es del acento y decorativo: el lector de pantalla lee solo el nombre", () => {
    const { container } = render(<Wordmark />);
    const dot = container.querySelector("[data-brand-dot]");
    expect(dot).toHaveClass("bg-accent", "rounded-full");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot?.textContent).toBe("");
  });

  it("el tamaño lo pone quien lo usa", () => {
    const { container } = render(<Wordmark className="text-h3" />);
    expect(container.firstElementChild).toHaveClass("text-h3");
  });

  it("pasa las reglas automáticas de accesibilidad", async () => {
    const { container } = render(<Wordmark />);
    expect(await a11yViolations(container)).toEqual([]);
  });
});
