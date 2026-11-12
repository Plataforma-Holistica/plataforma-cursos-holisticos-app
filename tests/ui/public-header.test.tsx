import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PublicHeader } from "@/app/_public/header";
import { landing } from "@/messages/es/landing";

// La barra pública (T-614; T-616, solicitud 4): «Planes» entre el logotipo y «Entrar», marcada en los planes.

describe("la barra pública", () => {
  it("en el teléfono el nombre del logotipo puede partirse en dos renglones: a 320 px, con la flor, no cabía junto a «Crear cuenta»", () => {
    render(<PublicHeader />);
    const name = within(screen.getByRole("banner")).getByRole("link", { name: "Escuela de Misterios" }).firstElementChild;
    expect(name).toHaveClass("max-sm:whitespace-normal", "max-sm:leading-tight");
  });

  it("en los planes, «Planes» va marcado como la página en que se está; en otra, no", () => {
    const { unmount } = render(<PublicHeader onPlans />);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: landing.header.plans })).toHaveAttribute("aria-current", "page");
    unmount();
    render(<PublicHeader />);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: landing.header.plans })).not.toHaveAttribute("aria-current");
  });
});
