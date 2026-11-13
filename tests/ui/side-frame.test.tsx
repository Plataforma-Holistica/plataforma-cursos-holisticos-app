import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import { SideFrame } from "@/app/_lib/side-nav";
import { AdminFrame } from "@/app/admin/_lib/frame";
import { PortalFrame } from "@/app/portal/_lib/frame";
import { terms } from "@/messages/es/terms";
import { ROUTES } from "@/services/account/navigation";

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

// `side-plane` (`theme.css`) viste al menú por sus marcadores, no por su lugar en el armazón (T-616, solicitudes 5 y 6):
// el marco, el `<nav>` y los títulos de grupo llevan cada uno el suyo, en la columna y en la hoja del teléfono.
describe("los marcadores del menú lateral", () => {
  /** Los títulos de grupo: los elementos que nombran una lista del menú (`aria-labelledby`). */
  function groupTitles(nav: HTMLElement): HTMLElement[] {
    return [...nav.querySelectorAll("ul[aria-labelledby]")].map((list) => document.getElementById(list.getAttribute("aria-labelledby") as string) as HTMLElement);
  }

  it("administración: el marco, el <nav> y cada título de grupo, en las dos copias del menú", () => {
    const { container } = render(
      <AdminFrame path={ROUTES.admin} capabilities={["content", "finance"]} portal={false}>
        <main />
      </AdminFrame>,
    );
    const nav = screen.getByRole("navigation");
    expect(nav).toHaveAttribute("data-side-nav");
    // El marco es hijo directo del envoltorio que lleva la utilidad, y el `<nav>` va dentro de él.
    const frame = container.querySelector(".side-plane > [data-side-frame]") as HTMLElement;
    expect(frame).toContainElement(nav);
    // Dos grupos, pintados dos veces: la hoja del teléfono y la columna.
    const titles = groupTitles(nav);
    expect(titles).toHaveLength(4);
    for (const title of titles) expect(title).toHaveAttribute("data-side-group");
    // Y nada más lleva el marcador de grupo.
    expect(nav.querySelectorAll("[data-side-group]")).toHaveLength(4);
  });

  it("el portal: el marco y el <nav>; sus entradas van sueltas, sin títulos de grupo", () => {
    const { container } = render(
      <PortalFrame current={ROUTES.portal} readOnly={false}>
        <main />
      </PortalFrame>,
    );
    const nav = screen.getByRole("navigation");
    expect(nav).toHaveAttribute("data-side-nav");
    expect(container.querySelector(".side-plane > [data-side-frame]")).toContainElement(nav);
    expect(nav.querySelectorAll("[data-side-group]")).toHaveLength(0);
  });
});
