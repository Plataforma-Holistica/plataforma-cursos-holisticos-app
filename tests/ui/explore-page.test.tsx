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
  myList: vi.fn(),
}));
// La barra del alumno (T-616): sin accesos por rol ni correo, salvo que la prueba diga otra cosa.
vi.mock("@/app/_catalog/nav-facts", () => ({ studentNavFor: () => Promise.resolve({ access: { admin: false, portal: false }, email: null }) }));
vi.mock("@/app/_lib/guard", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/services/browse/browse", async (original) => ({
  exploreQueryOf: (await original<typeof import("@/services/browse/explore")>()).exploreQueryOf,
  explore: mocks.explore,
  myList: mocks.myList,
}));
vi.mock("@/app/_catalog/my-list/actions", () => ({ exploreListAction: vi.fn() }));
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
  open: null,
};
const NOTHING: { q: string | null; practice: string | null; teacher: string | null; level: string | null } = { q: null, practice: null, teacher: null, level: null };
const ANA = { slug: "ana-robles", name: "Ana Robles", practices: ["Meditación"], tone: 3, practicePosition: 1, courseCount: 1 };
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
  // Sin la lista, las tarjetas van sin botón: las pruebas de Mi lista la dan aparte.
  mocks.myList.mockResolvedValue({ kind: "unavailable" });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Las fichas de práctica: enlaces, no un campo (T-616, solicitud 3). */
const practiceChips = () => screen.getByRole("navigation", { name: "Práctica" });
/** La práctica elegida viaja con la búsqueda en un campo oculto. */
const chosenPractice = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[type="hidden"][name="practica"]');

describe("explorar (PA-21)", () => {
  // Desde T-616 (solicitud 3): la cabecera de la casa con su foto, las prácticas como fichas (antes, un selector) y, sin
  // filtro, una sola rejilla ordenada por práctica (antes, un carrusel por práctica con «Ver todo»).
  it("sin filtro ni búsqueda: la cabecera, las fichas de práctica con «Todas» elegida y una sola rejilla", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    const { container } = render(await ExplorePage(params({})));
    expect(mocks.requireSession).toHaveBeenCalledExactlyOnceWith("/explorar");
    expect(mocks.explore).toHaveBeenCalledExactlyOnceWith(NOTHING);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Explorar");
    const photo = heading.closest("[data-page-header]")?.querySelector("img");
    expect(photo).toHaveAttribute("alt", "");
    expect(photo?.getAttribute("src")).toMatch(/explorar-faro/);
    expect(screen.getByRole("search")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Buscar por curso o maestro" })).toHaveValue("");
    expect(within(practiceChips()).getByRole("link", { name: "Todas las prácticas" })).toHaveAttribute("aria-current", "true");
    expect(within(practiceChips()).getByRole("link", { name: "Meditación" })).toHaveAttribute("href", "/explorar?practica=meditacion");
    expect(within(practiceChips()).getByRole("link", { name: "Meditación" })).not.toHaveAttribute("aria-current");
    expect(chosenPractice(container)).toHaveValue("");
    const all = screen.getByRole("list", { name: "Todos los cursos" });
    expect(within(all).getByRole("link", { name: "Respirar para dormir, con Ana Robles" })).toHaveAttribute("href", "/cursos/respirar");
    expect(screen.queryByRole("link", { name: /^Ver todo/ })).toBeNull();
    // La región que dice cuántos existe desde antes de la primera búsqueda, vacía.
    expect(screen.getByRole("status")).toHaveTextContent(/^$/);
    const nav = screen.getByRole("navigation", { name: "Principal" });
    expect(within(nav).getByRole("link", { name: "Explorar" })).toHaveAttribute("aria-current", "page");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin filtro: la rejilla junta los cursos en el orden de las prácticas (PA-67), sin carrusel por práctica", async () => {
    const row = (slug: string, name: string, count: number) => ({ slug, name, tone: 3, courses: Array.from({ length: count }, (_, i) => ({ ...COURSE, slug: `${slug}-${i}`, title: `${name} ${i}` })) });
    mocks.explore.mockResolvedValue({ ...ready({}, null), shelf: { ...SHELF, practices: [row("a", "Alfa", 2), row("b", "Beta", 1), row("c", "Gama", 2)] } });
    render(await ExplorePage(params({})));
    const links = within(screen.getByRole("list", { name: "Todos los cursos" })).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/cursos/a-0", "/cursos/a-1", "/cursos/b-0", "/cursos/c-0", "/cursos/c-1"]);
    expect(screen.queryByRole("region", { name: "Alfa" })).toBeNull();
  });

  it("la rejilla llega a lo más a cinco columnas, y el buscador mide a lo más 720 px con el envío dentro", async () => {
    mocks.explore.mockResolvedValue(ready({ practice: "meditacion" }, { courses: [COURSE], teachers: [] }));
    render(await ExplorePage(params({ practica: "meditacion" })));
    const grid = screen.getByRole("list", { name: "Resultados" });
    expect(grid).toHaveClass("lg:grid-cols-5");
    expect(grid.className).not.toMatch(/grid-cols-6/);
    const search = screen.getByRole("search");
    expect(search).toHaveClass("max-w-search");
    expect(within(search).getByRole("button", { name: "Buscar" })).toHaveAttribute("type", "submit");
  });

  it("las fichas y los selectores van en una fila, y en el teléfono las fichas se desvanecen en el borde", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    render(await ExplorePage(params({})));
    const row = practiceChips().parentElement as HTMLElement;
    expect(row).toContainElement(screen.getByRole("combobox", { name: "Nivel" }));
    expect(row).toContainElement(screen.getByRole("combobox", { name: "Maestro" }));
    expect(row).toHaveClass("sm:flex-row");
    expect(within(practiceChips()).getByRole("list")).toHaveClass("max-sm:mask-r-from-85%");
    // Ya no hay selector de práctica: las fichas lo reemplazan.
    expect(screen.queryByRole("combobox", { name: "Práctica" })).toBeNull();
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
    // La práctica elegida: su ficha, y el campo oculto que la lleva con la búsqueda. Las fichas conservan la búsqueda.
    expect(within(practiceChips()).getByRole("link", { name: "Meditación" })).toHaveAttribute("aria-current", "true");
    expect(within(practiceChips()).getByRole("link", { name: "Todas las prácticas" })).toHaveAttribute("href", "/explorar?q=ana");
    expect(chosenPractice(container)).toHaveValue("meditacion");
    expect(screen.getByRole("link", { name: "Quitar filtro: Meditación" })).toHaveAttribute("href", "/explorar?q=ana");
    expect(screen.getByRole("link", { name: "Limpiar filtros" })).toHaveAttribute("href", "/explorar?q=ana");
    expect(screen.getByRole("link", { name: "Borrar la búsqueda" })).toHaveAttribute("href", "/explorar?practica=meditacion");
    expect(await a11yViolations(container)).toEqual([]);
  });

  // Desde T-616 (solicitud 3), el botón es un marcador de icono sobre la esquina de la portada (`variant="icon"`), fuera del
  // enlace; antes iba con su texto bajo la tarjeta.
  it("Mi lista: en la esquina de cada tarjeta, un marcador para guardar o quitar según lo que tiene guardado (RF-311)", async () => {
    const SOLTAR = { ...COURSE, slug: "soltar", title: "Soltar" };
    mocks.explore.mockResolvedValue(ready({ practice: "meditacion" }, { courses: [COURSE, SOLTAR], teachers: [] }));
    mocks.myList.mockResolvedValue({ kind: "ready", courses: [SOLTAR] });
    const { container } = render(await ExplorePage(params({ practica: "meditacion" })));
    expect(mocks.myList).toHaveBeenCalledExactlyOnceWith(claims);
    const results = screen.getByRole("region", { name: "Resultados" });
    const save = within(results).getByRole("button", { name: "Guardar en mi lista: Respirar para dormir" });
    expect(save).toHaveAttribute("value", "save:respirar");
    expect(save.closest("li")).toContainElement(within(results).getByRole("link", { name: /^Respirar para dormir/ }));
    expect(save.closest("a")).toBeNull();
    // Solo el icono a la vista: el texto es su nombre.
    expect(save).toHaveTextContent(/^Guardar en mi lista: Respirar para dormir$/);
    expect(save).toHaveClass("size-touch");
    expect(within(results).getByRole("button", { name: "Quitar de mi lista: Soltar" })).toHaveAttribute("value", "remove:soltar");
    expect(container.querySelector("#bloque-explorar-soltar")).not.toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("Mi lista: con otros filtros, el botón se arma de nuevo y no arrastra lo que contestó el anterior", async () => {
    mocks.explore.mockResolvedValue(ready({ practice: "meditacion" }, { courses: [COURSE], teachers: [] }));
    mocks.myList.mockResolvedValue({ kind: "ready", courses: [] });
    const { rerender } = render(await ExplorePage(params({ practica: "meditacion" })));
    const before = screen.getByRole("button", { name: "Guardar en mi lista: Respirar para dormir" });
    rerender(await ExplorePage(params({ practica: "meditacion" })));
    expect(screen.getByRole("button", { name: "Guardar en mi lista: Respirar para dormir" })).toBe(before);
    mocks.explore.mockResolvedValue(ready({ practice: "meditacion", level: "principiante" }, { courses: [COURSE], teachers: [] }));
    rerender(await ExplorePage(params({ practica: "meditacion", nivel: "principiante" })));
    expect(screen.getByRole("button", { name: "Guardar en mi lista: Respirar para dormir" })).not.toBe(before);
  });

  // Antes: «también en los carruseles por práctica»; desde T-616 no hay carruseles sin filtro, sino la rejilla.
  it("Mi lista: también en la rejilla sin filtro", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    mocks.myList.mockResolvedValue({ kind: "ready", courses: [] });
    render(await ExplorePage(params({})));
    expect(within(screen.getByRole("list", { name: "Todos los cursos" })).getByRole("button", { name: "Guardar en mi lista: Respirar para dormir" })).toBeVisible();
  });

  it("Mi lista: si no se pudo leer, las tarjetas van sin botón", async () => {
    mocks.explore.mockResolvedValue(ready({ practice: "meditacion" }, { courses: [COURSE], teachers: [] }));
    render(await ExplorePage(params({ practica: "meditacion" })));
    expect(screen.queryByRole("button", { name: /mi lista/ })).toBeNull();
  });

  it("sin resultados: lo dice, ofrece limpiar los filtros y muestra «Nuevos» debajo", async () => {
    mocks.explore.mockResolvedValue(ready({ q: "zz", level: "principiante" }, { courses: [], teachers: [] }));
    render(await ExplorePage(params({ q: "zz", nivel: "principiante" })));
    expect(screen.getByRole("status")).toHaveTextContent("0 cursos");
    expect(screen.getByText("No encontramos cursos con esos filtros.")).toBeVisible();
    // Un estado con la flor (T-616).
    expect(screen.getByText("No encontramos cursos con esos filtros.").parentElement?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
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

  // Desde T-616 la práctica no es un campo sino fichas: el filtro de fuera del buscador que se prueba es el nivel, y la
  // práctica vacía (el campo oculto) tampoco viaja.
  it("los campos vacíos no viajan en la dirección, y los filtros fuera del buscador sí viajan", async () => {
    mocks.explore.mockResolvedValue(ready({}, null));
    render(await ExplorePage(params({})));
    vi.useFakeTimers();
    const form = capture();
    fireEvent.change(screen.getByRole("combobox", { name: "Nivel" }), { target: { value: "principiante" } });
    act(() => vi.advanceTimersByTime(400));
    form.stop();
    expect(form.sent()).toEqual(["nivel"]);
  });

  it("la práctica elegida viaja con la búsqueda", async () => {
    mocks.explore.mockResolvedValue(ready({ practice: "meditacion" }, { courses: [COURSE], teachers: [] }));
    render(await ExplorePage(params({ practica: "meditacion" })));
    vi.useFakeTimers();
    const form = capture();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "res" } });
    act(() => vi.advanceTimersByTime(400));
    form.stop();
    expect(form.sent()?.sort()).toEqual(["practica", "q"]);
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
    const { container, rerender } = render(await ExplorePage(params({ practica: "meditacion" })));
    expect(screen.getByRole("searchbox")).not.toHaveFocus();
    const chip = screen.getByRole("link", { name: "Quitar filtro: Meditación" });
    chip.focus();
    mocks.explore.mockResolvedValue(ready({}, null));
    rerender(await ExplorePage(params({})));
    expect(screen.queryByRole("link", { name: "Quitar filtro: Meditación" })).toBeNull();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(chosenPractice(container)).toHaveValue("");
  });
});
