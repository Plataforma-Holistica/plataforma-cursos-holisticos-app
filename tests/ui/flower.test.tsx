import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { terms } from "@/messages/es/terms";
import { CourseArt } from "@/ui/course-cover";
import { CourseCard } from "@/ui/course-card";
import { Filigree, FlowerMark, Rosette, SeedMark } from "@/ui/flower";
import { FlowerState } from "@/ui/flower-state";
import { FullScreenState } from "@/ui/full-screen-state";
import { MOTIFS, motifFor, placementFor } from "@/ui/motifs";
import { PageHeader } from "@/ui/page-header";
import { Wordmark } from "@/ui/wordmark";

// El sistema visual de T-616 (solicitud 1): la flor de la vida en sus lugares, los motivos de las portadas y
// las piezas que los usan. Todo dibujo es decorativo: lo que dice, lo dice un texto al lado.

describe("la flor de la vida (T-616)", () => {
  it("cada dibujo es decorativo y no recibe el foco", () => {
    for (const element of [<FlowerMark key="m" />, <Rosette key="r" complete />, <Filigree key="f" />, <SeedMark key="s" />]) {
      const { container, unmount } = render(element);
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");
      unmount();
    }
  });

  it("la roseta terminada va en oro, la de a medias en trazo", () => {
    const { container: done } = render(<Rosette complete />);
    expect(done.querySelector("g")).toHaveClass("stroke-accent", "fill-accent-subtle");
    const { container: half } = render(<Rosette complete={false} />);
    expect(half.querySelector("g")).toHaveClass("stroke-text-2");
    expect(half.querySelector("g")).not.toHaveClass("fill-accent-subtle");
  });

  it("la roseta tiene sus seis pétalos y la filigrana sus diecinueve círculos y el que los encierra", () => {
    const { container } = render(<Rosette complete />);
    expect(container.querySelector("path")?.getAttribute("d")?.match(/M0 0/g)).toHaveLength(6);
    const { container: filigree } = render(<Filigree />);
    expect(filigree.querySelectorAll("circle")).toHaveLength(20);
  });

  it("el logotipo con la flor lee solo el nombre y deja el punto", () => {
    const { container } = render(<Wordmark mark />);
    expect(container.textContent).toBe(terms.Plataforma);
    expect(container.querySelector("[data-brand-mark]")).not.toBeNull();
    expect(container.querySelector("[data-brand-dot]")).toBeNull();
  });

  it("un estado con la flor dice su título y lo que pasa; en espera es una región de estado", async () => {
    const { container, rerender } = render(<FlowerState title="Estamos preparando los primeros cursos.">Cuando se publiquen, aparecen aquí.</FlowerState>);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.textContent).toContain("Cuando se publiquen");
    expect(await a11yViolations(container)).toEqual([]);
    rerender(<FlowerState waiting title="Preparando tu video" />);
    expect(screen.getByRole("status")).toHaveTextContent("Preparando tu video");
  });

  it("un estado de pantalla completa sin icono lleva la semilla", () => {
    const { container } = render(
      <FullScreenState title="No encontramos esa página" primaryAction={<button type="button">Ir al inicio</button>} focusTitle={false}>
        <p>Puede que la dirección esté mal.</p>
      </FullScreenState>,
    );
    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });
});

describe("la cabecera de pantalla (T-616)", () => {
  it("el título es el h1, el antetítulo va en oro pleno y la filigrana es decorativa", async () => {
    const { container } = render(<PageHeader eyebrow="Portal del maestro" title="Mis cursos" lead="Lo que enviaste y lo que falta." />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Mis cursos");
    expect(screen.getByText("Portal del maestro")).toHaveClass("eyebrow", "text-accent");
    expect(container.querySelector("[data-page-header] svg")).toHaveAttribute("aria-hidden", "true");
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("los motivos de las portadas (T-616)", () => {
  it("son ocho, y ocho prácticas seguidas en el catálogo no repiten ninguno", () => {
    expect(Object.keys(MOTIFS)).toHaveLength(8);
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map((position) => motifFor(position))).size).toBe(8);
  });

  it("la misma práctica y el mismo curso dan siempre el mismo dibujo, y dos cursos casi siempre otro lugar", () => {
    expect(motifFor("respiracion")).toBe(motifFor("respiracion"));
    expect(placementFor("/cursos/uno")).toEqual(placementFor("/cursos/uno"));
    const places = new Set(Array.from({ length: 12 }, (_, index) => JSON.stringify(placementFor(`/cursos/curso-${index}`))));
    expect(places.size).toBeGreaterThan(9);
  });

  it("la portada lleva el motivo y el título, y queda fuera del árbol de accesibilidad", () => {
    const { container } = render(<CourseArt title="Respirar para dormir" practiceName="Respiración" practiceKey={0} tone={4} seed="/cursos/respirar" />);
    const art = container.firstElementChild;
    expect(art).toHaveAttribute("aria-hidden", "true");
    expect(art?.querySelector("svg path")?.getAttribute("d")).toBe(MOTIFS[motifFor(0)]);
    expect(art).toHaveTextContent("Respirar para dormir");
  });

  it("con algo en la esquina, la práctica le deja su lugar y se corta antes que tocarlo", () => {
    const { container } = render(<CourseArt practiceName="Respiración" tone={4} corner />);
    expect(container.querySelector("p")).toHaveClass("truncate", "pr-12");
  });
});

describe("la tarjeta de curso como cartel (T-616)", () => {
  const course = { href: "/cursos/respirar", title: "Respirar para dormir", teacherName: "Ana Robles", practice: { name: "Respiración", tone: 4, position: 0 }, levelName: "Inicial", lessonCount: 6 };

  it("es un solo enlace con el título y el maestro en su nombre; lo de la esquina va fuera de él", async () => {
    const { container } = render(<CourseCard {...course} corner={<button type="button">Guardar en mi lista: Respirar para dormir</button>} />);
    const link = screen.getByRole("link", { name: "Respirar para dormir, con Ana Robles" });
    expect(link).toHaveAttribute("href", "/cursos/respirar");
    expect(link.querySelector("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Guardar en mi lista: Respirar para dormir" })).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con avance, la roseta y la barra; terminado, la roseta en oro", () => {
    const { container, rerender } = render(<CourseCard {...course} progress={{ completed: 2, total: 6, lessonNumber: 3 }} />);
    expect(container.querySelector("progress")).toHaveAttribute("value", "2");
    expect(container.querySelector("svg g.stroke-text-2")).not.toBeNull();
    rerender(<CourseCard {...course} progress={{ completed: 6, total: 6, lessonNumber: 6 }} />);
    expect(container.querySelector("svg g.stroke-accent")).not.toBeNull();
  });
});
