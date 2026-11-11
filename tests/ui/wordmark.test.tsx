import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { terms } from "@/messages/es/terms";
import { Wordmark } from "@/ui/wordmark";

// El logotipo provisional (diseño, sección 3.12): la flor de la vida delante del nombre del catálogo de
// textos, en la tipografía de títulos. Desde T-616 (pedido de Sergio del 2026-11-11: el logotipo en toda
// página) la flor va siempre y el punto de oro de la variante A (T-614) se retiró. Cambiar al definitivo es
// reemplazar este componente.

describe("Wordmark", () => {
  it("dice el nombre del catálogo de textos, y nada más", () => {
    const { container } = render(<Wordmark />);
    expect(container.textContent).toBe(terms.Plataforma);
  });

  it("va en la tipografía de títulos, en negrita y sin partirse", () => {
    const { container } = render(<Wordmark />);
    expect(container.firstElementChild).toHaveClass("font-display", "font-bold", "whitespace-nowrap");
  });

  it("lleva siempre la flor, decorativa: el lector de pantalla lee solo el nombre (T-616)", () => {
    const { container } = render(<Wordmark />);
    const flower = container.querySelector("[data-brand-mark]");
    expect(flower).toHaveAttribute("aria-hidden", "true");
    expect(flower).toHaveAttribute("focusable", "false");
    expect(flower?.textContent).toBe("");
    // El punto de la variante A se retiró: el oro está en la roseta del centro de la flor.
    expect(container.querySelector("[data-brand-dot]")).toBeNull();
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
