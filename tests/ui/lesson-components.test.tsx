import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { BackLink } from "@/ui/back-link";
import { LessonRow } from "@/ui/lesson-row";
import { ProgressBar } from "@/ui/progress-bar";
import { Tabs } from "@/ui/tabs";

// Los componentes base que llegan con la página de la lección (PA-22, T-203; diseño, sección
// 5.2 y 5.3): regresar, pestañas y la fila de una lección; y con el progreso (T-206), los estados
// de la fila y la barra.

const ITEMS = [
  { id: "temario", label: "Temario", panel: <p>Las lecciones.</p> },
  { id: "sobre", label: "Sobre esta lección", panel: <p>De qué trata.</p> },
  { id: "notas", label: "Notas", panel: <p>Lo que anotaste.</p> },
];

describe("Tabs", () => {
  it("es una lista de pestañas con su nombre; la primera activa y su panel a la vista", async () => {
    const { container } = render(<Tabs label="Partes de la lección" items={ITEMS} idPrefix="leccion" />);
    expect(screen.getByRole("tablist", { name: "Partes de la lección" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Temario" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Sobre esta lección" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "Temario" })).toHaveTextContent("Las lecciones.");
    expect(screen.queryByText("De qué trata.")).not.toBeVisible();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("solo la activa recibe el foco con Tab, y Tab entra al panel", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Partes" items={ITEMS} idPrefix="leccion" />);
    await user.tab();
    expect(screen.getByRole("tab", { name: "Temario" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("tabpanel", { name: "Temario" })).toHaveFocus();
  });

  it("un panel con enlaces no es una parada de tabulación: Tab va al primer enlace", async () => {
    const user = userEvent.setup();
    const items = [{ id: "temario", label: "Temario", panel: <a href="#uno">Uno</a>, hasFocusableContent: true }, ...ITEMS.slice(1)];
    render(<Tabs label="Partes" items={items} idPrefix="leccion" />);
    await user.tab();
    await user.tab();
    expect(screen.getByRole("link", { name: "Uno" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Temario" })).not.toHaveAttribute("tabindex");
  });

  it("las flechas cambian de pestaña y dan la vuelta; Inicio y Fin van a los extremos", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Partes" items={ITEMS} idPrefix="leccion" />);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Sobre esta lección" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Sobre esta lección" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("De qué trata.")).toBeVisible();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Temario" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Notas" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Temario" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Notas" })).toHaveFocus();
    // Otra tecla no mueve nada.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: "Notas" })).toHaveFocus();
  });

  it("con el clic también", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Partes" items={ITEMS} idPrefix="leccion" />);
    await user.click(screen.getByRole("tab", { name: "Notas" }));
    expect(screen.getByText("Lo que anotaste.")).toBeVisible();
    expect(screen.queryByText("Las lecciones.")).not.toBeVisible();
  });

  it("sin JavaScript se pintan todos los paneles, cada uno con su título, y ninguna pestaña", () => {
    const html = renderToString(<Tabs label="Partes" items={ITEMS} idPrefix="leccion" />);
    expect(html).not.toContain('role="tablist"');
    for (const item of ITEMS) expect(html).toContain(`<h2 id="leccion-${item.id}-title" class="text-h3">${item.label}</h2>`);
    expect(html).toContain("Las lecciones.");
    expect(html).toContain("Lo que anotaste.");
  });
});

describe("LessonRow", () => {
  it("es un enlace cuyo nombre dice número, título y duración, y contiene lo que se ve", () => {
    render(<LessonRow href="/cursos/x/lecciones/1" number={3} title="Cuatro tiempos" duration="6 min" />);
    const link = screen.getByRole("link", { name: "Lección 3, Cuatro tiempos, 6 min" });
    expect(link).toHaveAttribute("href", "/cursos/x/lecciones/1");
    expect(link).not.toHaveAttribute("aria-current");
  });

  it("la que se está viendo lo dice en el nombre, a la vista y como página actual", async () => {
    const { container } = render(<LessonRow href="/cursos/x/lecciones/1" number={5} title="Acostado" duration="7 min" current />);
    const link = screen.getByRole("link", { name: "Lección 5, Acostado, 7 min, reproduciendo" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveTextContent("7 min · Reproduciendo");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it.each([
    ["not_started", "Lección 3, Cuatro tiempos, 6 min", "6 min"],
    ["in_progress", "Lección 3, Cuatro tiempos, 6 min, a medias", "6 min · A medias"],
    ["completed", "Lección 3, Cuatro tiempos, 6 min, terminada", "6 min · Terminada"],
    ["locked", "Lección 3, Cuatro tiempos, 6 min, requiere suscripción", "6 min · Requiere suscripción"],
  ] as const)("%s: el estado va en el nombre y a la vista (T-206, T-210)", async (state, name, seen) => {
    const { container } = render(<LessonRow href="/cursos/x/lecciones/1" number={3} title="Cuatro tiempos" duration="6 min" state={state} />);
    expect(screen.getByRole("link", { name })).toHaveTextContent(seen);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("la que se está viendo, si ya está terminada, dice las dos cosas", () => {
    render(<LessonRow href="/cursos/x/lecciones/1" number={5} title="Acostado" duration="7 min" state="completed" current />);
    expect(screen.getByRole("link", { name: "Lección 5, Acostado, 7 min, terminada, reproduciendo" })).toHaveTextContent("7 min · Terminada · Reproduciendo");
  });

  it("a medias no se repite en la que se está viendo: reproduciendo ya lo dice", () => {
    render(<LessonRow href="/cursos/x/lecciones/1" number={5} title="Acostado" duration="7 min" state="in_progress" current />);
    expect(screen.getByRole("link", { name: "Lección 5, Acostado, 7 min, reproduciendo" })).toHaveTextContent("7 min · Reproduciendo");
  });
});

describe("ProgressBar", () => {
  it("es una barra con su valor, y el dato va también en texto a la vista", async () => {
    const { container } = render(<ProgressBar value={4} max={12} label="Avance del curso" text="4 de 12 lecciones" />);
    const bar = screen.getByRole("progressbar", { name: "Avance del curso" });
    expect(bar).toHaveAttribute("aria-valuenow", "4");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "12");
    expect(bar).toHaveAttribute("aria-valuetext", "4 de 12 lecciones");
    expect(container).toHaveTextContent("4 de 12 lecciones");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it.each([
    [0, 12, "0", "12"],
    [6, 12, "6", "12"],
    [20, 12, "12", "12"],
    [-3, 12, "0", "12"],
    [3, 0, "0", "1"],
  ])("lo lleno no sale de la barra: %i de %i", (value, max, now, top) => {
    render(<ProgressBar value={value} max={max} label="Avance" text="x" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("value", now);
    expect(bar).toHaveAttribute("max", top);
    expect(bar).toHaveAttribute("aria-valuenow", now);
  });

  it("fina para las tarjetas, media para la ficha", () => {
    const { rerender } = render(<ProgressBar value={1} max={2} label="Avance" text="x" size="thin" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-size", "thin");
    rerender(<ProgressBar value={1} max={2} label="Avance" text="x" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-size", "medium");
  });
});

describe("BackLink", () => {
  it("es un enlace que dice a dónde regresa", async () => {
    const { container } = render(<BackLink href="/inicio">Volver al inicio</BackLink>);
    expect(screen.getByRole("link", { name: "Volver al inicio" })).toHaveAttribute("href", "/inicio");
    expect(await a11yViolations(container)).toEqual([]);
  });
});

// La pestaña elegida puede dejar de existir con la pantalla abierta (T-404: los recursos, si el acceso termina).
describe("Tabs, cuando la elegida se va", () => {
  it("vuelve a la primera, con su panel a la vista y al alcance del teclado", async () => {
    const items = [
      { id: "uno", label: "Uno", panel: <p>Panel uno</p> },
      { id: "dos", label: "Dos", panel: <p>Panel dos</p> },
    ];
    const user = userEvent.setup();
    const { rerender } = render(<Tabs label="Partes" idPrefix="prueba" items={items} />);
    await user.click(screen.getByRole("tab", { name: "Dos" }));
    rerender(<Tabs label="Partes" idPrefix="prueba" items={items.slice(0, 1)} />);
    expect(screen.getByRole("tab", { name: "Uno" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Uno" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("Panel uno")).toBeVisible();
  });
});
