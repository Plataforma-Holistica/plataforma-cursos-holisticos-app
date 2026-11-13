import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { NO_NAV_ACCESS, type NavAccess } from "@/services/account/nav-access";

vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import { takeArrival } from "@/app/_catalog/my-list-link";
import { StudentNav } from "@/app/_catalog/nav";

// La barra única del alumno (T-616, solicitud 2; pedidos de Sergio del 2026-11-10 y 11): fija arriba, con
// Inicio, Explorar y Mi lista; «Mi portal» y «Administración» solo a quien le tocan; y el menú de la persona.
// En el teléfono, abajo, Inicio, Explorar, Mi lista y Cuenta, y los accesos por rol arriba del menú. Quién
// ve cada acceso lo decide `navAccessOf` (src/domain/access/nav-access.test.ts); aquí, que la barra lo obedezca.

const EMAIL = "ana@prueba.test";
const BOTH: NavAccess = { admin: true, portal: true };

function bar(access: NavAccess = NO_NAV_ACCESS, current?: "/inicio" | "/explorar" | "/cuenta" | "/cuenta/comentarios") {
  return render(
    <>
      <StudentNav access={access} email={EMAIL} {...(current ? { current } : {})} />
      <main>
        <a href="#fuera">Fuera</a>
      </main>
    </>,
  );
}

const principal = () => screen.getByRole("navigation", { name: "Principal" });
const menu = () => screen.getByText("Tu cuenta", { selector: "summary *, summary" }).closest("details") as HTMLDetailsElement;

describe("la barra del alumno", () => {
  it("lleva Inicio, Explorar, Mi lista y Cuenta, con la página actual marcada", () => {
    bar(NO_NAV_ACCESS, "/inicio");
    const nav = principal();
    expect(within(nav).getByRole("link", { name: "Inicio" })).toHaveAttribute("href", "/inicio");
    expect(within(nav).getByRole("link", { name: "Inicio" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Explorar" })).toHaveAttribute("href", "/explorar");
    expect(within(nav).getByRole("link", { name: "Explorar" })).not.toHaveAttribute("aria-current");
    // Mi lista es un bloque del inicio: lo marcado es el inicio, no ella.
    expect(within(nav).getByRole("link", { name: "Mi lista" })).toHaveAttribute("href", "/inicio#bloque-mi-lista");
    expect(within(nav).getByRole("link", { name: "Mi lista" })).not.toHaveAttribute("aria-current");
    // Cuenta va en la barra de abajo del teléfono; en computadora está en el menú.
    expect(within(nav).getByRole("link", { name: "Cuenta" })).toHaveAttribute("href", "/cuenta");
    expect(within(nav).getByRole("link", { name: "Cuenta" }).closest("li")).toHaveClass("sm:hidden");
  });

  it("el logotipo vuelve al inicio, y va con la flor", () => {
    bar();
    const banner = screen.getByRole("banner");
    const logo = within(banner).getAllByRole("link")[0];
    expect(logo).toHaveAttribute("href", "/inicio");
    expect(logo?.querySelector("[data-brand-mark]")).not.toBeNull();
  });

  it("va fija arriba desde lg, por encima de lo que se pega, y las dos se retiran con el reproductor a pantalla completa", () => {
    bar();
    const banner = screen.getByRole("banner");
    // Más angosto, el buscador de Explorar y el reproductor se pegan arriba ellos (revisión del diff de la 146).
    expect(banner).toHaveClass("lg:sticky", "lg:top-0", "student-top-bar", "relative", "z-(--z-dropdown)");
    expect(banner).not.toHaveClass("sticky");
    expect(principal()).toHaveClass("student-bottom-bar", "fixed");
    expect(banner).toHaveAttribute("data-student-nav");
  });

  it("sin accesos por rol no pinta «Mi portal» ni «Administración» en ningún lado", () => {
    bar();
    expect(screen.queryByRole("link", { name: /Mi portal/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Administración/ })).toBeNull();
  });

  it.each([
    [{ admin: false, portal: true }, ["/portal"]],
    [{ admin: true, portal: false }, ["/admin"]],
    [BOTH, ["/portal", "/admin"]],
  ] as const)("con %o pinta solo esos accesos, en la barra y arriba del menú", (access, hrefs) => {
    bar(access);
    const shown = [...screen.getByRole("banner").querySelectorAll("a")].map((link) => link.getAttribute("href"));
    for (const href of ["/portal", "/admin"]) {
      // Dos veces cada uno: en la barra de la computadora y, en el teléfono, en el menú.
      expect(shown.filter((link) => link === href), href).toHaveLength(hrefs.includes(href as never) ? 2 : 0);
    }
    for (const href of hrefs) {
      const [wide, narrow] = [...screen.getByRole("banner").querySelectorAll(`a[href="${href}"]`)];
      expect(wide?.closest("details")).toBeNull();
      // En computadora, aparte del menú de la persona, tras un filete tenue.
      expect(wide?.closest("[data-role-access]")).toHaveClass("hidden", "sm:flex", "border-r", "border-edge-ring");
      // En el menú van primero, antes de Cuenta, como botones con su icono, y solo en el teléfono.
      expect(narrow?.closest("details")).toBe(menu());
      expect(narrow?.closest("li")).toHaveClass("sm:hidden");
      expect(narrow?.querySelector("svg")).not.toBeNull();
    }
    const menuLinks = within(menu()).getAllByRole("link", { hidden: true }).map((link) => link.getAttribute("href"));
    expect(menuLinks.slice(0, hrefs.length)).toEqual(hrefs);
    expect(menuLinks.slice(hrefs.length)).toEqual(["/cuenta", "/cuenta/comentarios"]);
  });

  it("el menú lleva el correo con que se entró, Cuenta, Mis comentarios y Cerrar sesión", () => {
    bar();
    const details = menu();
    // Solo el correo, en una línea: «Entraste como» va a la vista bajo el saludo del inicio (03).
    const email = within(details).getByText(EMAIL, { exact: true });
    expect(email).toHaveClass("truncate", "text-text-3");
    expect(email).toHaveAttribute("title", EMAIL);
    expect(within(details).queryByText(/Entraste como/)).toBeNull();
    expect(within(details).getByRole("link", { name: "Cuenta", hidden: true })).toHaveAttribute("href", "/cuenta");
    expect(within(details).getByRole("link", { name: "Mis comentarios", hidden: true })).toHaveAttribute("href", "/cuenta/comentarios");
    expect(within(details).getByRole("button", { name: "Cerrar sesión", hidden: true }).closest("form")).not.toBeNull();
  });

  it("en el menú, la entrada de la página en que se está va marcada", () => {
    const { unmount } = bar(NO_NAV_ACCESS, "/cuenta");
    expect(within(menu()).getByRole("link", { name: "Cuenta", hidden: true })).toHaveAttribute("aria-current", "page");
    expect(within(menu()).getByRole("link", { name: "Mis comentarios", hidden: true })).not.toHaveAttribute("aria-current");
    unmount();
    bar(NO_NAV_ACCESS, "/cuenta/comentarios");
    expect(within(menu()).getByRole("link", { name: "Mis comentarios", hidden: true })).toHaveAttribute("aria-current", "page");
    expect(within(menu()).getByRole("link", { name: "Cuenta", hidden: true })).not.toHaveAttribute("aria-current");
    // En la lista de abajo, Cuenta solo en la cuenta misma.
    expect(within(principal()).getByRole("link", { name: "Cuenta" })).not.toHaveAttribute("aria-current");
  });

  it("sin correo, el menú no inventa uno", () => {
    render(<StudentNav access={NO_NAV_ACCESS} email={null} />);
    expect(screen.queryByText(/@/)).toBeNull();
    expect(screen.getByRole("banner").querySelector("details [title]")).toBeNull();
  });

  it("«Mi lista» va por el enrutador y le avisa al bloque que se llegó a él", async () => {
    const user = userEvent.setup();
    const arrivals = vi.fn();
    window.addEventListener("mi-lista:llegada", arrivals);
    bar();
    await user.click(within(principal()).getByRole("link", { name: "Mi lista" }));
    expect(arrivals).toHaveBeenCalledTimes(1);
    window.removeEventListener("mi-lista:llegada", arrivals);
  });

  // T-616, 3b-1: con una tecla de modificación o con otro botón, el enlace abre en otra pestaña o ventana, o no navega: el
  // bloque de esta pestaña no debe darse por llegado, ni quedar la marca para el próximo inicio que se monte.
  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["el botón de en medio", { button: 1 }],
  ] as const)("con %s, «Mi lista» no avisa la llegada ni deja la marca", (_, modifiers) => {
    // Lo que haya dejado otra prueba de este archivo.
    takeArrival();
    const arrivals = vi.fn();
    window.addEventListener("mi-lista:llegada", arrivals);
    bar();
    const link = within(principal()).getByRole("link", { name: "Mi lista" });
    // Que el DOM simulado no intente seguir el enlace: en el documento, después de los manejadores de React.
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, modifiers);
    expect(arrivals).not.toHaveBeenCalled();
    expect(takeArrival()).toBe(false);
    window.removeEventListener("mi-lista:llegada", arrivals);
  });

  it("un clic simple avisa la llegada y deja la marca, que se usa una sola vez", async () => {
    takeArrival();
    const user = userEvent.setup();
    bar();
    await user.click(within(principal()).getByRole("link", { name: "Mi lista" }));
    expect(takeArrival()).toBe(true);
    expect(takeArrival()).toBe(false);
  });

  // T-616, 3b-1: los accesos por rol y el menú de la persona iban en un `<div>` sin región, fuera de la navegación.
  it("los accesos por rol y el menú de la persona van en su propia navegación, con nombre, y la principal no cambia", () => {
    bar(BOTH, "/inicio");
    const account = screen.getByRole("navigation", { name: "Tu cuenta y accesos" });
    expect(account).toContainElement(menu());
    expect(account.querySelector("[data-role-access]")).not.toBeNull();
    // En el teléfono, los accesos de la barra siguen escondidos: van en el menú.
    expect(account.querySelector("[data-role-access]")).toHaveClass("hidden", "sm:flex");
    expect(principal()).not.toContainElement(menu());
    expect(within(principal()).getAllByRole("link").map((link) => link.textContent)).toEqual(["Inicio", "Explorar", "Mi lista", "Cuenta"]);
  });

  it("los resúmenes no llevan el triángulo, tampoco en WebKit", () => {
    bar();
    expect(menu().querySelector("summary")).toHaveClass("summary-plain");
  });

  it("es un solo <details>, sin el papel de menú de las aplicaciones", () => {
    bar(BOTH);
    expect(screen.getByRole("banner").querySelectorAll("details")).toHaveLength(1);
    expect(screen.getByRole("banner").querySelector("[role='menu'], [aria-haspopup]")).toBeNull();
  });

  it("se abre con su resumen; Escape lo cierra y el foco vuelve al resumen", async () => {
    const user = userEvent.setup();
    bar();
    const summary = menu().querySelector("summary") as HTMLElement;
    await user.click(summary);
    expect(menu().open).toBe(true);
    await user.tab();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(menu().open).toBe(false), { timeout: 3_000 });
    expect(summary).toHaveFocus();
  });

  it("se cierra con un clic fuera de él", async () => {
    const user = userEvent.setup();
    bar();
    await user.click(menu().querySelector("summary") as HTMLElement);
    expect(menu().open).toBe(true);
    await user.click(screen.getByRole("link", { name: "Fuera" }));
    await waitFor(() => expect(menu().open).toBe(false), { timeout: 3_000 });
  });

  it("se cierra al elegir una entrada", async () => {
    const user = userEvent.setup();
    bar();
    await user.click(menu().querySelector("summary") as HTMLElement);
    await user.click(within(menu()).getByRole("link", { name: "Mis comentarios" }));
    await waitFor(() => expect(menu().open).toBe(false), { timeout: 3_000 });
  });

  it("pasa las reglas automáticas de accesibilidad, cerrado y abierto", async () => {
    const user = userEvent.setup();
    const { container } = bar(BOTH, "/explorar");
    expect(await a11yViolations(container)).toEqual([]);
    await user.click(menu().querySelector("summary") as HTMLElement);
    expect(await a11yViolations(container)).toEqual([]);
  });
});
