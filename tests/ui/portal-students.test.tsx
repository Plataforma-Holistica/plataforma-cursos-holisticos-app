import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CourseStudentsValue } from "@/services/teachers/course-students-data";

// PA-51 · Avance de alumnos (T-408), servida por el comodín del portal, con la guarda y el servicio simulados: que el comodín no lea nada antes de la
// guarda, lo que pide según la dirección, las tres cifras, el avance por lección, la lista con su alias y su barra, el orden y las páginas por enlaces,
// los avisos, que el suspendido lo vea todo, «no se supo» con «Reintentar», y las reglas automáticas de accesibilidad. Lo que el servicio lee de verdad
// lo prueban la 83 y la 111.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  requireTeacher: vi.fn(),
  courseStudents: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireTeacher: mocks.requireTeacher }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: vi.fn() }));
vi.mock("@/services/teachers/course-students-data", () => ({ courseStudents: mocks.courseStudents }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import PortalRestPage from "@/app/portal/[...resto]/page";

import { a11yViolations } from "../setup/a11y";

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: null, issuedAt: 0 };
const TEACHER = "7e000000-0000-4000-8000-000000000001";
const COURSE = "c0000000-0000-4000-8000-000000000001";
const PAGE = `/portal/cursos/${COURSE}/alumnos`;

const VALUE: CourseStudentsValue = {
  title: "Respirar para volver",
  figures: { started: 41, inProgress: 29, finished: 12, cutAt: "2031-03-12T06:00:00.000Z" },
  lessons: [
    { title: "Respirar", finished: 30 },
    { title: "Soltar", finished: 12 },
  ],
  students: [
    { alias: "Garza 42", completed: 2, total: 2 },
    { alias: "Lerma 17", completed: 0, total: 2 },
  ],
  page: 2,
  pages: 3,
  totalStudents: 120,
  listCutAt: "2031-03-10T06:00:00.000Z",
  stale: false,
};

/** Lo que pinta el comodín en esa ruta, ya resuelta la sección del servidor. */
async function at(resto: string[], search: Record<string, string> = {}) {
  const page = (await PortalRestPage({ params: Promise.resolve({ resto }), searchParams: Promise.resolve(search) })) as ReactElement<object>;
  const section = page.type as (props: object) => unknown;
  return typeof section === "function" && section.name.endsWith("Section") ? ((await section(page.props)) as ReactElement) : page;
}

function teaches(status: "active" | "suspended") {
  mocks.requireTeacher.mockImplementation(() => {
    mocks.order.push("guarda");
    return Promise.resolve({ kind: "render", screen: "work", claims, teacher: { id: TEACHER, status, notice: null } });
  });
}

const answering = (value: CourseStudentsValue | { outcome: string } | "unavailable") =>
  mocks.courseStudents.mockImplementation(() => {
    mocks.order.push("avance");
    if (value === "unavailable") return Promise.resolve({ kind: "unavailable" });
    return Promise.resolve({ kind: "ready", value: "outcome" in value ? value : { outcome: "ok", value } });
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order = [];
  teaches("active");
  answering(VALUE);
});

describe("PA-51 · Avance de alumnos", () => {
  it("corre la guarda con la ruta pedida antes de leer, y el menú marca Mis cursos, sin fallas de accesibilidad", async () => {
    const { container } = render(await at(["cursos", COURSE, "alumnos"]));
    expect(mocks.requireTeacher).toHaveBeenCalledExactlyOnceWith(PAGE, "work");
    expect(mocks.order).toEqual(["guarda", "avance"]);
    expect(mocks.courseStudents).toHaveBeenCalledExactlyOnceWith(claims, { course: COURSE, order: "progress", page: 1 });
    expect(screen.getByRole("heading", { level: 1, name: "Respirar para volver" })).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "Mis cursos" }).filter((each) => each.hasAttribute("aria-current"))) {
      expect(link).toHaveAttribute("aria-current", "page");
    }
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("pide el orden y la página de la dirección", async () => {
    await at(["cursos", COURSE, "alumnos"], { orden: "alias", pagina: "2" });
    expect(mocks.courseStudents).toHaveBeenCalledWith(claims, { course: COURSE, order: "alias", page: 2 });
  });

  it("la nota del alias, las tres cifras con su fecha, y nada de nadie", async () => {
    render(await at(["cursos", COURSE, "alumnos"]));
    expect(screen.getByText(/Ves a cada persona con un alias/)).toBeInTheDocument();
    expect(screen.getByText("Cifras hasta el 11 de marzo de 2031. Se actualizan cada noche.")).toBeInTheDocument();
    for (const [label, value] of [
      ["Lo empezaron", "41"],
      ["Van a medio curso", "29"],
      ["Lo terminaron", "12"],
    ] as const) {
      expect(within(screen.getByText(label).closest("div") as HTMLElement).getByText(value)).toBeInTheDocument();
    }
    expect(document.body.textContent).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("el avance por lección, en el orden del temario, con su tabla", async () => {
    render(await at(["cursos", COURSE, "alumnos"]));
    const table = screen.getByRole("table", { name: "Cuántos alumnos terminaron cada lección" });
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["1. Respirar", "2. Soltar"]);
  });

  it("la lista: alias, lecciones terminadas y su barra, con el lunes de la lista; el orden y las páginas son enlaces", async () => {
    render(await at(["cursos", COURSE, "alumnos"]));
    expect(screen.getByText("Lista hasta el 9 de marzo de 2031. Se actualiza cada lunes.")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Tus alumnos en este curso" });
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Garza 42", "Lerma 17"]);
    const first = within(table).getByRole("rowheader", { name: "Garza 42" }).closest("tr") as HTMLElement;
    expect(within(first).getByRole("progressbar", { name: "Avance de Garza 42" })).toHaveAttribute("aria-valuetext", "2 de 2");
    expect(screen.queryByRole("link", { name: "Por avance" })).not.toBeInTheDocument();
    expect(screen.getByText("Por avance")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Por alias" })).toHaveAttribute("href", `${PAGE}?orden=alias`);
    const pages = screen.getByRole("navigation", { name: "Páginas de la lista" });
    expect(within(pages).getByText("Página 2 de 3")).toBeInTheDocument();
    expect(within(pages).getByRole("link", { name: "Anterior" })).toHaveAttribute("href", PAGE);
    expect(within(pages).getByRole("link", { name: "Siguiente" })).toHaveAttribute("href", `${PAGE}?pagina=3`);
  });

  it("en teléfono, filas compactas en el mismo orden", async () => {
    render(await at(["cursos", COURSE, "alumnos"]));
    const rows = within(screen.getByRole("list", { name: "Tus alumnos en este curso" })).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["Garza 42", "Lerma 17"]);
  });

  it("ninguna acción sobre un alumno: ni botones ni formularios", async () => {
    const { container } = render(await at(["cursos", COURSE, "alumnos"]));
    const main = container.querySelector("main") as HTMLElement;
    expect(within(main).queryAllByRole("button")).toEqual([]);
    expect(main.querySelector("form")).toBeNull();
  });

  it("antes de la primera noche lo dice, sin inventar ceros", async () => {
    answering({ ...VALUE, figures: null, lessons: [{ title: "Respirar", finished: null }], students: [], page: 1, pages: 1, totalStudents: 0, listCutAt: null, stale: true });
    render(await at(["cursos", COURSE, "alumnos"]));
    expect(screen.getByText("Todavía no hay cifras de este curso: se calculan cada noche.")).toBeInTheDocument();
    expect(screen.getAllByText("Sin datos todavía").length).toBeGreaterThan(0);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByText("La lista se arma cada lunes: quien empezó después aparece en la siguiente.")).toBeInTheDocument();
  });

  it("un resumen viejo lleva su aviso", async () => {
    answering({ ...VALUE, stale: true });
    render(await at(["cursos", COURSE, "alumnos"]));
    expect(screen.getByText("No se pudieron actualizar las cifras de anoche. Estas son hasta el 11 de marzo de 2031.")).toBeInTheDocument();
  });

  it("nadie lo ha empezado: lo dice, sin lecciones ni lista", async () => {
    answering({ ...VALUE, figures: { started: 0, inProgress: 0, finished: 0, cutAt: VALUE.figures!.cutAt }, students: [], totalStudents: 0, page: 1, pages: 1 });
    render(await at(["cursos", COURSE, "alumnos"]));
    expect(screen.getByText("Todavía nadie ha empezado este curso.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("«no se supo» ofrece reintentar en la misma pantalla", async () => {
    answering("unavailable");
    render(await at(["cursos", COURSE, "alumnos"], { orden: "alias" }));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", `${PAGE}?orden=alias`);
  });

  it("el suspendido lo ve todo, con la franja de solo lectura", async () => {
    teaches("suspended");
    render(await at(["cursos", COURSE, "alumnos"]));
    expect(screen.getByText(/Tu cuenta está en solo lectura/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Tus alumnos en este curso" })).toBeInTheDocument();
  });

  it.each(["not_found", "not_teacher"])("si el servicio dice %s, no existe", async (outcome) => {
    answering({ outcome });
    await expect(at(["cursos", COURSE, "alumnos"])).rejects.toThrow("no encontrado");
  });

  it("otra forma de la ruta no es una pantalla", async () => {
    await expect(at(["cursos", COURSE, "alumnos", "mas"])).rejects.toThrow("no encontrado");
    expect(mocks.courseStudents).not.toHaveBeenCalled();
  });
});
