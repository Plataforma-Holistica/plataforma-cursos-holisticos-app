import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

// Las fichas públicas del catálogo (PA-02, PA-03; T-210), con la guarda y los servicios
// simulados: qué pinta cada una según quién mira y lo que contesta el servicio. Qué botón le
// toca a cada quien está en src/app/cursos/[slug]/outcomes.test.ts; aquí se cuida que la página
// lo pinte y que no le pregunte a nadie de más.

const mocks = vi.hoisted(() => ({
  publicViewer: vi.fn(),
  cookieReader: vi.fn(),
  coursePage: vi.fn(),
  courseStanding: vi.fn(),
  teacherPage: vi.fn(),
  lessonAccess: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ publicViewer: mocks.publicViewer }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/browse/browse", () => ({ coursePage: mocks.coursePage, courseStanding: mocks.courseStanding, teacherPage: mocks.teacherPage }));
vi.mock("@/services/media/media", () => ({ lessonAccess: mocks.lessonAccess }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));

import CourseRoute from "@/app/cursos/[slug]/page";
import TeacherRoute from "@/app/maestros/[slug]/page";

const claims = { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 };
const L1 = "11111111-1111-4111-8111-111111111111";
const L2 = "22222222-2222-4222-8222-222222222222";
const COURSE = {
  slug: "respirar",
  title: "Respirar para dormir",
  summary: "Un curso para volver a dormir.",
  teacherName: "Ana Robles",
  teacherSlug: "ana-robles",
  practice: { slug: "meditacion", name: "Meditación", tone: 3, position: 1 },
  level: { slug: "principiante", name: "Principiante", position: 1 },
  lessonCount: 2,
  totalSeconds: 765,
  publishedAt: new Date(0),
  isOpen: false,
};
const detail = (over: Record<string, unknown> = {}) => ({
  course: { ...COURSE, ...over },
  teacher: { slug: "ana-robles", name: "Ana Robles", bio: "Enseña a respirar." },
  modules: [
    {
      id: "m1",
      title: "Preparar el cuerpo",
      lessons: [
        { id: L1, title: "Soltar los hombros", number: 1, durationSeconds: 356 },
        { id: L2, title: "La postura", number: 2, durationSeconds: 409 },
      ],
    },
  ],
  firstLesson: { id: L1, title: "Soltar los hombros" },
});
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const lesson = (id: string) => `/cursos/respirar/lecciones/${id}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieReader.mockResolvedValue({ get: () => undefined });
  mocks.coursePage.mockResolvedValue({ kind: "found", detail: detail() });
});

describe("la ficha de un curso (PA-02)", () => {
  it("al visitante: todo el curso, y «Suscribirme para verlo» lleva a registrarse; no se le pregunta nada más a nadie", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "visitor" });
    const { container } = render(await CourseRoute(params("respirar")));
    expect(mocks.coursePage).toHaveBeenCalledExactlyOnceWith("respirar");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Respirar para dormir");
    expect(screen.getByText("2 lecciones · 13 min")).toBeVisible();
    expect(screen.getByText("Un curso para volver a dormir.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Suscribirme para verlo" })).toHaveAttribute("href", `/registro?volver=${encodeURIComponent(lesson(L1))}`);
    const syllabus = screen.getByRole("region", { name: "Temario" });
    expect(within(syllabus).getByRole("heading", { name: "Módulo 1 · Preparar el cuerpo" })).toBeVisible();
    expect(within(syllabus).getByRole("link", { name: "Lección 2, La postura, 7 min" })).toHaveAttribute("href", lesson(L2));
    expect(screen.getByRole("link", { name: "Ver la ficha de Ana Robles" })).toHaveAttribute("href", "/maestros/ana-robles");
    // Sin sesión no hay barra del alumno, ni avance, ni pregunta de acceso.
    expect(screen.queryByRole("navigation", { name: "Principal" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(mocks.lessonAccess).not.toHaveBeenCalled();
    expect(mocks.courseStanding).not.toHaveBeenCalled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al visitante del curso abierto: «Verlo sin costo» y el aviso", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "visitor" });
    mocks.coursePage.mockResolvedValue({ kind: "found", detail: detail({ isOpen: true }) });
    render(await CourseRoute(params("respirar")));
    expect(screen.getByRole("link", { name: "Verlo sin costo" })).toBeVisible();
    expect(screen.getByText("Este es el curso abierto: lo puedes ver sin suscripción, con tu cuenta.")).toBeVisible();
  });

  it("al alumno con avance: su barra, el estado de cada lección y «Continuar: lección 2»", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "student", claims });
    mocks.lessonAccess.mockResolvedValue({ kind: "allowed" });
    mocks.courseStanding.mockResolvedValue({
      kind: "ready",
      standing: {
        states: new Map([
          [L1, "completed"],
          [L2, "in_progress"],
        ]),
        completed: 1,
        total: 2,
        started: true,
        finished: false,
        suggested: { id: L2, number: 2 },
      },
    });
    const { container } = render(await CourseRoute(params("respirar")));
    expect(mocks.lessonAccess).toHaveBeenCalledExactlyOnceWith(expect.anything(), L1);
    expect(mocks.courseStanding).toHaveBeenCalledExactlyOnceWith(claims, expect.objectContaining({ firstLesson: { id: L1, title: "Soltar los hombros" } }));
    expect(screen.getByRole("link", { name: "Continuar: lección 2" })).toHaveAttribute("href", lesson(L2));
    expect(screen.getByRole("progressbar", { name: "Avance del curso" })).toHaveAttribute("aria-valuetext", "1 de 2 lecciones terminadas");
    expect(screen.getByRole("link", { name: "Lección 1, Soltar los hombros, 6 min, terminada" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Lección 2, La postura, 7 min, a medias" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Principal" })).toBeVisible();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al alumno, si no se supo su avance, la ficha se pinta igual con «Empezar»", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "student", claims });
    mocks.lessonAccess.mockResolvedValue({ kind: "allowed" });
    mocks.courseStanding.mockResolvedValue({ kind: "unavailable" });
    render(await CourseRoute(params("respirar")));
    expect(screen.getByRole("link", { name: "Empezar" })).toHaveAttribute("href", lesson(L1));
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("un curso que no existe contesta lo mismo que una ruta que no existe", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "visitor" });
    mocks.coursePage.mockResolvedValue({ kind: "not_found" });
    await expect(CourseRoute(params("otro"))).rejects.toThrow("no encontrado");
  });

  it("si no se pudo leer el curso, «algo falló», con reintentar en la misma ficha", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "visitor" });
    mocks.coursePage.mockResolvedValue({ kind: "unavailable" });
    render(await CourseRoute(params("respirar")));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/cursos/respirar");
  });
});

describe("la ficha de un maestro (PA-03)", () => {
  beforeEach(() => mocks.publicViewer.mockResolvedValue({ kind: "visitor" }));

  it("su nombre, sus prácticas, su semblanza y sus cursos", async () => {
    mocks.teacherPage.mockResolvedValue({
      kind: "found",
      teacher: { slug: "ana-robles", name: "Ana Robles", bio: "Enseña a respirar.", practices: ["Meditación"], courseCount: 1 },
      courses: [COURSE],
    });
    const { container } = render(await TeacherRoute(params("ana-robles")));
    expect(mocks.teacherPage).toHaveBeenCalledExactlyOnceWith("ana-robles");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ana Robles");
    expect(screen.getByText("Enseña a respirar.")).toBeVisible();
    const courses = screen.getByRole("region", { name: "Cursos de Ana Robles" });
    expect(within(courses).getByRole("link", { name: "Respirar para dormir, con Ana Robles" })).toHaveAttribute("href", "/cursos/respirar");
    expect(screen.queryByRole("navigation", { name: "Principal" })).toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al alumno le pinta su barra", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "student", claims });
    mocks.teacherPage.mockResolvedValue({ kind: "found", teacher: { slug: "ana-robles", name: "Ana Robles", bio: null, practices: [], courseCount: 1 }, courses: [COURSE] });
    render(await TeacherRoute(params("ana-robles")));
    expect(screen.getByRole("navigation", { name: "Principal" })).toBeVisible();
  });

  it("un maestro que no existe, o sin cursos, contesta lo mismo que una ruta que no existe", async () => {
    mocks.teacherPage.mockResolvedValue({ kind: "not_found" });
    await expect(TeacherRoute(params("nadie"))).rejects.toThrow("no encontrado");
  });
});
