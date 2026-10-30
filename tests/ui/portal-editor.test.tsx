import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// El editor de curso (PA-43; T-402), servido por el comodín del portal, con la guarda y el servicio
// simulados: qué ofrece a un maestro activo, qué no al suspendido, lo elegido por la dirección, la
// práctica desactivada que sigue elegida, y las reglas automáticas de accesibilidad.

const mocks = vi.hoisted(() => ({
  requireTeacher: vi.fn(),
  draftCourse: vi.fn(),
  draftChoices: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireTeacher: mocks.requireTeacher }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ readNotice: vi.fn(() => null) }));
vi.mock("@/services/drafts/editor", () => ({ draftCourse: mocks.draftCourse, draftChoices: mocks.draftChoices, teacherCourses: vi.fn() }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/portal/_editor/actions", () => ({ editorAction: vi.fn() }));
vi.mock("@/app/portal/_cursos/actions", () => ({ createCourseAction: vi.fn(), deleteCourseAction: vi.fn() }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import PortalRestPage from "@/app/portal/[...resto]/page";

import { a11yViolations } from "../setup/a11y";

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: null, issuedAt: 0 };
const COURSE = "c0000000-0000-4000-8000-000000000001";
const M1 = "d0000000-0000-4000-8000-000000000001";
const M2 = "d0000000-0000-4000-8000-000000000002";
const L1 = "e0000000-0000-4000-8000-000000000001";
const L2 = "e0000000-0000-4000-8000-000000000002";
const P1 = "f0000000-0000-4000-8000-000000000001";

const draft = {
  id: COURSE,
  state: "draft",
  version: 1,
  title: "Respirar",
  summary: null,
  practiceId: P1,
  levelId: null,
  revision: 4,
  structureRevision: 3,
  contentRevision: 9,
  updatedAt: new Date().toISOString(),
  teacherName: "Ana Ruiz",
  modules: [
    {
      id: M1,
      title: "Inicio",
      position: 1,
      revision: 5,
      lessons: [
        { id: L1, title: "Una", description: null, position: 1, revision: 1 },
        { id: L2, title: "Dos", description: "Qué se hace.", position: 2, revision: 2 },
      ],
    },
    { id: M2, title: "Cierre", position: 2, revision: 1, lessons: [] },
  ],
};

async function at(search: Record<string, string> = {}) {
  const page = (await PortalRestPage({ params: Promise.resolve({ resto: ["cursos", COURSE] }), searchParams: Promise.resolve(search) })) as ReactElement<object>;
  const section = page.type as (props: object) => unknown;
  return typeof section === "function" ? ((await section(page.props)) as ReactElement) : page;
}

function teaches(status: "active" | "suspended") {
  mocks.requireTeacher.mockResolvedValue({ kind: "render", claims, teacher: { id: "t", status } });
}

beforeEach(() => {
  vi.clearAllMocks();
  teaches("active");
  mocks.draftCourse.mockResolvedValue({ kind: "ready", value: draft });
  mocks.draftChoices.mockResolvedValue({ kind: "ready", value: { practices: [{ id: P1, name: "Respiración", tone: 3, active: false }], levels: [] } });
});

describe("PA-43 · El editor de curso", () => {
  it("la barra, la estructura y los datos, sin fallas de accesibilidad", async () => {
    const { container } = render(await at());
    expect(screen.getByRole("heading", { level: 1, name: "Respirar" })).toBeTruthy();
    expect(screen.getByText(/^Guardado a las /)).toBeTruthy();
    // Para volver, y en el menú (una copia para el teléfono y otra para la computadora: el CSS muestra una).
    const links = screen.getAllByRole("link", { name: "Mis cursos" });
    expect(links.length).toBe(3);
    for (const link of links) expect(link.getAttribute("href")).toBe("/portal/cursos");
    expect(screen.getByText("8 / 60")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar" }).getAttribute("value")).toBe("save-course:4");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("la primera no sube y la última no baja; «Mover a» lleva a los otros módulos", async () => {
    render(await at());
    expect(screen.queryByRole("button", { name: "Subir Inicio" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bajar Inicio" }).getAttribute("value")).toBe(`module-down:${M1}:1`);
    expect(screen.getByRole("button", { name: "Subir Cierre" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bajar Cierre" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Subir Una" })).toBeNull();
    expect(screen.getByRole("button", { name: "Subir Dos" }).getAttribute("value")).toBe(`lesson-up:${L2}:${M1}:2`);
    const move = screen.getByRole("combobox", { name: "Mover Una a otro módulo" });
    expect(within(move).getByRole("option", { name: "Cierre" }).getAttribute("value")).toBe(`${M2}:1`);
    expect(screen.getAllByRole("button", { name: "Agregar lección" })).toHaveLength(2);
  });

  it("todo formulario lleva el curso", async () => {
    const { container } = render(await at());
    const forms = [...container.querySelectorAll("main form")];
    expect(forms.length).toBeGreaterThan(5);
    for (const each of forms) expect(each.querySelector<HTMLInputElement>('input[name="course"]')?.value).toBe(COURSE);
  });

  it("la práctica desactivada sigue elegida y marcada, y se avisa", async () => {
    render(await at());
    const practice = screen.getByRole("combobox", { name: /Práctica/ }) as HTMLSelectElement;
    expect(practice.value).toBe(P1);
    expect(within(practice).getByRole("option", { name: "Respiración (desactivada)" })).toBeTruthy();
    expect(screen.getByText(/ya no está disponible/)).toBeTruthy();
  });

  it("lo elegido por la dirección: la lección, con su descripción y «Borrar lección»", async () => {
    const { container } = render(await at({ leccion: L2 }));
    expect(screen.getByRole("heading", { level: 2, name: "Dos" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /Descripción/ }) as HTMLTextAreaElement).value).toBe("Qué se hace.");
    expect(screen.getByRole("button", { name: "Borrar lección" }).getAttribute("value")).toBe(`ask-delete-lesson:${L2}`);
    expect(screen.getByRole("link", { name: "Volver a la estructura" })).toBeTruthy();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al maestro suspendido: la franja y ningún formulario", async () => {
    teaches("suspended");
    const { container } = render(await at());
    expect(screen.getByText(/Tu cuenta está en solo lectura/).getAttribute("role")).toBe("status");
    // Solo «Cerrar sesión», en el menú.
    expect([...container.querySelectorAll("form")].filter((each) => each.closest("main") !== null)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("un curso en revisión se ve en solo lectura y lo dice", async () => {
    mocks.draftCourse.mockResolvedValue({ kind: "ready", value: { ...draft, state: "in_review" } });
    render(await at());
    expect(screen.getByText("No se puede editar mientras está en revisión.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
  });

  it("un curso que no es suyo no existe", async () => {
    mocks.draftCourse.mockResolvedValue({ kind: "ready", value: null });
    await expect(at()).rejects.toThrow("no encontrado");
    expect(mocks.draftChoices).not.toHaveBeenCalled();
  });
});
