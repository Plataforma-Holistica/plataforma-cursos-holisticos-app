import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ui } from "@/messages/es/ui";

import { a11yViolations } from "../setup/a11y";

import { MAIN_CONTENT_ID, SkipLink } from "@/ui/skip-link";

describe("SkipLink", () => {
  it("es un enlace al contenido, con el texto del catálogo", () => {
    render(<SkipLink />);
    const link = screen.getByRole("link", { name: ui.skipLink });
    expect(link).toHaveAttribute("href", `#${MAIN_CONTENT_ID}`);
    expect(MAIN_CONTENT_ID).toBe("contenido");
  });

  it("es lo primero que recibe el foco al navegar con teclado", async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink />
        <a href="/cursos">Cursos</a>
        <main id={MAIN_CONTENT_ID} tabIndex={-1} />
      </>,
    );
    await user.tab();
    expect(screen.getByRole("link", { name: ui.skipLink })).toHaveFocus();
  });

  it("está oculto a la vista hasta que recibe el foco", () => {
    render(<SkipLink />);
    const link = screen.getByRole("link", { name: ui.skipLink });
    expect(link).toHaveClass("sr-only", "focus-visible:not-sr-only");
  });

  it("no tiene faltas de accesibilidad", async () => {
    const { container } = render(<SkipLink />);
    expect(await a11yViolations(container)).toEqual([]);
  });
});
