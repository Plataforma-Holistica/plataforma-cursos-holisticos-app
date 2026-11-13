import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
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
import { TeacherCard } from "@/ui/teacher-card";
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

  it("el logotipo lleva siempre la flor y lee solo el nombre", () => {
    const { container } = render(<Wordmark />);
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

  // T-616, 3b-1: el título puede ser un encabezado (PA-33 en la lección, PA-32), y la semilla de espera ya no obliga a una
  // región viva: dentro de una que ya existe (PA-32) no se anidan dos.
  it("el título va como párrafo por omisión, o como el encabezado que se pida", () => {
    const { rerender } = render(<FlowerState title="Esta lección pide una suscripción" />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Esta lección pide una suscripción").tagName).toBe("P");
    rerender(<FlowerState titleLevel={2} title="Esta lección pide una suscripción" />);
    expect(screen.getByRole("heading", { level: 2, name: "Esta lección pide una suscripción" })).toBeInTheDocument();
    rerender(<FlowerState titleLevel={1} title="Confirmando tu pago" />);
    expect(screen.getByRole("heading", { level: 1, name: "Confirmando tu pago" })).toBeInTheDocument();
  });

  it("la semilla de espera va con su región viva por omisión, o sin ella si ya hay una alrededor", () => {
    const { container, rerender } = render(<FlowerState waiting title="Preparando tu video" />);
    const waitingSeed = container.querySelector("svg")?.innerHTML;
    expect(screen.getByRole("status")).toHaveTextContent("Preparando tu video");
    rerender(<FlowerState waiting live={false} title="Preparando tu video" />);
    expect(screen.queryByRole("status")).toBeNull();
    // La semilla es la de espera también sin la región.
    expect(container.querySelector("svg")?.innerHTML).toBe(waitingSeed);
    rerender(<FlowerState title="Preparando tu video" />);
    expect(container.querySelector("svg")?.innerHTML).not.toBe(waitingSeed);
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

  // T-616, 3b-3: «Mis comentarios» lleva el foco al título después de borrar, y su título es el de la cabecera.
  it("con `titleRef`, la referencia llega al h1, que toma el foco por programa sin contorno; sin ella, el h1 no se enfoca", () => {
    const ref = createRef<HTMLHeadingElement>();
    const { unmount } = render(<PageHeader title="Mis comentarios" titleRef={ref} />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(ref.current).toBe(heading);
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveClass("outline-none");
    act(() => ref.current?.focus());
    expect(heading).toHaveFocus();
    unmount();
    render(<PageHeader title="Cuenta" />);
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveAttribute("tabindex");
  });

  it("lo de arriba (`above`, un «Volver a…») va dentro de la cabecera, antes del antetítulo y del título", () => {
    const { container } = render(<PageHeader above={<a href="/cuenta">Volver a Cuenta</a>} eyebrow="Cuenta" title="Mis comentarios" />);
    const header = container.querySelector("[data-page-header]");
    const back = screen.getByRole("link", { name: "Volver a Cuenta" });
    expect(header).toContainElement(back);
    const eyebrow = screen.getByText("Cuenta");
    expect(back.compareDocumentPosition(eyebrow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(eyebrow.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  const course = { href: "/cursos/respirar", courseKey: "respirar-para-dormir", title: "Respirar para dormir", teacherName: "Ana Robles", practice: { name: "Respiración", tone: 4, position: 0 }, levelName: "Inicial", lessonCount: 6 };

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

  it("con avance y con algo en la esquina a la vez, no se enciman: la roseta va abajo, junto a la lección", () => {
    const { container } = render(
      <CourseCard {...course} progress={{ completed: 2, total: 6, lessonNumber: 3 }} corner={<button type="button">Guardar en mi lista: Respirar para dormir</button>} />,
    );
    const rosette = container.querySelector("svg g.stroke-text-2")?.closest("span");
    // La roseta va en la línea de abajo, fuera de la portada; la esquina de arriba queda para el botón.
    expect(rosette).toHaveTextContent("Lección 3 de 6");
    expect(container.querySelector("[aria-hidden='true'].overflow-hidden svg g.stroke-text-2")).toBeNull();
    expect(screen.getByRole("button", { name: "Guardar en mi lista: Respirar para dormir" }).parentElement).toHaveClass("top-2", "right-2");
  });

  it("el mismo curso se ve igual con dos enlaces distintos: la portada se siembra con el curso, no con el enlace", () => {
    const portrait = (href: string) => {
      const { container, unmount } = render(<CourseCard {...course} href={href} />);
      const art = container.querySelector("[aria-hidden='true'] > div");
      const look = { classes: art?.className, motif: art?.querySelector("svg path")?.getAttribute("transform") };
      unmount();
      return look;
    };
    expect(portrait("/cursos/respirar-para-dormir")).toEqual(portrait("/cursos/respirar-para-dormir/lecciones/123"));
  });

  it("dos cursos con el mismo título y distinto curso no comparten portada", () => {
    const look = (courseKey: string) => {
      const { container, unmount } = render(<CourseCard {...course} courseKey={courseKey} />);
      const art = container.querySelector("[aria-hidden='true'] > div");
      const found = { classes: art?.className, motif: art?.querySelector("svg path")?.getAttribute("transform") };
      unmount();
      return found;
    };
    // Mismo título, misma práctica: lo que cambia (el foco o la colocación del motivo) sale del curso.
    expect(look("respirar-para-dormir")).not.toEqual(look("respirar-para-dormir-2"));
  });

  it("el aviso de curso abierto va en el flujo, bajo la práctica, y no encima del título", () => {
    render(<CourseCard {...course} isOpen />);
    const label = screen.getByText("Curso abierto");
    expect(label).not.toHaveClass("absolute");
    expect(label.parentElement?.textContent).toContain("Respiración");
  });

  // La práctica ya va arriba en el cartel: la línea de datos no la repite (T-616, solicitud 3; nota del carril A).
  it("la línea de datos lleva el nivel y las lecciones, sin repetir la práctica del cartel", () => {
    const { container } = render(<CourseCard {...course} />);
    const meta = [...container.querySelectorAll("a > span[aria-hidden='true'] span")].map((span) => span.textContent);
    expect(meta).toContain("Inicial · 6 lecciones");
    expect(meta.some((line) => line?.includes("Respiración"))).toBe(false);
    expect(screen.getByText("Respiración")).toBeInTheDocument();
  });

  it("sin título, el motivo grande ocupa la portada entera", () => {
    const { container } = render(<CourseArt practiceName={null} practiceKey={2} tone={3} seed="respirar" shape="wide" largeMotif />);
    expect(container.querySelector("svg")).toHaveClass("inset-0", "h-full");
    expect(container.querySelector("p")).toBeNull();
  });

  it("la portada ancha es 16:9 y la vertical 4:5", () => {
    const { container: wide } = render(<CourseCard {...course} shape="wide" />);
    expect(wide.querySelector(".aspect-video")).not.toBeNull();
    const { container: tall } = render(<CourseCard {...course} />);
    expect(tall.querySelector(".aspect-4\\/5")).not.toBeNull();
  });

  it("una palabra larga baja el título de tamaño y se corta con guion; un título de palabras cortas no se corta", () => {
    const { container } = render(<CourseArt title="Autoconocimiento transgeneracional" practiceName={null} tone={3} />);
    const title = container.querySelector("p.display-narrow");
    expect(title).toHaveClass("text-poster-s", "hyphens-auto");
    const { container: short } = render(<CourseArt title="Yoga suave" practiceName={null} tone={1} />);
    expect(short.querySelector("p.display-narrow")).toHaveClass("text-poster-l");
    expect(short.querySelector("p.display-narrow")).not.toHaveClass("hyphens-auto");
  });
});

describe("el logotipo y los retratos (T-616)", () => {
  it("la flor del logotipo lleva el oro del acento en su roseta y el segundo tono alrededor", () => {
    const { container } = render(<FlowerMark />);
    expect(container.querySelector("g.stroke-accent")).not.toBeNull();
    expect(container.querySelector("g.stroke-text-2")).not.toBeNull();
  });

  it("el retrato redondo es un solo enlace con el nombre y sus prácticas, y su anillo deja un hueco sin color propio", async () => {
    const { container } = render(
      <TeacherCard href="/maestros/ana-robles" name="Ana Robles" practices={["Respiración", "Yoga"]} tone={4} practicePosition={null} shape="round" />,
    );
    expect(screen.getByRole("link", { name: /^Ana Robles, .+ de Respiración, Yoga$/ })).toHaveAttribute("href", "/maestros/ana-robles");
    const ring = container.querySelector(".ring-1");
    expect(ring).toHaveClass("rounded-full", "p-1");
    expect(ring?.className).not.toMatch(/ring-offset/);
    expect(await a11yViolations(container)).toEqual([]);
  });

  // «Por maestro» del inicio, sin caja y en la rejilla, con retratos de 120 px (T-616, solicitud 3): un solo tamaño, sin escalón por ancho.
  it("el retrato redondo mide 120 px en todo ancho, y su foto se pide a ese ancho", () => {
    const { container } = render(<TeacherCard href="/maestros/ana" name="Ana" practices={["Yoga"]} tone={4} practicePosition={1} shape="round" />);
    const portrait = container.querySelector(".ring-1 > span");
    expect(portrait).toHaveClass("size-30");
    expect(portrait?.className).not.toMatch(/sm:size-/);
    expect(container.querySelector("img")).toHaveAttribute("sizes", "120px");
  });
});
