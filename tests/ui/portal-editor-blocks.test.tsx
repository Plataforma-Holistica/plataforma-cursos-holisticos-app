import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Los bloques del editor de curso (PA-43; T-402) con su acción simulada: qué se pinta con cada respuesta.
// Lo que encontró la revisión del diff de la 82: lo escrito que sobrevive a la respuesta de otro
// formulario, lo que se pinta cuando otra pestaña cambió lo mismo, el aviso que se apaga al escribir, la
// confirmación que toma el foco y la práctica que se desactivó al guardar.

const actions = vi.hoisted(() => ({ editorAction: vi.fn() }));
vi.mock("@/app/portal/_editor/actions", () => actions);

import { editorView } from "@/app/portal/_editor/rows";
import { EditorScreen } from "@/app/portal/_editor/screen";
import type { DraftChoices, DraftCourse } from "@/services/drafts/editor";

const COURSE = "c0000000-0000-4000-8000-000000000001";
const M1 = "d0000000-0000-4000-8000-000000000001";
const M2 = "d0000000-0000-4000-8000-000000000002";
const L1 = "e0000000-0000-4000-8000-000000000001";
const P1 = "f0000000-0000-4000-8000-000000000001";
const P2 = "f0000000-0000-4000-8000-000000000002";

const draft: DraftCourse = {
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
  resources: [],
  videos: [],
  modules: [
    { id: M1, title: "Inicio", position: 1, revision: 5, lessons: [{ id: L1, title: "Una", description: null, position: 1, revision: 1 }] },
    { id: M2, title: "Cierre", position: 2, revision: 1, lessons: [] },
  ],
};
const choices: DraftChoices = {
  practices: [
    { id: P1, name: "Respiración", tone: 3, active: true },
    { id: P2, name: "Yoga", tone: 5, active: true },
  ],
  levels: [], resourceLimits: { maxBytes: 52428800, perPlace: 10 }, videoMaxBytes: 5368709120 };

const show = (search: Record<string, string> = {}, changes: Partial<DraftCourse> = {}) => ({
  user: userEvent.setup(),
  ...render(<EditorScreen view={editorView({ ...draft, ...changes }, choices, { readOnly: false, search, now: new Date() })} />),
});
const structure = () => within(screen.getByRole("region", { name: "Estructura del curso" }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("los bloques del editor", () => {
  it("lo que se escribe para una lección nueva sobrevive a «Bajar» en otro módulo", async () => {
    actions.editorAction.mockResolvedValueOnce({ kind: "done", what: "moved", target: "move", attempt: 1 });
    const { user } = show();
    const field = structure().getAllByRole("textbox", { name: "Título de la lección nueva" })[1] as HTMLInputElement;
    await user.type(field, "Para después");
    await user.click(structure().getByRole("button", { name: "Bajar Inicio" }));
    await waitFor(() => expect(structure().getByText("Movido.")).toBeTruthy());
    expect((structure().getAllByRole("textbox", { name: "Título de la lección nueva" })[1] as HTMLInputElement).value).toBe("Para después");
  });

  it("si otra pestaña cambió los datos, se pinta lo de ahora y no lo escrito", async () => {
    actions.editorAction.mockResolvedValueOnce({ kind: "failed", reason: "changed", values: null, target: "course", attempt: 1 });
    const { user } = show();
    const title = screen.getByRole("textbox", { name: "Título del curso" });
    await user.clear(title);
    await user.type(title, "Mío");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByText(/Esto cambió mientras lo veías/)).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "Título del curso" }) as HTMLInputElement).value).toBe("Respirar");
  });

  it("si no se supo, lo escrito se queda", async () => {
    actions.editorAction.mockResolvedValueOnce({ kind: "failed", reason: "unavailable", values: { title: "Mío", summary: "", practice: P1, level: "" }, target: "course", attempt: 1 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByText(/No pudimos hacerlo/)).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "Título del curso" }) as HTMLInputElement).value).toBe("Mío");
  });

  it("«Guardado» deja de decirse en cuanto se vuelve a escribir", async () => {
    actions.editorAction.mockResolvedValueOnce({ kind: "done", what: "saved", target: "course", attempt: 1 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByText("Guardado.")).toBeTruthy());
    const title = screen.getByRole("textbox", { name: "Título del curso" }) as HTMLInputElement;
    await user.type(title, " más");
    expect(screen.queryByText("Guardado.")).toBeNull();
    expect(title.value).toBe("Respirar más");
    expect(title).toHaveFocus();
  });

  it("una práctica que volvió y ya no está entre las opciones no se queda en blanco: vuelve la del borrador", async () => {
    const gone = "f0000000-0000-4000-8000-0000000000ff";
    actions.editorAction.mockResolvedValueOnce({
      kind: "invalid",
      problems: { practice: "practice_inactive" },
      values: { title: "Respirar", summary: "", practice: gone, level: "" },
      target: "course",
      attempt: 1,
    });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getAllByText("Esa práctica ya no está disponible. Elige otra.").length).toBeGreaterThan(0));
    expect((screen.getByRole("combobox", { name: /Práctica/ }) as HTMLSelectElement).value).toBe(P1);
  });

  it("pedir borrar una lección pinta la pregunta, que toma el foco, sin perder lo escrito", async () => {
    actions.editorAction.mockImplementationOnce((_previous: unknown, form: FormData) =>
      Promise.resolve({ kind: "confirming", values: { title: form.get("title"), description: form.get("description") }, attempt: 1 }),
    );
    const { user } = show({ leccion: L1 });
    const title = screen.getByRole("textbox", { name: "Título de la lección" });
    await user.type(title, " nueva");
    await user.click(screen.getByRole("button", { name: "Borrar lección" }));
    const question = await screen.findByText("Se borra la lección. No se puede deshacer.");
    await waitFor(() => expect(question.parentElement).toHaveFocus());
    expect((screen.getByRole("textbox", { name: "Título de la lección" }) as HTMLInputElement).value).toBe("Una nueva");
    expect(screen.getByRole("button", { name: "Borrar lección" }).getAttribute("value")).toBe(`delete-lesson:${L1}:1`);
  });

  it("después de cancelar un borrado, guardar se anota: el campo muestra lo guardado y no lo de antes", async () => {
    const echo = (kind: "confirming" | "kept") => (_previous: unknown, form: FormData) =>
      Promise.resolve({ kind, values: { title: String(form.get("title")), description: String(form.get("description")) }, attempt: 1 });
    actions.editorAction
      .mockImplementationOnce(echo("confirming"))
      .mockImplementationOnce(echo("kept"))
      // Las tres con el mismo número de intento: la memoria de cada formulario no debe depender de él.
      .mockResolvedValueOnce({ kind: "done", what: "saved", target: "item", attempt: 1 });
    const { user } = show({ leccion: L1 });
    const title = () => screen.getByRole("textbox", { name: "Título de la lección" }) as HTMLInputElement;
    await user.type(title(), " nueva");
    await user.click(screen.getByRole("button", { name: "Borrar lección" }));
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull());
    expect(title().value).toBe("Una nueva");
    await user.clear(title());
    await user.type(title(), "Dos");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByText("Guardado.")).toBeTruthy());
    // Guardado, se pinta lo leído (aquí, la vista de la prueba): nunca lo escrito antes de cancelar.
    expect(title().value).not.toBe("Una nueva");
  });
});
