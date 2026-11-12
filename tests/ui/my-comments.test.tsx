import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

import type { MyComment } from "@/services/comments/comments";

// «Mis comentarios» (PA-24; T-501; decisiones de Sergio del 2026-11-08): la página, con la guarda y el servicio simulados, y la
// lista que pinta, con su acción simulada. Lo que la base da de verdad lo prueban la 95 y la 103.

const mocks = vi.hoisted(() => ({ requireSession: vi.fn(), myComments: vi.fn(), shown: null as Record<string, unknown> | null }));
// La barra del alumno (T-616): sin accesos por rol ni correo, salvo que la prueba diga otra cosa.
vi.mock("@/app/_catalog/nav-facts", () => ({ studentNavFor: () => Promise.resolve({ access: { admin: false, portal: false }, email: null }) }));
vi.mock("@/app/_lib/guard", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/services/comments/comments", () => ({ myComments: mocks.myComments }));
vi.mock("@/app/(cuenta)/cuenta/comentarios/actions", () => ({ myCommentsAction: vi.fn() }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import MyCommentsPage from "@/app/(cuenta)/cuenta/comentarios/page";
import { MyCommentsScreen, type MyCommentsScreenProps } from "@/app/(cuenta)/cuenta/comentarios/screen";
import { IDLE_MINE, type MineState } from "@/app/(cuenta)/cuenta/comentarios/outcomes";

const LESSON = "a0000000-0000-4000-8000-000000000001";
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-11-03T18:00:00.000000+00:00";

function item(n: number, extra: Partial<MyComment> = {}): MyComment {
  return {
    id: id(n),
    revision: 1,
    body: `Texto ${n}`,
    state: "published",
    edited: false,
    createdAt: AT,
    isReply: false,
    courseTitle: "Respirar para dormir",
    lessonTitle: "Soltar los hombros",
    link: { slug: "respirar", lessonId: LESSON },
    ...extra,
  };
}

const claims = { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 };
const query = (params: Record<string, string | string[] | undefined>) => ({ searchParams: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ kind: "render", claims });
  mocks.myComments.mockResolvedValue({ kind: "ready", items: [item(1)], next: null });
});

describe("la página (PA-24)", () => {
  it("pide sesión con su ruta, y lee lo propio desde la página que diga la dirección", async () => {
    render(await MyCommentsPage(query({ desde: `${AT}_${id(9)}` })));
    expect(mocks.requireSession).toHaveBeenCalledExactlyOnceWith("/cuenta/comentarios");
    expect(mocks.myComments).toHaveBeenCalledExactlyOnceWith(claims, `${AT}_${id(9)}`);
    expect(screen.getByRole("heading", { level: 1, name: "Mis comentarios" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Cuenta" })).toHaveAttribute("href", "/cuenta");
  });

  it("una cuenta suspendida ve PA-35, y no se lee nada", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "suspended" });
    render(await MyCommentsPage(query({})));
    expect(screen.getByRole("heading", { level: 1, name: /suspendida/i })).toBeInTheDocument();
    expect(mocks.myComments).not.toHaveBeenCalled();
  });

  it("si no se pudo leer, la pantalla de «no se supo», con volver a intentar", async () => {
    mocks.myComments.mockResolvedValue({ kind: "unavailable" });
    render(await MyCommentsPage(query({})));
    expect(screen.queryByRole("heading", { level: 1, name: "Mis comentarios" })).toBeNull();
    expect(screen.getByRole("link", { name: /intentar/i })).toHaveAttribute("href", "/cuenta/comentarios");
  });
});

function show(props: Partial<MyCommentsScreenProps> = {}, action = vi.fn(async (): Promise<MineState> => ({ ...IDLE_MINE, attempt: 1 }))) {
  const view = render(<MyCommentsScreen items={[item(1)]} next={null} cursor={null} action={action} {...props} />);
  return { view, action, user: userEvent.setup() };
}

describe("la lista (PA-24)", () => {
  it("de cada comentario: la lección y el curso con su enlace, la fecha, el texto y «Borrar»", async () => {
    const { view } = show();
    const one = screen.getByRole("article", { name: "Soltar los hombros, Respirar para dormir" });
    expect(within(one).getByRole("link", { name: "Soltar los hombros" })).toHaveAttribute("href", `/cursos/respirar/lecciones/${LESSON}`);
    expect(within(one).getByText("Texto 1")).toBeInTheDocument();
    expect(within(one).getByText("3 de noviembre de 2026")).toBeInTheDocument();
    expect(within(one).getByRole("button", { name: "Borrar" })).toHaveAttribute("value", `ask-delete:${id(1)}`);
    expect(await a11yViolations(view.container)).toEqual([]);
  });

  it("lo que ya no se ve: sus títulos, sin enlace, y lo dice", () => {
    show({ items: [item(1, { link: null })] });
    const one = screen.getByRole("article", { name: "Soltar los hombros, Respirar para dormir" });
    expect(within(one).queryByRole("link")).toBeNull();
    expect(within(one).getByText("Esta lección ya no está disponible.")).toBeInTheDocument();
  });

  it("en revisión, editado y respuesta, cada uno lo dice", () => {
    show({ items: [item(1, { state: "in_review", edited: true, isReply: true })] });
    const one = screen.getByRole("article");
    expect(within(one).getByText("En revisión")).toBeInTheDocument();
    expect(within(one).getByText("Solo tú lo ves por ahora. Una persona del equipo lo va a leer.")).toBeInTheDocument();
    expect(within(one).getByText("editado")).toBeInTheDocument();
    expect(within(one).getByText("Respuesta")).toBeInTheDocument();
  });

  it("vacía en la primera página; sin más en otra, con el camino a la primera", () => {
    const first = show({ items: [] });
    expect(screen.getByText("Todavía no has escrito comentarios.")).toBeInTheDocument();
    first.view.unmount();
    show({ items: [], cursor: `${AT}_${id(9)}` });
    expect(screen.getByText("No hay más comentarios.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a los más recientes" })).toHaveAttribute("href", "/cuenta/comentarios");
  });

  it("«Ver más» por la dirección, y la página en que se está viaja en cada formulario", () => {
    const cursor = `${AT}_${id(9)}`;
    show({ next: `${AT}_${id(1)}`, cursor });
    expect(screen.getByRole("link", { name: "Ver más" })).toHaveAttribute("href", `/cuenta/comentarios?desde=${encodeURIComponent(`${AT}_${id(1)}`)}`);
    expect(new FormData(screen.getByRole("button", { name: "Borrar" }).closest("form")!).get("desde")).toBe(cursor);
  });

  it("borrar pregunta antes, con la revisión que se vio", async () => {
    const action = vi.fn(async (): Promise<MineState> => ({ ...IDLE_MINE, attempt: 1, asking: id(1) }));
    const { user } = show({ items: [item(1, { revision: 4 })] }, action);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Borrar tu comentario?" });
    expect(within(dialog).getByRole("button", { name: "Sí, borrarlo" })).toHaveAttribute("value", `delete:${id(1)}:4`);
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toHaveAttribute("value", "cancel");
  });

  it.each([
    [{ kind: "deleted", id: null }, "Borraste tu comentario."],
    [{ kind: "gone", id: null }, "Ese comentario ya no está."],
    [{ kind: "changed", id: id(1) }, "Este comentario cambió en otra pestaña. Revisa cómo quedó."],
    [{ kind: "unavailable", id: id(1) }, "No pudimos borrarlo. Vuelve a intentarlo."],
  ] as const)("después de borrar: %o se dice", async (notice, text) => {
    const action = vi.fn(async (): Promise<MineState> => ({ ...IDLE_MINE, attempt: 1, notice }));
    const { user } = show({}, action);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument(), { timeout: 3_000 });
  });
});
