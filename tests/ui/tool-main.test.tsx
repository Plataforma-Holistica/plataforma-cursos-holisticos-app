import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AdminMain } from "@/app/admin/_lib/shell";
import { PortalMain } from "@/app/portal/_lib/shell";

import { a11yViolations } from "../setup/a11y";

// El armazón común de las pantallas de trabajo (T-616, solicitudes 5 y 6): `ToolMain`, por sus dos envolturas.
// Lo que tiene que cumplir toda pantalla del portal y de administración: un solo `<main>` con un solo `<h1>`, el
// antetítulo que le toca, el ancho único en la cabecera y en el cuerpo, y lo angosto limitado adentro.

describe("el armazón de las pantallas de trabajo", () => {
  it("el portal: un h1, «Portal» de antetítulo en una pantalla del menú, y el ancho único", async () => {
    const { container } = render(
      <PortalMain title="Mis cursos" section lead={<p>Lo que acompaña.</p>}>
        <p>El cuerpo.</p>
      </PortalMain>,
    );
    const main = screen.getByRole("main");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Mis cursos" })).toBeInTheDocument();
    const eyebrow = screen.getByText("Portal");
    expect(eyebrow).toHaveClass("eyebrow");
    // El antetítulo va antes que el título, y los dos dentro de la cabecera.
    const header = main.querySelector("[data-tool-header]") as HTMLElement;
    expect(header).toContainElement(eyebrow);
    expect(eyebrow.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // La cabecera y el cuerpo, en el mismo ancho.
    const widths = [...main.querySelectorAll(".max-w-admin")];
    expect(widths).toHaveLength(2);
    expect(widths[0]).toContainElement(screen.getByRole("heading", { level: 1 }));
    expect(widths[1]).toContainElement(screen.getByText("El cuerpo."));
    expect(main.querySelector(".max-w-reading")).toContainElement(screen.getByText("Lo que acompaña."));
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("el portal: una pantalla que cuelga de otra no lleva «Portal», lleva lo suyo, y el cuerpo angosto se limita adentro", () => {
    render(
      <PortalMain title="Respirar" titleId="titulo-de-prueba" titleFocusable eyebrow="Avance de alumnos" measure="reading" above={<a href="#arriba">Mis cursos</a>}>
        <p>El cuerpo.</p>
      </PortalMain>,
    );
    expect(screen.queryByText("Portal")).not.toBeInTheDocument();
    expect(screen.getByText("Avance de alumnos")).toHaveClass("eyebrow");
    const title = screen.getByRole("heading", { level: 1, name: "Respirar" });
    expect(title).toHaveAttribute("id", "titulo-de-prueba");
    expect(title).toHaveAttribute("tabindex", "-1");
    expect(screen.getByText("El cuerpo.").parentElement).toHaveClass("max-w-reading");
    // «Volver a…» va arriba del título.
    expect(screen.getByRole("link", { name: "Mis cursos" }).compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sin antetítulo no se pinta ninguno, y el título no toma el foco si no se pide", () => {
    render(
      <PortalMain title="Borrar el curso">
        <p>El cuerpo.</p>
      </PortalMain>,
    );
    expect(screen.getByRole("main").querySelector(".eyebrow")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveAttribute("tabindex");
  });

  it("administración: el mismo armazón, con la capacidad de la sección de antetítulo", () => {
    render(
      <AdminMain title="Maestros" area="content">
        <p>El cuerpo.</p>
      </AdminMain>,
    );
    const main = screen.getByRole("main");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Contenido")).toHaveClass("eyebrow");
    expect(main.querySelectorAll(".max-w-admin")).toHaveLength(2);
    expect(main.querySelector("[data-tool-header]")).not.toBeNull();
  });
});
