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
    // La región que dice cuántos existe desde antes de la primera búsqueda, vacía.
    expect(screen.getByRole("status")).toHaveTextContent(/^$/);
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

describe("explorar sin cursos", () => {
  it("lo dice, como el inicio", async () => {
    mocks.explore.mockResolvedValue({ ...ready({}, null), facets: { practices: [], teachers: [], levels: [] }, shelf: { ...SHELF, practices: [], newest: [] } });
    render(await ExplorePage(params({})));
    expect(screen.getByText("Estamos preparando los primeros cursos.")).toBeVisible();
  });
});

describe("el formulario de explorar busca solo", () => {
  /** Lo que el formulario manda, leído después de React y sin navegar. */
  function capture(): { sent: () => string[] | null; disabled: () => number; stop: () => void } {
    let sent: string[] | null = null;
    let disabled = 0;
    const listen = (event: Event) => {
      const form = event.target as HTMLFormElement;
      sent = [...new FormData(form).keys()];
      // Un campo apagado pierde el foco en un navegador (jsdom no lo hace): ninguno se apaga.
      disabled = [...form.elements].filter((element) => (element as HTMLInputElement).disabled).length;
      event.preventDefault();
    };
    document.addEventListener("submit", listen);
    return { sent: () => sent, disabled: () => disabled, stop: () => document.removeEventListener("submit", listen) };
  }

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

  it("no busca lo que ya se está mostrando", async () => {
    mocks.explore.mockResolvedValue(ready({ q: "ana" }, { courses: [COURSE], teachers: [] }));
    render(await ExplorePage(params({ q: "ana" })));
    vi.useFakeTimers();
    const submit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: " ana  " } });
    act(() => vi.advanceTimersByTime(400));
    expect(submit).not.toHaveBeenCalled();
    submit.mockRestore();
  });

  it("al salir del buscador con un envío pendiente, sale ya: el enlace que se pulse después manda", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    render(await ExplorePage(params({})));
    vi.useFakeTimers();
    const submit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
    const box = screen.getByRole("searchbox");
    box.focus();
    fireEvent.change(box, { target: { value: "resp" } });
    act(() => box.blur());
    expect(submit).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(400));
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
  });

  it("al cambiar un filtro, con la misma pausa (las flechas sobre la lista cerrada cambian con cada tecla)", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    render(await ExplorePage(params({})));
    vi.useFakeTimers();
    const submit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
    fireEvent.change(screen.getByRole("combobox", { name: "Nivel" }), { target: { value: "principiante" } });
    expect(submit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
  });

  it("los campos vacíos no viajan en la dirección, y los filtros fuera del buscador sí viajan", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    render(await ExplorePage(params({})));
    vi.useFakeTimers();
    const form = capture();
    fireEvent.change(screen.getByRole("combobox", { name: "Práctica" }), { target: { value: "meditacion" } });
    act(() => vi.advanceTimersByTime(400));
    form.stop();
    expect(form.sent()).toEqual(["practica"]);
  });

  it("borrar la búsqueda no le quita el foco al buscador, y vuelve a tener su nombre", async () => {
    mocks.explore.mockResolvedValue(ready({ q: "ana" }, { courses: [COURSE], teachers: [] }));
    render(await ExplorePage(params({ q: "ana" })));
    vi.useFakeTimers();
    const form = capture();
    const box = screen.getByRole("searchbox");
    box.focus();
    fireEvent.change(box, { target: { value: "" } });
    act(() => vi.advanceTimersByTime(400));
    form.stop();
    expect(form.sent()).toEqual([]);
    expect(form.disabled()).toBe(0);
    expect(box).toHaveFocus();
    act(() => vi.advanceTimersByTime(1));
    expect(box).toHaveAttribute("name", "q");
  });

  it("si lo pulsado se fue con la respuesta (quitar un filtro), el foco lo toma el buscador; al cargar, no", async () => {
    mocks.explore.mockResolvedValue(ready({ practice: "meditacion" }, { courses: [COURSE], teachers: [] }));
    const { rerender } = render(await ExplorePage(params({ practica: "meditacion" })));
    expect(screen.getByRole("searchbox")).not.toHaveFocus();
    const chip = screen.getByRole("link", { name: "Quitar filtro: Meditación" });
    chip.focus();
    mocks.explore.mockResolvedValue(ready({}, null));
    rerender(await ExplorePage(params({})));
    expect(screen.queryByRole("link", { name: "Quitar filtro: Meditación" })).toBeNull();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "Práctica" })).toHaveValue("");
  });
});
