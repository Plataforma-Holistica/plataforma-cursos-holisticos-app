import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { landing } from "@/messages/es/landing";
import { terms } from "@/messages/es/terms";
import type { HomeShelf, ShelfCourse } from "@/services/browse/browse";

// La portada pública (PA-01; T-614, parte 2), con la guarda y el catálogo simulados: qué pinta para
// el visitante con cada respuesta. Quien tiene sesión no la ve: `visitorOnly` lo manda a su inicio, y
// esa tabla está en src/app/_lib/guard-steps.test.ts; aquí se cuida que la portada la llame primero.

const mocks = vi.hoisted(() => ({ visitorOnly: vi.fn(), homeShelf: vi.fn() }));
vi.mock("@/app/_lib/guard", () => ({ visitorOnly: mocks.visitorOnly }));
vi.mock("@/services/browse/browse", () => ({ homeShelf: mocks.homeShelf }));

import LandingPage from "@/app/page";

const MEDITATION = { slug: "meditacion", name: "Meditación", tone: 3, position: 1 };

function course(slug: string, extra: Partial<ShelfCourse> = {}): ShelfCourse {
  return {
    slug,
    title: `Curso ${slug}`,
    summary: null,
    teacherName: "Ana Robles",
    teacherSlug: "ana-robles",
    practice: MEDITATION,
    level: null,
    lessonCount: 3,
    totalSeconds: 900,
    publishedAt: new Date(Date.UTC(2026, 9, 1)),
    isOpen: false,
    ...extra,
  };
}

function shelf(courses: ShelfCourse[], open: ShelfCourse | null = null): HomeShelf {
  return {
    starters: [],
    newest: courses,
    practices: [],
    teachers: courses.length === 0 ? [] : [{ slug: "ana-robles", name: "Ana Robles", practices: ["Meditación"], tone: 3, courseCount: courses.length }],
    practiceOf: new Map(),
    open,
  };
}

async function renderPage() {
  const { container } = render(await LandingPage());
  return container;
}

beforeEach(() => {
  mocks.visitorOnly.mockReset().mockResolvedValue(undefined);
  mocks.homeShelf.mockReset().mockResolvedValue({ kind: "ready", shelf: shelf([course("respirar"), course("soltar")]) });
});

describe("la portada (PA-01)", () => {
  it("pasa por la guarda del visitante antes de leer el catálogo", async () => {
    const order: string[] = [];
    mocks.visitorOnly.mockImplementation(() => {
      order.push("guarda");
      return Promise.resolve();
    });
    mocks.homeShelf.mockImplementation(() => {
      order.push("catálogo");
      return Promise.resolve({ kind: "ready", shelf: shelf([]) });
    });
    await renderPage();
    expect(order).toEqual(["guarda", "catálogo"]);
  });

  it("el titular, la frase y «Crear cuenta», que lleva al registro", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: landing.hero.title })).toBeInTheDocument();
    expect(screen.getByText(landing.hero.lead)).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: landing.hero.signUp })).toHaveAttribute("href", "/registro");
  });

  it("la foto del encabezado es decorativa y carga primero", async () => {
    const container = await renderPage();
    const photo = container.querySelector("main img");
    expect(photo).toHaveAttribute("alt", "");
    expect(photo).toHaveAttribute("fetchpriority", "high");
    expect(photo).toHaveAttribute("loading", "eager");
    expect(photo).toHaveAttribute("sizes", "100vw");
  });

  it("la barra lleva el logotipo a la portada, «Entrar» y «Crear cuenta»", async () => {
    await renderPage();
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("link", { name: terms.Plataforma })).toHaveAttribute("href", "/");
    expect(within(bar).getByRole("link", { name: landing.header.signIn })).toHaveAttribute("href", "/entrar");
    expect(within(bar).getByRole("link", { name: landing.header.signUp })).toHaveAttribute("href", "/registro");
    expect(within(bar).getByRole("navigation", { name: landing.header.label })).toBeInTheDocument();
  });

  it("la barra va transparente sobre la foto y sólida al desplazar la página", async () => {
    await renderPage();
    const bar = screen.getByRole("banner");
    expect(bar).toHaveAttribute("data-solid", "false");
    act(() => {
      Object.defineProperty(window, "scrollY", { value: 120, configurable: true });
      fireEvent.scroll(window);
    });
    expect(bar).toHaveAttribute("data-solid", "true");
    act(() => {
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
      fireEvent.scroll(window);
    });
    expect(bar).toHaveAttribute("data-solid", "false");
  });

  it("una muestra del catálogo y quienes enseñan, con sus fichas", async () => {
    await renderPage();
    const sample = screen.getByRole("region", { name: landing.sample.title });
    expect(within(sample).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/cursos/respirar", "/cursos/soltar"]);
    const teachers = screen.getByRole("region", { name: landing.teachers.title });
    expect(within(teachers).getByRole("link")).toHaveAttribute("href", "/maestros/ana-robles");
  });

  it("«Cómo funciona», en tres puntos y sin cifras de dinero", async () => {
    await renderPage();
    const how = screen.getByRole("region", { name: landing.how.title });
    expect(within(how).getAllByRole("listitem")).toHaveLength(3);
    expect(how.textContent).not.toMatch(/\$|MXN|\d/);
  });

  it("con curso abierto, el enlace del encabezado y su bloque llevan a su ficha", async () => {
    const open = course("abierto", { isOpen: true, title: "Respirar sin prisa" });
    mocks.homeShelf.mockResolvedValue({ kind: "ready", shelf: shelf([course("respirar")], open) });
    await renderPage();
    expect(screen.getByRole("link", { name: landing.hero.openCourse })).toHaveAttribute("href", "/cursos/abierto");
    const block = screen.getByRole("region", { name: landing.openCourse.label });
    // El título va escrito y en la portada generada, que es decorativa.
    expect(within(block).getAllByText("Respirar sin prisa").some((node) => node.closest("[aria-hidden]") === null)).toBe(true);
    expect(within(block).getByRole("link", { name: landing.openCourse.action })).toHaveAttribute("href", "/cursos/abierto");
  });

  it("sin curso abierto, ni el encabezado ni otro bloque lo mencionan", async () => {
    await renderPage();
    expect(screen.queryByRole("link", { name: landing.hero.openCourse })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: landing.openCourse.label })).not.toBeInTheDocument();
  });

  it("con el catálogo vacío lo dice, sin filas", async () => {
    mocks.homeShelf.mockResolvedValue({ kind: "ready", shelf: shelf([]) });
    await renderPage();
    expect(screen.getByText(landing.empty)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: landing.sample.title })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: landing.teachers.title })).not.toBeInTheDocument();
  });

  it("si el catálogo no se pudo leer, el encabezado sigue y se dice", async () => {
    mocks.homeShelf.mockResolvedValue({ kind: "unavailable" });
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: landing.hero.title })).toBeInTheDocument();
    expect(screen.getByText(landing.unavailable)).toBeInTheDocument();
    expect(screen.queryByText(landing.empty)).not.toBeInTheDocument();
  });

  it("el pie lleva los textos legales que existen y el deslinde", async () => {
    await renderPage();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: landing.footer.terms })).toHaveAttribute("href", "/legal/terminos");
    expect(within(footer).getByRole("link", { name: landing.footer.privacy })).toHaveAttribute("href", "/legal/privacidad");
    expect(footer.textContent).toContain("es educativa");
  });

  it("pasa las reglas automáticas de accesibilidad", async () => {
    const open = course("abierto", { isOpen: true });
    mocks.homeShelf.mockResolvedValue({ kind: "ready", shelf: shelf([course("respirar")], open) });
    const container = await renderPage();
    expect(await a11yViolations(container)).toEqual([]);
  });
});
