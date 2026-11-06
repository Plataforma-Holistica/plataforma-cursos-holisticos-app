import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { terms } from "@/messages/es/terms";

// La página de una lección (PA-22), con la guarda, los servicios y la pantalla simulados: qué le pasa a la
// pantalla. Desde T-614 (parte 5) lleva la barra del alumno, y la ficha del curso del catálogo da a dónde
// regresar, los enlaces del curso y del maestro y la portada de antes de reproducir; si no se pudo leer, la
// lección se ve igual, sin enlace al maestro ni portada.

const mocks = vi.hoisted(() => ({
  requireLessonSession: vi.fn(),
  cookieReader: vi.fn(),
  lessonPage: vi.fn(),
  lessonResources: vi.fn(),
  lessonAccess: vi.fn(),
  captionsChoice: vi.fn(),
  coursePage: vi.fn(),
  shown: null as Record<string, unknown> | null,
}));
vi.mock("@/app/_lib/guard", () => ({ requireLessonSession: mocks.requireLessonSession }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/lessons/lessons", () => ({ lessonPage: mocks.lessonPage, lessonResources: mocks.lessonResources, courseIsOpen: vi.fn() }));
vi.mock("@/services/media/media", () => ({ lessonAccess: mocks.lessonAccess }));
vi.mock("@/services/account/account", () => ({ captionsChoice: mocks.captionsChoice }));
vi.mock("@/services/browse/browse", () => ({ coursePage: mocks.coursePage }));
vi.mock("@/app/cursos/[slug]/lecciones/[leccion]/screen", () => ({
  LessonScreen: (props: Record<string, unknown>) => {
    mocks.shown = props;
    return null;
  },
}));

import LessonRoute from "@/app/cursos/[slug]/lecciones/[leccion]/page";

const LESSON = "a0000000-0000-4000-8000-000000000001";
const params = () => ({ params: Promise.resolve({ slug: "respirar", leccion: LESSON }) });
const PAGE = {
  course: { slug: "respirar", title: "Respirar para dormir", summary: null, teacherName: "Ana Robles" },
  lesson: { id: LESSON, title: "Soltar", number: 1, durationSeconds: 300, moduleTitle: "Uno" },
  modules: [],
  next: null,
  lessonCount: 1,
  progress: { completed: 0, total: 1 },
};
const LISTED = {
  kind: "found",
  resources: [],
  detail: { course: { slug: "respirar", teacherSlug: "ana-robles", practice: { slug: "meditacion", name: "Meditación", tone: 3, position: 1 } } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shown = null;
  mocks.requireLessonSession.mockResolvedValue({ kind: "render", claims: { userId: "u" } });
  mocks.cookieReader.mockResolvedValue({ get: () => undefined });
  mocks.lessonPage.mockResolvedValue({ kind: "found", page: PAGE });
  mocks.lessonAccess.mockResolvedValue({ kind: "allowed" });
  mocks.lessonResources.mockResolvedValue([]);
  mocks.captionsChoice.mockResolvedValue({ kind: "ready", on: false });
  mocks.coursePage.mockResolvedValue(LISTED);
});

describe("la página de una lección (PA-22)", () => {
  it("lleva la barra del alumno, con el logotipo que vuelve al inicio (T-614)", async () => {
    render(await LessonRoute(params()));
    expect(screen.getByRole("navigation", { name: "Principal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: terms.Plataforma })).toHaveAttribute("href", "/inicio");
  });

  it("le pasa a la pantalla a dónde regresar, el curso y el maestro con sus fichas, y la portada", async () => {
    render(await LessonRoute(params()));
    expect(mocks.coursePage).toHaveBeenCalledExactlyOnceWith("respirar");
    expect(mocks.shown).toMatchObject({
      course: { title: "Respirar para dormir", href: "/cursos/respirar" },
      teacher: { name: "Ana Robles", href: "/maestros/ana-robles" },
      cover: { practiceName: "Meditación", tone: 3 },
    });
  });

  it("si la ficha del curso no se pudo leer, la lección se ve igual: sin enlace al maestro ni portada", async () => {
    mocks.coursePage.mockResolvedValue({ kind: "unavailable" });
    render(await LessonRoute(params()));
    expect(mocks.shown).toMatchObject({
      course: { title: "Respirar para dormir", href: "/cursos/respirar" },
      teacher: { name: "Ana Robles", href: null },
      cover: null,
    });
  });

  it("un maestro que no está listado se nombra sin enlace", async () => {
    mocks.coursePage.mockResolvedValue({ ...LISTED, detail: { course: { ...LISTED.detail.course, teacherSlug: null } } });
    render(await LessonRoute(params()));
    expect(mocks.shown).toMatchObject({ teacher: { name: "Ana Robles", href: null } });
  });
});
