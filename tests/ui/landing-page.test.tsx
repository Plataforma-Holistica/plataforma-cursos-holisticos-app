import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { landing } from "@/messages/es/landing";
import { terms } from "@/messages/es/terms";
import type { HomeShelf, ShelfCourse } from "@/services/browse/browse";

// La portada pública (PA-01; T-614, parte 2), con la guarda y el catálogo simulados: qué pinta para
// el visitante con cada respuesta. Quien tiene sesión no la ve: `visitorOnly` lo manda a su inicio, y
// esa tabla está en src/app/_lib/guard-steps.test.ts; aquí se cuida que la portada la llame primero.

const mocks = vi.hoisted(() => ({ visitorOnly: vi.fn(), homeShelf: vi.fn(), planShowcase: vi.fn() }));
vi.mock("@/app/_lib/guard", () => ({ visitorOnly: mocks.visitorOnly }));
vi.mock("@/services/browse/browse", () => ({ homeShelf: mocks.homeShelf }));
// Los precios de la portada (T-616, solicitud 4b): la vitrina, con su memoria; nunca la oferta fresca de /planes.
vi.mock("@/services/billing/showcase-service", () => ({ planShowcase: mocks.planShowcase }));

const ON_SALE = {
  kind: "ready",
  plans: [
    { plan: "monthly", amountCents: 34900 },
    { plan: "annual", amountCents: 299000 },
  ],
  recurringVersion: 1,
};

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
    teachers: courses.length === 0 ? [] : [{ slug: "ana-robles", name: "Ana Robles", practices: ["Meditación"], tone: 3, practicePosition: 1, courseCount: courses.length }],
    practiceOf: new Map(),
    open,
  };
}

async function renderPage() {
  const { container } = render(await LandingPage());
  return container;
}

afterEach(() => {
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

beforeEach(() => {
  mocks.visitorOnly.mockReset().mockResolvedValue(undefined);
  mocks.homeShelf.mockReset().mockResolvedValue({ kind: "ready", shelf: shelf([course("respirar"), course("soltar")]) });
  mocks.planShowcase.mockReset().mockResolvedValue(ON_SALE);
});

describe("la portada (PA-01)", () => {
  it("pasa por la guarda del visitante antes de leer el catálogo y los precios, que se leen a la par", async () => {
    const order: string[] = [];
    mocks.visitorOnly.mockImplementation(() => {
      order.push("guarda");
      return Promise.resolve();
    });
    let finishShelf!: () => void;
    mocks.homeShelf.mockImplementation(() => {
      order.push("catálogo");
      return new Promise((resolve) => (finishShelf = () => resolve({ kind: "ready", shelf: shelf([]) })));
    });
    mocks.planShowcase.mockImplementation(() => {
      order.push("precios");
      return Promise.resolve(ON_SALE);
    });
    const page = renderPage();
    // Los precios se pidieron sin esperar a que el catálogo terminara.
    await vi.waitFor(() => expect(order).toEqual(["guarda", "catálogo", "precios"]), { timeout: 3_000 });
    finishShelf();
    await page;
  });

  it("el titular, la frase y «Suscribirme», que lleva a los planes", async () => {
    // Cambió por el requisito (decisión de Sergio del 2026-11-12; PA-01 del 03): con planes a la venta, el botón principal es
    // «Suscribirme». Antes era «Crear cuenta» al registro, que sigue en la barra.
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: landing.hero.title })).toBeInTheDocument();
    expect(screen.getByText(landing.hero.lead)).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: landing.hero.subscribe })).toHaveAttribute("href", "/planes");
    expect(within(main).queryByRole("link", { name: landing.hero.signUp })).toBeNull();
  });

  it("sin planes a la venta, el encabezado sigue con «Crear cuenta»: «Suscribirme» llevaría a una página que no vende", async () => {
    mocks.planShowcase.mockResolvedValue({ ...ON_SALE, plans: [] });
    await renderPage();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: landing.hero.signUp })).toHaveAttribute("href", "/registro");
    expect(within(main).queryByRole("link", { name: landing.hero.subscribe })).toBeNull();
  });

  it("los planes, después de «Cómo funciona»: cada total con «IVA incluido», el equivalente solo en el anual, y a elegirlos en /planes", async () => {
    await renderPage();
    const section = screen.getByRole("region", { name: landing.plans.title });
    const how = screen.getByRole("region", { name: landing.how.title });
    expect(how.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(section).getByText("$349.00 al mes")).toBeInTheDocument();
    expect(within(section).getByText("$2,990.00 al año")).toBeInTheDocument();
    expect(within(section).getAllByText(/IVA incluido/)).toHaveLength(2);
    // Hacia arriba: 2 990 entre 12 son 249.1666…
    expect(within(section).getByText("Equivale a $249.17 al mes.")).toBeInTheDocument();
    expect(within(section).getAllByText(/Equivale a/)).toHaveLength(1);
    expect(within(section).getByRole("link", { name: "Elegir el plan Mensual" })).toHaveAttribute("href", "/planes?plan=monthly#bloque-pagar");
    expect(within(section).getByRole("link", { name: "Elegir el plan Anual" })).toHaveAttribute("href", "/planes?plan=annual#bloque-pagar");
    expect(within(section).getByRole("list", { name: "Cualquier plan incluye:" })).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: landing.plans.seeAll })).toHaveAttribute("href", "/planes");
  });

  it("con un solo plan a la venta, una tarjeta", async () => {
    mocks.planShowcase.mockResolvedValue({ ...ON_SALE, plans: [{ plan: "monthly", amountCents: 34900 }] });
    await renderPage();
    const section = screen.getByRole("region", { name: landing.plans.title });
    expect(within(section).getAllByRole("link", { name: /^Elegir el plan/ })).toHaveLength(1);
    expect(within(section).queryByText(/Equivale a/)).toBeNull();
  });

  it("sin planes a la venta (con el criterio de /planes), la sección no aparece", async () => {
    for (const showcase of [
      { ...ON_SALE, plans: [] },
      { ...ON_SALE, recurringVersion: null },
    ]) {
      mocks.planShowcase.mockResolvedValue(showcase);
      const { unmount } = render(await LandingPage());
      expect(screen.queryByRole("region", { name: landing.plans.title })).toBeNull();
      expect(screen.getByRole("main").textContent).not.toMatch(/\$/);
      unmount();
    }
  });

  it("si los precios no se pudieron leer, la sección va sin cifras: lo que incluye y «Ver planes»", async () => {
    mocks.planShowcase.mockResolvedValue({ kind: "unavailable" });
    await renderPage();
    const section = screen.getByRole("region", { name: landing.plans.title });
    expect(section.textContent).not.toMatch(/\$|MXN|\d/);
    expect(within(section).getByRole("list", { name: "Cualquier plan incluye:" })).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: landing.plans.seeAll })).toHaveAttribute("href", "/planes");
    // Sin saber si hay venta, el encabezado no promete «Suscribirme».
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: landing.hero.signUp })).toHaveAttribute("href", "/registro");
    expect(within(main).queryByRole("link", { name: landing.hero.subscribe })).toBeNull();
  });

  it("la foto del encabezado es decorativa y carga primero", async () => {
    const container = await renderPage();
    const photo = container.querySelector("main img");
    expect(photo).toHaveAttribute("alt", "");
    expect(photo).toHaveAttribute("fetchpriority", "high");
    expect(photo).toHaveAttribute("loading", "eager");
    expect(photo).toHaveAttribute("sizes", "100vw");
  });

  it("la barra lleva el logotipo a la portada, «Planes», «Entrar» y «Crear cuenta»", async () => {
    await renderPage();
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("link", { name: terms.Plataforma })).toHaveAttribute("href", "/");
    // Los planes antes de crear cuenta (pedido de Sergio del 2026-11-11). En el teléfono no caben con el
    // logotipo y «Crear cuenta»: van en el pie, como «Entrar».
    const plans = within(bar).getByRole("link", { name: landing.header.plans });
    expect(plans).toHaveAttribute("href", "/planes");
    expect(plans.closest("li")).toHaveClass("hidden", "sm:block");
    expect(plans).not.toHaveAttribute("aria-current");
    expect(within(bar).getByRole("link", { name: landing.header.signIn })).toHaveAttribute("href", "/entrar");
    expect(within(bar).getByRole("link", { name: landing.header.signUp })).toHaveAttribute("href", "/registro");
    expect(within(bar).getByRole("navigation", { name: landing.header.label })).toBeInTheDocument();
  });

  it("los enlaces sueltos de la barra y del pie miden lo que pide el toque", async () => {
    await renderPage();
    const bar = screen.getByRole("banner");
    for (const link of within(bar).getAllByRole("link")) expect(link).toHaveClass("min-h-touch");
    for (const link of within(screen.getByRole("contentinfo")).getAllByRole("link")) expect(link).toHaveClass("min-h-touch");
  });

  it("la barra va transparente sobre la foto y sólida al desplazar la página", async () => {
    await renderPage();
    const bar = screen.getByRole("banner");
    expect(bar).toHaveAttribute("data-solid", "false");
    // Sin fijar arriba: sin JavaScript se va con la página y nunca tapa el contenido sin su fondo.
    expect(bar).toHaveClass("absolute", "bg-transparent");
    expect(bar).not.toHaveClass("fixed");
    act(() => {
      Object.defineProperty(window, "scrollY", { value: 120, configurable: true });
      fireEvent.scroll(window);
    });
    expect(bar).toHaveAttribute("data-solid", "true");
    expect(bar).toHaveClass("fixed", "bg-surface-1");
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

  it("las cifras de dinero solo van en la sección de los planes", async () => {
    // Cambió por el requisito (decisiones de Sergio del 2026-11-11 y 12, RF-201): los precios entran a la portada, en su sección.
    const open = course("abierto", { isOpen: true });
    mocks.homeShelf.mockResolvedValue({ kind: "ready", shelf: shelf([course("respirar")], open) });
    const container = await renderPage();
    const section = screen.getByRole("region", { name: landing.plans.title });
    const outside = (container.textContent ?? "").replace(section.textContent ?? "", "");
    expect(outside).not.toMatch(/\$|MXN|precio/i);
  });

  it("la cabecera lleva la flor grande, decorativa, sobre el titular", async () => {
    await renderPage();
    const heading = screen.getByRole("heading", { level: 1 });
    const flower = within(screen.getByRole("main")).getByTestId("portada-flor");
    expect(flower).toHaveAttribute("aria-hidden", "true");
    expect(flower.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(within(footer).getByRole("link", { name: landing.footer.plans })).toHaveAttribute("href", "/planes");
    expect(footer.textContent).toContain("es educativa");
  });

  it("pasa las reglas automáticas de accesibilidad", async () => {
    const open = course("abierto", { isOpen: true });
    mocks.homeShelf.mockResolvedValue({ kind: "ready", shelf: shelf([course("respirar")], open) });
    const container = await renderPage();
    expect(await a11yViolations(container)).toEqual([]);
  });
});
