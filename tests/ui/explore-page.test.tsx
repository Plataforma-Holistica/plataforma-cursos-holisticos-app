import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { FormHTMLAttributes, Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

// Explorar y buscar (PA-21; T-210), con la guarda y el servicio simulados: qué pinta según lo
// pedido y lo que contesta el servicio, y cuándo el formulario busca solo. Qué cursos cumplen
// qué lo prueban src/services/browse/explore.test.ts y la integración 70.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  explore: vi.fn(),
}));
vi.mock("@/app/_lib/guard", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/services/browse/browse", async (original) => ({
  exploreQueryOf: (await original<typeof import("@/services/browse/explore")>()).exploreQueryOf,
  explore: mocks.explore,
}));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));
// `next/form` necesita el enrutador de la aplicación montado: aquí es un formulario a secas.
vi.mock("next/form", () => ({
  default: (props: FormHTMLAttributes<HTMLFormElement> & { replace?: boolean; scroll?: boolean; ref?: Ref<HTMLFormElement> }) => {
    const native = { ...props };
    delete native.replace;
    delete native.scroll;
    return <form {...native} />;
  },
}));

import ExplorePage from "@/app/explorar/page";

const claims = { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 };
const COURSE = {
  slug: "respirar",
  title: "Respirar para dormir",
  summary: null,
  teacherName: "Ana Robles",
  teacherSlug: "ana-robles",
  practice: { slug: "meditacion", name: "Meditación", tone: 3, position: 1 },
  level: { slug: "principiante", name: "Principiante", position: 1 },
  lessonCount: 12,
  totalSeconds: 3600,
  publishedAt: new Date(0),
  isOpen: false,
};
const FACETS = {
  practices: [{ slug: "meditacion", name: "Meditación" }],
  teachers: [{ slug: "ana-robles", name: "Ana Robles" }],
  levels: [{ slug: "principiante", name: "Principiante" }],
};
const SHELF = {
  starters: [COURSE],
  newest: [COURSE],
  practices: [{ slug: "meditacion", name: "Meditación", tone: 3, courses: [COURSE] }],
  teachers: [],
  practiceOf: new Map(),
};
const NOTHING: { q: string | null; practice: string | null; teacher: string | null; level: string | null } = { q: null, practice: null, teacher: null, level: null };
const ANA = { slug: "ana-robles", name: "Ana Robles", practices: ["Meditación"], tone: 3, courseCount: 1 };
const ready = (query: Partial<typeof NOTHING>, results: { courses: unknown[]; teachers: unknown[] } | null) => ({
  kind: "ready",
  query: { ...NOTHING, ...query },
  facets: FACETS,
  results,
  shelf: SHELF,
});
const params = (search: Record<string, string>) => ({ searchParams: Promise.resolve(search) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ kind: "render", claims });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("explorar (PA-21)", () => {
  it("sin filtro ni búsqueda: un carrusel por práctica, con «Ver todo» a su filtro", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    const { container } = render(await ExplorePage(params({})));
    expect(mocks.requireSession).toHaveBeenCalledExactlyOnceWith("/explorar");
    expect(mocks.explore).toHaveBeenCalledExactlyOnceWith(NOTHING);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Explorar");
    expect(screen.getByRole("search")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Buscar por curso o maestro" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Práctica" })).toHaveValue("");
    expect(screen.getByRole("link", { name: "Ver todo: Meditación" })).toHaveAttribute("href", "/explorar?practica=meditacion");
    expect(screen.queryByRole("status")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Principal" });
    expect(within(nav).getByRole("link", { name: "Explorar" })).toHaveAttribute("aria-current", "page");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con búsqueda y filtro: cuántos, la cuadrícula, los maestros encontrados y cómo quitar cada cosa", async () => {
    mocks.explore.mockResolvedValue(ready({ q: "ana", practice: "meditacion" }, { courses: [COURSE], teachers: [ANA] }));
    const { container } = render(await ExplorePage(params({ q: " ana ", practica: "meditacion", nivel: "NO VALE" })));
    // Lo que se le pide a la guarda y al servicio ya va revisado.
    expect(mocks.requireSession).toHaveBeenCalledExactlyOnceWith("/explorar?practica=meditacion&q=ana");
    expect(mocks.explore).toHaveBeenCalledExactlyOnceWith({ ...NOTHING, q: "ana", practice: "meditacion" });
    expect(screen.getByRole("status")).toHaveTextContent("1 curso");
    const results = screen.getByRole("region", { name: "Resultados" });
    expect(within(results).getByRole("link", { name: /^Respirar para dormir, con Ana Robles/ })).toHaveAttribute("href", "/cursos/respirar");
    expect(screen.getByRole("region", { name: "Maestros" })).toBeVisible();
    expect(screen.getByRole("link", { name: /^Ana Robles, maestro/ })).toHaveAttribute("href", "/maestros/ana-robles");
    expect(screen.getByRole("searchbox")).toHaveValue("ana");
    expect(screen.getByRole("combobox", { name: "Práctica" })).toHaveValue("meditacion");
    expect(screen.getByRole("link", { name: "Quitar filtro: Meditación" })).toHaveAttribute("href", "/explorar?q=ana");
    expect(screen.getByRole("link", { name: "Limpiar filtros" })).toHaveAttribute("href", "/explorar?q=ana");
    expect(screen.getByRole("link", { name: "Borrar la búsqueda" })).toHaveAttribute("href", "/explorar?practica=meditacion");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin resultados: lo dice, ofrece limpiar los filtros y muestra «Nuevos» debajo", async () => {
    mocks.explore.mockResolvedValue(ready({ q: "zz", level: "principiante" }, { courses: [], teachers: [] }));
    render(await ExplorePage(params({ q: "zz", nivel: "principiante" })));
    expect(screen.getByRole("status")).toHaveTextContent("0 cursos");
    expect(screen.getByText("No encontramos cursos con esos filtros.")).toBeVisible();
    const clear = screen.getAllByRole("link", { name: "Limpiar filtros" });
    expect(clear.map((link) => link.getAttribute("href"))).toEqual(["/explorar?q=zz", "/explorar?q=zz"]);
    expect(within(screen.getByRole("region", { name: "Nuevos" })).getByRole("link", { name: /^Respirar para dormir/ })).toBeVisible();
  });

  it("sin resultados de una búsqueda sin filtros: ofrece borrarla", async () => {
    mocks.explore.mockResolvedValue(ready({ q: "zz" }, { courses: [], teachers: [] }));
    render(await ExplorePage(params({ q: "zz" })));
    const region = screen.getByRole("region", { name: "Resultados" });
    expect(within(region).getByRole("link", { name: "Borrar la búsqueda" })).toHaveAttribute("href", "/explorar");
    expect(screen.queryByRole("link", { name: "Limpiar filtros" })).toBeNull();
  });

  it("si no se pudo leer el catálogo, lo dice con «Reintentar» a lo mismo que se pidió", async () => {
    mocks.explore.mockResolvedValue({ kind: "unavailable" });
    render(await ExplorePage(params({ practica: "meditacion" })));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/explorar?practica=meditacion");
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("con la cuenta suspendida o sin saber de la sesión, no se le pregunta al catálogo", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "suspended" });
    render(await ExplorePage(params({})));
    mocks.requireSession.mockResolvedValue({ kind: "unavailable" });
    render(await ExplorePage(params({})));
    expect(mocks.explore).not.toHaveBeenCalled();
  });
});

describe("el formulario de explorar busca solo", () => {
  it("al dejar de escribir 400 ms, una sola vez", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    render(await ExplorePage(params({})));
    vi.useFakeTimers();
    const submit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "res" } });
    act(() => vi.advanceTimersByTime(399));
    fireEvent.change(box, { target: { value: "resp" } });
    act(() => vi.advanceTimersByTime(399));
    expect(submit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
  });

  it("al cambiar un filtro, en el acto", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    render(await ExplorePage(params({})));
    const submit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
    fireEvent.change(screen.getByRole("combobox", { name: "Nivel" }), { target: { value: "principiante" } });
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
  });

  it("los campos vacíos no viajan en la dirección", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    render(await ExplorePage(params({})));
    const form = screen.getByRole("search") as HTMLFormElement;
    let sent: string[] | null = null;
    // Después de React: el envío llega al documento cuando el formulario ya apagó lo vacío.
    const listen = (event: Event) => {
      sent = [...new FormData(form).keys()];
      event.preventDefault();
    };
    document.addEventListener("submit", listen);
    fireEvent.change(screen.getByRole("combobox", { name: "Práctica" }), { target: { value: "meditacion" } });
    document.removeEventListener("submit", listen);
    expect(sent).toEqual(["practica"]);
  });
});
