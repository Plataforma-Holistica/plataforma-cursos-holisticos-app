import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import { SideFrame } from "@/app/_lib/side-nav";
import { terms } from "@/messages/es/terms";

// El menú lateral del portal y de administración (T-614; T-616): el logotipo no se corta. En la columna de computadora, con la flor
// (T-616), el nombre a su tamaño no cabía: se leía «Escuela de Misterio» (recorrido del carril A del 2026-11-12).

const TEXT = { label: "Portal", menu: "Menú", platform: "Ir a mi inicio", signOut: "Cerrar sesión" };

describe("el menú lateral", () => {
  it("el nombre del logotipo puede partirse en dos renglones: no se corta en la columna", () => {
    render(
      <SideFrame home="/portal" groups={[]} current="/portal" text={TEXT}>
        <main />
      </SideFrame>,
    );
    const name = screen.getByRole("link", { name: terms.Plataforma }).firstElementChild;
    expect(name).toHaveClass("whitespace-normal", "leading-tight");
    // Sin la clase que lo impediría: dos de la misma propiedad en el mismo elemento las decide el orden del CSS, no el del atributo.
    expect(name).not.toHaveClass("whitespace-nowrap");
  });
});
