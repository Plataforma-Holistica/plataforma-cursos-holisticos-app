import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La tercera solicitud de T-402 en el editor de curso (PA-43): arrastrar con el teclado (Espacio toma la
// fila, las flechas la mueven, Espacio la suelta y Escape cancela; cada paso se anuncia), «Cambios sin
// guardar» en la barra, y el aviso al salir con algo escrito.

const actions = vi.hoisted(() => ({ editorAction: vi.fn() }));
vi.mock("@/app/portal/_editor/actions", () => actions);

import { editorView } from "@/app/portal/_editor/rows";
import { EditorScreen } from "@/app/portal/_editor/screen";
import type { DraftChoices, DraftCourse } from "@/services/drafts/editor";

import { a11yViolations } from "../setup/a11y";

const COURSE = "c0000000-0000-4000-8000-000000000001";
const M1 = "d0000000-0000-4000-8000-000000000001";
const M2 = "d0000000-0000-4000-8000-000000000002";
const L1 = "e0000000-0000-4000-8000-000000000001";
const L2 = "e0000000-0000-4000-8000-000000000002";
const L3 = "e0000000-0000-4000-8000-000000000003";

const draft: DraftCourse = {
  id: COURSE,
  state: "draft",
  version: 1,
  title: "Respirar",
  summary: null,
  practiceId: null,
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
        { id: L2, title: "Dos", description: null, position: 2, revision: 1 },
        { id: L3, title: "Tres", description: null, position: 3, revision: 1 },
      ],
    },
    { id: M2, title: "Cierre", position: 2, revision: 1, lessons: [] },
  ],
};
const choices: DraftChoices = { practices: [], levels: [] };

const show = (readOnly = false) => ({
  user: userEvent.setup(),
  ...render(<EditorScreen view={editorView(draft, choices, { readOnly, search: {}, now: new Date() })} />),
});
/** Lo que llegó a la acción: el botón de cada envío. */
const sent = () => actions.editorAction.mock.calls.map(([, form]) => (form as FormData).get("do"));
const voice = () => screen.getAllByRole("status").map((each) => each.textContent ?? "").join(" ");

beforeEach(() => {
  vi.clearAllMocks();
  actions.editorAction.mockResolvedValue({ kind: "done", what: "moved", target: "move", attempt: 1 });
});

describe("arrastrar con el teclado", () => {
  it("Espacio toma la lección, las flechas la mueven, Espacio la suelta: manda el lugar que se vio y el nuevo", async () => {
    const { user } = show();
    const handle = screen.getByRole("button", { name: "Arrastrar Una" });
    handle.focus();
    await user.keyboard(" ");
    expect(handle.getAttribute("aria-pressed")).toBe("true");
    expect(voice()).toContain("Tomaste Una, en el lugar 1 de 3.");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(voice()).toContain("Una, lugar 3 de 3.");
    expect(screen.getByText("Lugar 3 de 3")).toBeTruthy();
    await user.keyboard(" ");
    await waitFor(() => expect(sent()).toEqual([`lesson-to:${L1}:${M1}:1:${M1}:3`]));
    // Se dice cuando la base contestó, y el foco vuelve al asa para seguir con el teclado.
    await waitFor(() => expect(voice()).toContain("Soltaste Una en el lugar 3 de 3."));
    await waitFor(() => expect(screen.getByRole("button", { name: "Arrastrar Una" })).toHaveFocus());
  });

  it("con un envío en camino las asas siguen ahí, pero no hacen nada", async () => {
    let answer: (state: unknown) => void = () => undefined;
    actions.editorAction.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { user } = show();
    screen.getByRole("button", { name: "Arrastrar Una" }).focus();
    await user.keyboard(" {ArrowDown} ");
    await waitFor(() => expect(screen.getByRole("button", { name: "Arrastrar Dos" }).getAttribute("aria-disabled")).toBe("true"));
    screen.getByRole("button", { name: "Arrastrar Dos" }).focus();
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "Arrastrar Dos" }).getAttribute("aria-pressed")).toBe("false");
    answer({ kind: "done", what: "moved", target: "move", attempt: 1 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Arrastrar Dos" }).getAttribute("aria-disabled")).toBeNull());
    expect(sent()).toHaveLength(1);
  });

  it("si la base dice que cambió, no se anuncia que se soltó, y el foco se queda en el aviso del fallo", async () => {
    actions.editorAction.mockResolvedValueOnce({ kind: "failed", reason: "changed", values: null, target: "move", attempt: 1 });
    const { user } = show();
    screen.getByRole("button", { name: "Arrastrar Una" }).focus();
    await user.keyboard(" {ArrowDown} ");
    const failure = await screen.findByText(/Esto cambió mientras lo veías/);
    expect(voice()).not.toContain("Soltaste");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failure.closest("[tabindex='-1']")).toHaveFocus();
  });

  it("quien se fue a otro campo mientras se guardaba se queda ahí", async () => {
    let answer: (state: unknown) => void = () => undefined;
    actions.editorAction.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { user } = show();
    screen.getByRole("button", { name: "Arrastrar Una" }).focus();
    await user.keyboard(" {ArrowDown} ");
    const field = screen.getByRole("textbox", { name: "Título del curso" });
    await user.click(field);
    answer({ kind: "done", what: "moved", target: "move", attempt: 1 });
    await waitFor(() => expect(voice()).toContain("Soltaste Una"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(field).toHaveFocus();
  });

  it("un clic en el asa también la toma y la suelta (un lector de pantalla en modo exploración manda clics)", async () => {
    const { user } = show();
    const handle = screen.getByRole("button", { name: "Arrastrar Una" });
    await user.click(handle);
    expect(handle.getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{ArrowDown}");
    await user.click(handle);
    await waitFor(() => expect(sent()).toEqual([`lesson-to:${L1}:${M1}:1:${M1}:2`]));
  });

  it("un módulo se mueve igual, entre los módulos", async () => {
    const { user } = show();
    screen.getByRole("button", { name: "Arrastrar Cierre" }).focus();
    await user.keyboard(" {ArrowUp} ");
    await waitFor(() => expect(sent()).toEqual([`module-to:${M2}:2:1`]));
  });

  it("Escape cancela, y soltar en su mismo lugar tampoco manda nada", async () => {
    const { user } = show();
    const handle = screen.getByRole("button", { name: "Arrastrar Dos" });
    handle.focus();
    await user.keyboard(" {ArrowDown}{Escape}");
    expect(handle.getAttribute("aria-pressed")).toBe("false");
    expect(voice()).toContain("Dos se quedó en su lugar.");
    await user.keyboard(" {ArrowDown}{ArrowUp} ");
    expect(sent()).toEqual([]);
  });

  it("las asas explican cómo se usan y no rompen la accesibilidad; al suspendido no se le ofrecen", async () => {
    const { container } = show();
    const handle = screen.getByRole("button", { name: "Arrastrar Una" });
    expect(document.getElementById(handle.getAttribute("aria-describedby") ?? "")?.textContent).toContain("toma la fila");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al suspendido no se le ofrecen", () => {
    show(true);
    expect(screen.queryByRole("button", { name: /^Arrastrar / })).toBeNull();
  });
});

describe("cambios sin guardar", () => {
  const assign = vi.fn();
  const original = window.location;
  beforeEach(() => {
    // La dirección del editor: un enlace a otra cosa de la estructura es de la misma pantalla.
    const here = `${original.origin}/portal/cursos/${COURSE}`;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, href: here, origin: original.origin, pathname: `/portal/cursos/${COURSE}`, search: "", assign } });
  });
  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });

  it("la barra lo dice al escribir, y deja de decirlo al enviar", async () => {
    actions.editorAction.mockResolvedValue({ kind: "done", what: "saved", target: "course", attempt: 1 });
    const { user } = show();
    expect(screen.queryByText("Cambios sin guardar")).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Título del curso" }), " más");
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.queryByText("Cambios sin guardar")).toBeNull());
  });

  it("salir por un enlace con algo escrito pregunta; «Seguir editando» se queda y «Salir sin guardar» sale", async () => {
    const { user } = show();
    await user.type(screen.getByRole("textbox", { name: "Título del curso" }), " más");
    await user.click(screen.getAllByRole("link", { name: "Mis cursos" })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Salir sin guardar" });
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((each) => each.textContent)).toEqual(["Seguir editando", "Salir sin guardar"]);
    await user.click(within(dialog).getByRole("button", { name: "Seguir editando" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("link", { name: "Mis cursos" })[0] as HTMLElement);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Salir sin guardar" }));
    expect(assign).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\/portal\/cursos$/));
  });

  it("un envío que no se hizo deja lo escrito sin guardar", async () => {
    actions.editorAction.mockResolvedValue({ kind: "invalid", problems: { title: "too_long" }, values: { title: "x", summary: "", practice: "", level: "" }, target: "course", attempt: 1 });
    const { user } = show();
    await user.type(screen.getByRole("textbox", { name: "Título del curso" }), " más");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(actions.editorAction).toHaveBeenCalled());
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
  });

  it("un formulario que se lleva a otra pantalla (cerrar sesión) pregunta si hay algo sin guardar, y al salir se envía", async () => {
    const leave = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const user = userEvent.setup();
    render(
      <>
        <form data-leaves="all" onSubmit={leave}>
          <button type="submit">Cerrar sesión</button>
        </form>
        <EditorScreen view={editorView(draft, choices, { readOnly: false, search: {}, now: new Date() })} />
      </>,
    );
    await user.type(screen.getByRole("textbox", { name: "Título del curso" }), " más");
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(leave).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Salir sin guardar" })).getByRole("button", { name: "Salir sin guardar" }));
    expect(leave).toHaveBeenCalledOnce();
  });

  it("ir a otra lección con algo escrito solo en la estructura no pregunta: la estructura se queda", async () => {
    const { user } = show();
    await user.type(screen.getByRole("textbox", { name: "Título del módulo nuevo" }), "A medias");
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Dos" });
    let stopped = true;
    const spy = (event: Event) => {
      stopped = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", spy);
    await user.click(link);
    document.removeEventListener("click", spy);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stopped).toBe(false);
  });

  it("agregar un módulo lleva a lo agregado: lo suyo deja de estar sin guardar y el campo queda vacío", async () => {
    actions.editorAction.mockResolvedValueOnce({ kind: "idle" });
    const user = userEvent.setup();
    const view = (search: Record<string, string>) => editorView(draft, choices, { readOnly: false, search, now: new Date() });
    const { rerender } = render(<EditorScreen view={view({})} />);
    await user.type(screen.getByRole("textbox", { name: "Título del módulo nuevo" }), "Nuevo");
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Agregar módulo" }));
    await waitFor(() => expect(actions.editorAction).toHaveBeenCalled());
    // La acción redirige a lo agregado: la misma pantalla con otra cosa elegida.
    rerender(<EditorScreen view={view({ modulo: M2 })} />);
    await waitFor(() => expect(screen.queryByText("Cambios sin guardar")).toBeNull());
    expect((screen.getByRole("textbox", { name: "Título del módulo nuevo" }) as HTMLInputElement).value).toBe("");
  });

  it("agregar con algo sin guardar a la derecha pregunta, porque abrir lo agregado lo perdería", async () => {
    actions.editorAction.mockResolvedValue({ kind: "idle" });
    const { user } = show();
    await user.type(screen.getByRole("textbox", { name: "Título del curso" }), " más");
    await user.type(screen.getByRole("textbox", { name: "Título del módulo nuevo" }), "Nuevo");
    await user.click(screen.getByRole("button", { name: "Agregar módulo" }));
    expect(actions.editorAction).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Salir sin guardar" })).getByRole("button", { name: "Salir sin guardar" }));
    await waitFor(() => expect(sent()).toEqual(["add-module:3"]));
  });

  it("sin nada escrito, salir no pregunta", async () => {
    const { user } = show();
    await user.click(screen.getAllByRole("link", { name: "Mis cursos" })[0] as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
