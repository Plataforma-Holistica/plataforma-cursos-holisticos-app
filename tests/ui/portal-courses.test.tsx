import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mis cursos (PA-42), crear y borrar un curso (T-402), servidos por el comodín del portal, con la guarda
// y el servicio simulados: que el comodín no lea nada antes de saber quién pide, que el suspendido vea
// todo en solo lectura, y las reglas automáticas de accesibilidad.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  requireTeacher: vi.fn(),
  teacherCourses: vi.fn(),
  draftCourse: vi.fn(),
  readNotice: vi.fn((): string | null => null),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
  redirect: vi.fn((to: string): never => {
    throw new Error(`redirige a ${to}`);
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireTeacher: mocks.requireTeacher }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ readNotice: mocks.readNotice }));
vi.mock("@/services/drafts/editor", () => ({ teacherCourses: mocks.teacherCourses, draftCourse: mocks.draftCourse }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));
vi.mock("@/app/portal/_cursos/actions", () => ({ createCourseAction: vi.fn(), deleteCourseAction: vi.fn() }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import PortalRestPage from "@/app/portal/[...resto]/page";

import { a11yViolations } from "../setup/a11y";

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: null, issuedAt: 0 };
const TEACHER = "7e000000-0000-4000-8000-000000000001";
const COURSE = "c0000000-0000-4000-8000-000000000001";

const course = {
  id: COURSE,
  state: "draft",
  title: "Respirar",
  updatedAt: "2026-10-29T18:00:00.000Z",
  contentRevision: 3,
  teacherName: "Ana Ruiz",
  practiceName: "Respiración",
  coverTone: 3,
  draft: { hasSummary: false, practiceReady: true, levelReady: true, lessons: 2, modulesWithLessons: 1 },
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
    return Promise.resolve({ kind: "render", claims, teacher: { id: TEACHER, status } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order = [];
  teaches("active");
  mocks.teacherCourses.mockImplementation(() => {
    mocks.order.push("cursos");
    return Promise.resolve({ kind: "ready", value: [course] });
  });
  mocks.draftCourse.mockResolvedValue({ kind: "ready", value: { id: COURSE, state: "draft", title: "Respirar", contentRevision: 3 } });
});

describe("el comodín del portal", () => {
  it("corre la guarda con la ruta pedida antes de leer nada", async () => {
    render(await at(["cursos"]));
    expect(mocks.requireTeacher).toHaveBeenCalledExactlyOnceWith("/portal/cursos");
    expect(mocks.order).toEqual(["guarda", "cursos"]);
  });

  it("a quien no es maestro la guarda le contesta «no existe», y no se lee nada", async () => {
    mocks.requireTeacher.mockImplementation(() => Promise.reject(new Error("no existe")));
    await expect(at(["cursos"])).rejects.toThrow("no existe");
    expect(mocks.teacherCourses).not.toHaveBeenCalled();
  });

  it.each([[["finanzas"]], [["cursos", "no-es-un-id"]], [["cursos", COURSE, "otra"]], [["cursos", "nuevo", "mas"]]])(
    "una ruta que no existe se contesta después de la guarda: %j",
    async (resto) => {
      await expect(at(resto)).rejects.toThrow("no encontrado");
      expect(mocks.requireTeacher).toHaveBeenCalledOnce();
    },
  );

  it("la cuenta suspendida ve PA-35 y «no se supo» ve PA-18, sin leer nada", async () => {
    mocks.requireTeacher.mockResolvedValueOnce({ kind: "suspended" });
    render(await at(["cursos"]));
    expect(mocks.teacherCourses).not.toHaveBeenCalled();
  });
});

describe("PA-42 · Mis cursos", () => {
  it("cada curso con su estado, lo que le falta, editar y borrar, y sin fallas de accesibilidad", async () => {
    const { container } = render(await at(["cursos"]));
    expect(screen.getByRole("heading", { level: 1, name: "Mis cursos" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Nuevo curso" }).getAttribute("href")).toBe("/portal/cursos/nuevo");
    const item = screen.getByRole("heading", { level: 2, name: "Respirar" }).closest("li") as HTMLElement;
    expect(within(item).getByText("Faltan 3 cosas para enviarlo")).toBeTruthy();
    expect(within(item).getByRole("link", { name: "Editar Respirar" }).getAttribute("href")).toBe(`/portal/cursos/${COURSE}`);
    expect(within(item).getByRole("link", { name: "Borrar Respirar" }).getAttribute("href")).toBe(`/portal/cursos/${COURSE}/borrar`);
    expect(screen.getByRole("navigation", { name: "Portal" })).toBeTruthy();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al maestro suspendido: la franja, «Ver», y ni crear ni borrar", async () => {
    teaches("suspended");
    const { container } = render(await at(["cursos"]));
    expect(screen.getByRole("status").textContent).toContain("solo lectura");
    expect(screen.queryByRole("link", { name: "Nuevo curso" })).toBeNull();
    expect(screen.getByRole("link", { name: "Ver Respirar" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Borrar Respirar" })).toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin cursos, el estado vacío con «Crear mi primer curso»", async () => {
    mocks.teacherCourses.mockResolvedValueOnce({ kind: "ready", value: [] });
    render(await at(["cursos"]));
    expect(screen.getByText("Todavía no tienes cursos.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Crear mi primer curso" }).getAttribute("href")).toBe("/portal/cursos/nuevo");
  });

  it("dice el aviso de un curso borrado", async () => {
    mocks.readNotice.mockReturnValueOnce("course_deleted");
    render(await at(["cursos"]));
    expect(screen.getByText("Borraste el curso.")).toBeTruthy();
  });
});

describe("crear un curso", () => {
  it("el título con su contador y el testigo oculto, sin fallas de accesibilidad", async () => {
    const { container } = render(await at(["cursos", "nuevo"]));
    expect(screen.getByRole("textbox", { name: "Título del curso" })).toBeTruthy();
    expect(screen.getByText("0 / 60")).toBeTruthy();
    const token = container.querySelector<HTMLInputElement>('input[name="token"]');
    expect(token?.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al maestro suspendido no se le ofrece: vuelve a su lista", async () => {
    teaches("suspended");
    await expect(at(["cursos", "nuevo"])).rejects.toThrow("redirige a /portal/cursos");
  });
});

describe("borrar un curso", () => {
  it("«Cancelar» primero, y el botón lleva la revisión que se vio", async () => {
    const { container } = render(await at(["cursos", COURSE, "borrar"]));
    const controls = [...(container.querySelector("#bloque-curso-borrar form")?.querySelectorAll("a, button") ?? [])];
    expect(controls).toEqual([screen.getByRole("link", { name: "Cancelar" }), screen.getByRole("button", { name: "Borrar curso" })]);
    expect(screen.getByRole("button", { name: "Borrar curso" }).getAttribute("value")).toBe(`delete:${COURSE}:3`);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it.each([
    ["un suspendido", () => teaches("suspended")],
    ["un curso que ya no es borrador", () => mocks.draftCourse.mockResolvedValue({ kind: "ready", value: { id: COURSE, state: "in_review", title: "R", contentRevision: 3 } })],
    ["un curso que no es suyo", () => mocks.draftCourse.mockResolvedValue({ kind: "ready", value: null })],
  ])("para %s no existe", async (_name, arrange) => {
    arrange();
    await expect(at(["cursos", COURSE, "borrar"])).rejects.toThrow("no encontrado");
  });
});
