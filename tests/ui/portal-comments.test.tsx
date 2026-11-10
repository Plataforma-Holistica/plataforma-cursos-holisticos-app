import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommentsState } from "@/app/_comments/state";
import { teacherHereHref } from "@/app/portal/_comentarios/outcomes";
import type { TeacherThread } from "@/services/comments/comments";

import { a11yViolations } from "../setup/a11y";

// PA-45 · Comentarios (T-501; RF-609; FL-38; plan aprobado por Sergio el 2026-11-08), servida por el comodín del portal, con la
// guarda, el servicio y la acción simulados: lo que pide según la dirección, los filtros, cada comentario con su lección y su
// curso, responder por la misma acción que la lección, lo propio, los estados en que no se responde y que no enlace a la lista de
// alumnos. Lo que la base da de verdad lo prueban la 93, la 96 y la 104.

const mocks = vi.hoisted(() => ({
  requireTeacher: vi.fn(),
  teacherComments: vi.fn(),
  teacherCommentCourses: vi.fn(),
  commentReplies: vi.fn(),
  action: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireTeacher: mocks.requireTeacher }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: vi.fn() }));
vi.mock("@/services/comments/comments", () => ({
  teacherComments: mocks.teacherComments,
  teacherCommentCourses: mocks.teacherCommentCourses,
  commentReplies: mocks.commentReplies,
}));
vi.mock("@/app/portal/_comentarios/actions", () => ({ teacherCommentAction: mocks.action }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import PortalRestPage from "@/app/portal/[...resto]/page";

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: null, issuedAt: 0 };
const TEACHER = "7e000000-0000-4000-8000-000000000001";
const COURSE = "d0000000-0000-4000-8000-000000000001";
const OTHER = "d0000000-0000-4000-8000-000000000002";
const LESSON = "b0000000-0000-4000-8000-000000000001";
const LESSON_2 = "b0000000-0000-4000-8000-000000000002";
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-11-03T18:00:00.000000+00:00";

function thread(n: number, extra: Partial<TeacherThread> = {}): TeacherThread {
  return {
    id: id(n),
    name: "Ana",
    body: `Pregunta ${n}`,
    state: "published",
    own: false,
    teacher: false,
    edited: false,
    createdAt: AT,
    revision: null,
    replies: { items: [], more: false },
    lessonId: LESSON,
    lessonTitle: "Soltar los hombros",
    courseId: COURSE,
    courseTitle: "Respirar para dormir",
    courseSlug: "respirar",
    answered: false,
    ...extra,
  };
}

async function at(search: Record<string, string> = {}) {
  const page = (await PortalRestPage({ params: Promise.resolve({ resto: ["comentarios"] }), searchParams: Promise.resolve(search) })) as ReactElement<object>;
  const section = page.type as (props: object) => unknown;
  return typeof section === "function" && section.name.endsWith("Section") ? ((await section(page.props)) as ReactElement) : page;
}

function teaches(status: "active" | "suspended") {
  mocks.requireTeacher.mockResolvedValue({ kind: "render", screen: "work", claims, teacher: { id: TEACHER, status, notice: null } });
}

beforeEach(() => {
  vi.clearAllMocks();
  teaches("active");
  mocks.teacherComments.mockResolvedValue({ kind: "ready", items: [thread(1)], next: null, write: "ok" });
  mocks.teacherCommentCourses.mockResolvedValue({
    kind: "ready",
    courses: [
      { id: COURSE, title: "Respirar para dormir" },
      { id: OTHER, title: "Yoga suave" },
    ],
  });
  mocks.action.mockResolvedValue({ attempt: 1, open: { kind: "none" }, notice: null, kept: null, written: null } satisfies CommentsState);
});

describe("PA-45 en el portal", () => {
  it("pide la guarda de trabajo y lee lo suyo con lo que dice la dirección", async () => {
    const { container } = render(await at({ curso: COURSE, "sin-responder": "1", desde: `${AT}_${id(9)}` }));
    expect(mocks.requireTeacher).toHaveBeenCalledExactlyOnceWith("/portal/comentarios", "work");
    expect(mocks.teacherComments).toHaveBeenCalledExactlyOnceWith(claims, { course: COURSE, unanswered: true, before: `${AT}_${id(9)}` });
    expect(screen.getByRole("heading", { level: 1, name: "Comentarios" })).toBeInTheDocument();
    // Un solo título: el foco de respaldo va al que se ve, no a uno solo para el lector.
    expect(screen.getAllByRole("heading", { name: "Comentarios" })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Comentarios" })).toHaveAttribute("tabindex", "-1");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("un curso que no es suyo, o sin forma, no se pide: es como sin filtro", async () => {
    render(await at({ curso: "c0000000-0000-4000-8000-00000000ffff" }));
    expect(mocks.teacherComments).toHaveBeenCalledWith(claims, { course: null, unanswered: false, before: null });
  });

  it("los filtros son enlaces: el curso, «Todos los cursos» y «Sin responder», con el elegido marcado", async () => {
    render(await at({ curso: COURSE }));
    const filters = screen.getByRole("navigation", { name: "Filtros" });
    expect(within(filters).getByRole("link", { name: "Respirar para dormir" })).toHaveAttribute("aria-current", "true");
    expect(within(filters).getByRole("link", { name: "Todos los cursos" })).toHaveAttribute("href", "/portal/comentarios");
    expect(within(filters).getByRole("link", { name: "Sin responder" })).toHaveAttribute("href", `/portal/comentarios?curso=${COURSE}&sin-responder=1`);
  });

  it("cada comentario con su lección, su curso, el autor por su nombre de comentarios, «Responder» y «Ver en la lección»", async () => {
    render(await at());
    const one = screen.getByRole("article", { name: "Ana" });
    expect(screen.getByText("Soltar los hombros · Respirar para dormir")).toBeInTheDocument();
    expect(within(one).getByText("Pregunta 1")).toBeInTheDocument();
    expect(within(one).getByRole("button", { name: "Responder" })).toHaveAttribute("value", `open-reply:${id(1)}`);
    expect(screen.getByRole("link", { name: "Ver en la lección" })).toHaveAttribute("href", `/cursos/respirar/lecciones/${LESSON}#comentarios`);
    // Ningún enlace a la lista de alumnos (PA-51): ahí van por su alias.
    expect(screen.queryAllByRole("link").map((link) => link.getAttribute("href"))).not.toContainEqual(expect.stringMatching(/\/alumnos/));
  });

  it("responder lleva la lección de ese comentario, por la misma acción que la lección", async () => {
    // Dos hilos de lecciones y cursos distintos: el segundo lleva los suyos, no los del primero.
    mocks.teacherComments.mockResolvedValue({
      kind: "ready",
      items: [thread(1), thread(2, { name: "Beto", lessonId: LESSON_2, courseId: OTHER, courseSlug: "yoga", courseTitle: "Yoga suave" })],
      next: null,
      write: "ok",
    });
    mocks.action.mockResolvedValue({ attempt: 1, open: { kind: "reply", parentId: id(2) }, notice: null, kept: null, written: null });
    render(await at());
    const user = userEvent.setup();
    await user.click(within(screen.getByRole("article", { name: "Beto" })).getByRole("button", { name: "Responder" }));
    const field = await screen.findByRole("textbox", { name: "Responde a Beto" });
    const data = new FormData(field.closest("form")!);
    expect(data.get("curso")).toBe("yoga");
    expect(data.get("leccion")).toBe(LESSON_2);
    expect(within(field.closest("form")!).getByRole("button", { name: "Responder" })).toHaveAttribute("value", `reply:${id(2)}`);
  });

  it("lo propio, con «Editar» y «Borrar»", async () => {
    mocks.teacherComments.mockResolvedValue({
      kind: "ready",
      items: [thread(1, { replies: { items: [{ ...thread(2), own: true, teacher: true, name: "Maestra", revision: 3, body: "Mi respuesta" }], more: false }, answered: true })],
      next: null,
      write: "ok",
    });
    render(await at());
    const mine = screen.getByRole("article", { name: "Tú" });
    expect(within(mine).getByRole("button", { name: "Editar" })).toHaveAttribute("value", `ask-edit:${id(2)}`);
    expect(within(mine).getByRole("button", { name: "Borrar" })).toHaveAttribute("value", `ask-delete:${id(2)}`);
  });

  it.each([
    ["closed", "Por ahora no se pueden publicar comentarios."],
    ["banned", "Por ahora no puedes comentar. Si crees que es un error, escríbenos."],
    // PA-45 junta varios cursos: el texto no habla de «este curso».
    ["suspended", "Por ahora no puedes escribir como maestro en estos comentarios. Puedes leerlos."],
  ] as const)("con %s se lee, sin «Responder», y se dice por qué", async (answer, text) => {
    mocks.teacherComments.mockResolvedValue({ kind: "ready", items: [thread(1)], next: null, write: answer });
    render(await at());
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Responder" })).toBeNull();
    expect(screen.getByRole("article", { name: "Ana" })).toBeInTheDocument();
  });

  it("con los comentarios cerrados en todo el producto, la pantalla lo dice", async () => {
    mocks.teacherComments.mockResolvedValue({ kind: "closed" });
    render(await at());
    expect(screen.getByText("Los comentarios están cerrados en toda la Escuela de Misterios por ahora.")).toBeInTheDocument();
  });

  it("vacío, y vacío con «Sin responder»", async () => {
    mocks.teacherComments.mockResolvedValue({ kind: "ready", items: [], next: null, write: null });
    const first = render(await at());
    expect(screen.getByText("Todavía nadie ha comentado tus lecciones.")).toBeInTheDocument();
    first.unmount();
    render(await at({ "sin-responder": "1" }));
    expect(screen.getByText("No tienes comentarios sin responder.")).toBeInTheDocument();
  });

  it("«Ver más» por la dirección, sin perder los filtros", async () => {
    mocks.teacherComments.mockResolvedValue({ kind: "ready", items: [thread(1)], next: `${AT}_${id(1)}`, write: "ok" });
    render(await at({ curso: COURSE }));
    expect(screen.getByRole("link", { name: "Ver más comentarios" })).toHaveAttribute(
      "href",
      `/portal/comentarios?curso=${COURSE}&desde=${encodeURIComponent(`${AT}_${id(1)}`)}`,
    );
  });

  it("si no se supo, «Reintentar»; si dejó de ser maestro entre la guarda y la lectura, a la guarda otra vez", async () => {
    mocks.teacherComments.mockResolvedValue({ kind: "unavailable" });
    const failed = render(await at());
    expect(screen.getByRole("link", { name: /intentar/i })).toHaveAttribute("href", "/portal/comentarios");
    failed.unmount();
    mocks.teacherComments.mockResolvedValue({ kind: "not_teacher" });
    await expect(at()).rejects.toThrow("no encontrado");
  });

  it("si lo pulsado se fue con la respuesta, el foco va al título que se ve", async () => {
    let answer: (state: CommentsState) => void = () => {};
    mocks.action.mockReturnValue(new Promise<CommentsState>((resolve) => (answer = resolve)));
    render(await at());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Responder" }));
    (document.activeElement as HTMLElement | null)?.blur();
    answer({ attempt: 1, open: { kind: "none" }, notice: null, kept: null, written: null });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Comentarios" })).toHaveFocus(), { timeout: 3_000 });
  });

  it("al publicar desde PA-45, lo que la lista ya no pinta se dice arriba", async () => {
    mocks.action.mockResolvedValue({ attempt: 1, open: { kind: "none" }, notice: { at: { kind: "comment", id: id(50) }, kind: "published" }, kept: null, written: id(50) });
    mocks.teacherComments.mockResolvedValue({ kind: "ready", items: [thread(1)], next: null, write: "ok" });
    render(await at({ "sin-responder": "1" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Responder" }));
    await waitFor(() => expect(screen.getByText("Tu comentario se publicó.")).toBeInTheDocument(), { timeout: 3_000 });
  });

  // La guarda de `tests/setup/dom.ts` hace fallar la prueba si React avisa de dos llaves iguales.
  it("dos cursos con el mismo título no repiten la llave de sus enlaces", async () => {
    mocks.teacherCommentCourses.mockResolvedValue({
      kind: "ready",
      courses: [
        { id: COURSE, title: "Yoga suave" },
        { id: OTHER, title: "Yoga suave" },
      ],
    });
    render(await at());
    expect(within(screen.getByRole("navigation", { name: "Filtros" })).getAllByRole("link", { name: "Yoga suave" })).toHaveLength(2);
  });
});

describe("las respuestas que no caben, en PA-45", () => {
  const LAST = `${AT}_${id(2)}`;
  const withMore = () =>
    mocks.teacherComments.mockResolvedValue({
      kind: "ready",
      items: [thread(1, { replies: { items: [thread(2, { name: "Beto", body: "Respuesta 2" })], more: true } })],
      next: null,
      write: "ok",
    });

  it("«Ver más respuestas» se queda en PA-45, con los filtros y la página", async () => {
    withMore();
    render(await at({ curso: COURSE, desde: `${AT}_${id(9)}` }));
    expect(screen.getByRole("link", { name: "Ver más respuestas" })).toHaveAttribute(
      "href",
      `/portal/comentarios?curso=${COURSE}&desde=${encodeURIComponent(`${AT}_${id(9)}`)}&hilo=${id(1)}&respuestas=${encodeURIComponent(LAST)}#comentario-${id(1)}`,
    );
  });

  it("con ?hilo= de un comentario de la lista, pide las siguientes con la lección de ese comentario y las pinta en su lugar", async () => {
    mocks.teacherComments.mockResolvedValue({
      kind: "ready",
      items: [
        thread(5, { name: "Eva", lessonId: LESSON_2, courseSlug: "yoga" }),
        thread(1, { replies: { items: [thread(2, { name: "Beto", body: "Respuesta 2" })], more: true } }),
      ],
      next: null,
      write: "ok",
    });
    mocks.commentReplies.mockResolvedValue({ kind: "ready", items: [thread(3, { name: "Carla", body: "Respuesta 3" })], next: null });
    render(await at({ curso: COURSE, hilo: id(1), respuestas: LAST }));
    expect(mocks.commentReplies).toHaveBeenCalledExactlyOnceWith(claims, LESSON, id(1), LAST);
    expect(screen.getByText("Respuesta 3")).toBeInTheDocument();
    expect(screen.queryByText("Respuesta 2")).toBeNull();
    expect(screen.queryByRole("link", { name: "Ver más respuestas" })).toBeNull();
    expect(screen.getByRole("link", { name: "Ver las primeras respuestas" })).toHaveAttribute("href", `/portal/comentarios?curso=${COURSE}#comentario-${id(1)}`);
  });

  it("un cursor de respuestas sin forma no se pide: es como sin él", async () => {
    withMore();
    render(await at({ hilo: id(1), respuestas: "basura" }));
    expect(mocks.commentReplies).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Ver las primeras respuestas" })).toBeNull();
  });

  it("un envío sin JavaScript vuelve a lo que se veía: los filtros, la página y las respuestas del hilo", () => {
    const filters = { course: COURSE, unanswered: true, from: `${AT}_${id(9)}` };
    expect(teacherHereHref(filters, null, null)).toBe(`/portal/comentarios?curso=${COURSE}&sin-responder=1&desde=${encodeURIComponent(`${AT}_${id(9)}`)}`);
    expect(teacherHereHref(filters, id(1), LAST)).toBe(
      `/portal/comentarios?curso=${COURSE}&sin-responder=1&desde=${encodeURIComponent(`${AT}_${id(9)}`)}&hilo=${id(1)}&respuestas=${encodeURIComponent(LAST)}`,
    );
    expect(teacherHereHref({ course: null, unanswered: false, from: null }, id(1), LAST)).toBe(`/portal/comentarios?hilo=${id(1)}&respuestas=${encodeURIComponent(LAST)}`);
  });

  it("un ?hilo= que no está en la lista no se pide, y si no se supo, se quedan las primeras", async () => {
    withMore();
    const first = render(await at({ hilo: id(7), respuestas: LAST }));
    expect(mocks.commentReplies).not.toHaveBeenCalled();
    first.unmount();
    mocks.commentReplies.mockResolvedValue({ kind: "unavailable" });
    render(await at({ hilo: id(1), respuestas: LAST }));
    expect(screen.getByText("Respuesta 2")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ver las primeras respuestas" })).toBeNull();
  });
});
