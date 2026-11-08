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
  lessonComments: vi.fn(),
  commentReplies: vi.fn(),
  shown: null as Record<string, unknown> | null,
}));
vi.mock("@/app/_lib/guard", () => ({ requireLessonSession: mocks.requireLessonSession }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/lessons/lessons", () => ({ lessonPage: mocks.lessonPage, lessonResources: mocks.lessonResources, courseIsOpen: vi.fn() }));
vi.mock("@/services/media/media", () => ({ lessonAccess: mocks.lessonAccess }));
vi.mock("@/services/account/account", () => ({ captionsChoice: mocks.captionsChoice }));
vi.mock("@/services/browse/browse", () => ({ coursePage: mocks.coursePage }));
vi.mock("@/services/comments/comments", () => ({ lessonComments: mocks.lessonComments, commentReplies: mocks.commentReplies }));
vi.mock("@/app/cursos/[slug]/lecciones/[leccion]/screen", () => ({
  LessonScreen: (props: Record<string, unknown>) => {
    mocks.shown = props;
    return null;
  },
}));

import LessonRoute from "@/app/cursos/[slug]/lecciones/[leccion]/page";

const LESSON = "a0000000-0000-4000-8000-000000000001";
const params = (search: Record<string, string | string[]> = {}) => ({
  params: Promise.resolve({ slug: "respirar", leccion: LESSON }),
  searchParams: Promise.resolve(search),
});
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
  mocks.lessonComments.mockResolvedValue({ kind: "closed" });
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

describe("los comentarios de la lección (T-501)", () => {
  const C1 = "c0000000-0000-4000-8000-000000000001";
  const C2 = "c0000000-0000-4000-8000-000000000002";
  const reply = (id: string) => ({ id, name: "Beto", body: "Sí", state: "published", own: false, teacher: false, edited: false, createdAt: "2026-11-03T18:00:00+00:00", revision: null });
  const READY = {
    kind: "ready",
    items: [{ ...reply(C1), name: "Luz", replies: { items: [reply(C2)], more: true } }],
    next: "2026-11-03T18:00:00+00:00_" + C1,
    count: 21,
    me: { teacher: false, pseudonym: "Luz" },
    write: { kind: "ok" },
  };

  it("los lee para quien mira, desde la página que diga la dirección, y se los pasa a la pantalla", async () => {
    mocks.lessonComments.mockResolvedValue(READY);
    render(await LessonRoute(params({ comentarios: "2026-11-03T18:00:00+00:00_" + C2 })));
    expect(mocks.lessonComments).toHaveBeenCalledExactlyOnceWith({ userId: "u" }, LESSON, "2026-11-03T18:00:00+00:00_" + C2);
    expect(mocks.shown).toMatchObject({
      comments: { kind: "ready", view: { count: 21, items: READY.items, next: READY.next, paged: true, pagedThread: null, me: READY.me, write: READY.write } },
    });
  });

  it("desde la primera página si la dirección no dice otra", async () => {
    mocks.lessonComments.mockResolvedValue(READY);
    render(await LessonRoute(params({ comentarios: ["a", "b"] })));
    expect(mocks.lessonComments).toHaveBeenCalledWith({ userId: "u" }, LESSON, null);
    expect(mocks.shown).toMatchObject({ comments: { view: { paged: false } } });
  });

  it("las respuestas siguientes de un hilo de la página reemplazan las suyas", async () => {
    mocks.lessonComments.mockResolvedValue(READY);
    mocks.commentReplies.mockResolvedValue({ kind: "ready", items: [reply("c0000000-0000-4000-8000-000000000003")], next: null });
    render(await LessonRoute(params({ hilo: C1, respuestas: "2026-11-03T18:00:00+00:00_" + C2 })));
    expect(mocks.commentReplies).toHaveBeenCalledExactlyOnceWith({ userId: "u" }, LESSON, C1, "2026-11-03T18:00:00+00:00_" + C2);
    expect(mocks.shown).toMatchObject({
      comments: { view: { pagedThread: C1, items: [{ id: C1, replies: { items: [{ id: "c0000000-0000-4000-8000-000000000003" }], more: false } }] } },
    });
  });

  it("un hilo que no está en la página no se pide", async () => {
    mocks.lessonComments.mockResolvedValue(READY);
    render(await LessonRoute(params({ hilo: C2, respuestas: "x" })));
    expect(mocks.commentReplies).not.toHaveBeenCalled();
    expect(mocks.shown).toMatchObject({ comments: { view: { pagedThread: null } } });
  });

  it("si las respuestas no se pudieron leer, el hilo se queda con las primeras", async () => {
    mocks.lessonComments.mockResolvedValue(READY);
    mocks.commentReplies.mockResolvedValue({ kind: "unavailable" });
    render(await LessonRoute(params({ hilo: C1, respuestas: "2026-11-03T18:00:00+00:00_" + C2 })));
    expect(mocks.shown).toMatchObject({ comments: { view: { pagedThread: null, items: READY.items } } });
  });

  it.each([["closed"], ["not_found"], ["no_access"], ["suspended_account"], ["read_only"]])("con %s no hay comentarios", async (kind) => {
    mocks.lessonComments.mockResolvedValue({ kind, account: { allowed: false, reason: "no_basis" } });
    render(await LessonRoute(params()));
    expect(mocks.shown).toMatchObject({ comments: null });
  });

  it("si no se pudieron leer, la pantalla lo dice", async () => {
    mocks.lessonComments.mockResolvedValue({ kind: "unavailable" });
    render(await LessonRoute(params()));
    expect(mocks.shown).toMatchObject({ comments: { kind: "unavailable" } });
  });
});
