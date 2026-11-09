import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommentsState } from "@/app/_comments/state";
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
  action: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireTeacher: mocks.requireTeacher }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: vi.fn() }));
vi.mock("@/services/comments/comments", () => ({ teacherComments: mocks.teacherComments, teacherCommentCourses: mocks.teacherCommentCourses }));
vi.mock("@/app/portal/_comentarios/actions", () => ({ teacherCommentAction: mocks.action }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import PortalRestPage from "@/app/portal/[...resto]/page";

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: null, issuedAt: 0 };
const TEACHER = "7e000000-0000-4000-8000-000000000001";
const COURSE = "d0000000-0000-4000-8000-000000000001";
const OTHER = "d0000000-0000-4000-8000-000000000002";
const LESSON = "b0000000-0000-4000-8000-000000000001";
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
    mocks.action.mockResolvedValue({ attempt: 1, open: { kind: "reply", parentId: id(1) }, notice: null, kept: null, written: null });
    render(await at());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Responder" }));
    const field = await screen.findByRole("textbox", { name: "Responde a Ana" });
    const data = new FormData(field.closest("form")!);
    expect(data.get("curso")).toBe("respirar");
    expect(data.get("leccion")).toBe(LESSON);
    expect(within(field.closest("form")!).getByRole("button", { name: "Responder" })).toHaveAttribute("value", `reply:${id(1)}`);
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
    ["suspended", "Por ahora no puedes escribir aquí como maestro de este curso. Puedes leer los comentarios."],
  ] as const)("con %s se lee, sin «Responder», y se dice por qué", async (answer, text) => {
    mocks.teacherComments.mockResolvedValue({ kind: "ready", items: [thread(1)], next: null, write: answer });
    render(await at());
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Responder" })).toBeNull();
    expect(screen.getByRole("article", { name: "Ana" })).toBeInTheDocument();
  });

  it("con los comentarios cerrados en toda la Plataforma, la pantalla lo dice", async () => {
    mocks.teacherComments.mockResolvedValue({ kind: "closed" });
    render(await at());
    expect(screen.getByText("Los comentarios están cerrados en toda la Plataforma por ahora.")).toBeInTheDocument();
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

  it("al publicar desde PA-45, lo que la lista ya no pinta se dice arriba", async () => {
    mocks.action.mockResolvedValue({ attempt: 1, open: { kind: "none" }, notice: { at: { kind: "comment", id: id(50) }, kind: "published" }, kept: null, written: id(50) });
    mocks.teacherComments.mockResolvedValue({ kind: "ready", items: [thread(1)], next: null, write: "ok" });
    render(await at({ "sin-responder": "1" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Responder" }));
    await waitFor(() => expect(screen.getByText("Tu comentario se publicó.")).toBeInTheDocument(), { timeout: 3_000 });
  });
});
