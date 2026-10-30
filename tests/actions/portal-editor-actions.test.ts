import { beforeEach, describe, expect, it, vi } from "vitest";

// La acción del editor de curso (T-402; PA-43), con los servicios simulados: qué le pasa a cada servicio,
// en qué orden, y qué hace con cada respuesta. Lo que el servicio hace de verdad lo prueban
// tests/integration/72-borrador.test.ts y la 73.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  const unknown = () => Promise.resolve<unknown>({ kind: "unknown" });
  return {
    saveCourse: logged("saveCourse", unknown),
    addModule: logged("addModule", unknown),
    addLesson: logged("addLesson", unknown),
    moveModule: logged("moveModule", unknown),
    moveLesson: logged("moveLesson", unknown),
    renameModule: logged("renameModule", unknown),
    deleteModule: logged("deleteModule", unknown),
    saveLesson: logged("saveLesson", unknown),
    deleteLesson: logged("deleteLesson", unknown),
    signOut: logged("signOut", () => Promise.resolve()),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/drafts/editor", () => ({
  saveCourse: mocks.saveCourse,
  addModule: mocks.addModule,
  addLesson: mocks.addLesson,
  moveModule: mocks.moveModule,
  moveLesson: mocks.moveLesson,
  renameModule: mocks.renameModule,
  deleteModule: mocks.deleteModule,
  saveLesson: mocks.saveLesson,
  deleteLesson: mocks.deleteLesson,
}));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { editorAction } from "@/app/portal/_editor/actions";
import { editorButton, moveTarget } from "@/app/portal/_editor/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const COURSE = "c0000000-0000-4000-8000-000000000001";
const MODULE = "d0000000-0000-4000-8000-000000000001";
const OTHER = "d0000000-0000-4000-8000-000000000002";
const LESSON = "e0000000-0000-4000-8000-000000000001";
const PRACTICE = "f0000000-0000-4000-8000-000000000001";
const BASE = `/portal/cursos/${COURSE}`;

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  data.append("course", COURSE);
  for (const [name, value] of entries) data.append(name, value);
  return data;
}
function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("los datos del curso", () => {
  const save = (title = "Respirar") =>
    form([["do", editorButton.saveCourse(4)], ["title", title], ["summary", ""], ["practice", PRACTICE], ["level", ""]]);

  it("le pasa al servicio lo que llegó con la revisión del botón; guardado, lo dice y vuelve a leer", async () => {
    once("saveCourse", { kind: "saved" });
    expect(await editorAction(IDLE, save())).toEqual({ kind: "done", what: "saved", target: "course", attempt: 1 });
    expect(mocks.saveCourse).toHaveBeenCalledExactlyOnceWith(jar, { course: COURSE, seen: 4, title: "Respirar", summary: "", practiceId: PRACTICE, levelId: null });
    expect(calls.order).toEqual(["saveCourse", "refresh"]);
  });

  it("un título sin forma no llega al servicio, y vuelve con lo escrito", async () => {
    expect(await editorAction(IDLE, save(" "))).toEqual({
      kind: "invalid",
      problems: { title: "required" },
      values: { title: " ", summary: "", practice: PRACTICE, level: "" },
      target: "course",
      attempt: 1,
    });
    expect(mocks.saveCourse).not.toHaveBeenCalled();
  });

  it("una práctica que se desactivó se dice en su campo, con lo escrito", async () => {
    once("saveCourse", { kind: "practice_inactive" });
    expect(await editorAction(IDLE, save())).toMatchObject({ kind: "invalid", problems: { practice: "practice_inactive" }, values: { title: "Respirar" } });
  });

  it("si cambió en otra pestaña, lo dice y vuelve a leer, sin devolver lo escrito: se pinta lo de ahora", async () => {
    once("saveCourse", { kind: "changed" });
    expect(await editorAction(IDLE, save())).toEqual({ kind: "failed", reason: "changed", values: null, target: "course", attempt: 1 });
    expect(calls.order).toEqual(["saveCourse", "refresh"]);
  });

  it("«no se supo» nunca es guardado, y conserva lo escrito", async () => {
    expect(await editorAction(IDLE, save())).toMatchObject({ kind: "failed", reason: "unavailable", values: { title: "Respirar" } });
  });

  it("un maestro que se suspendió vuelve a la misma pantalla, donde decide la guarda", async () => {
    once("saveCourse", { kind: "suspended" });
    await expect(editorAction(IDLE, save())).rejects.toThrow(`redirige a ${BASE}`);
  });
});

describe("la estructura", () => {
  it("un módulo agregado se abre en el editor", async () => {
    once("addModule", { kind: "created", id: MODULE });
    await expect(editorAction(IDLE, form([["do", editorButton.addModule(2)], ["title", "Inicio"]]))).rejects.toThrow(`redirige a ${BASE}?modulo=${MODULE}#bloque-editor-modulo`);
    expect(mocks.addModule).toHaveBeenCalledExactlyOnceWith(jar, { course: COURSE, seen: 2, title: "Inicio" });
  });

  it("una lección agregada se abre en el editor", async () => {
    once("addLesson", { kind: "created", id: LESSON });
    await expect(editorAction(IDLE, form([["do", editorButton.addLesson(MODULE, 3)], ["title", "Una"]]))).rejects.toThrow(`redirige a ${BASE}?leccion=${LESSON}#bloque-editor-leccion`);
    expect(mocks.addLesson).toHaveBeenCalledExactlyOnceWith(jar, { course: COURSE, module: MODULE, seen: 3, title: "Una" });
  });

  it("el error de una lección nueva es de su módulo", async () => {
    expect(await editorAction(IDLE, form([["do", editorButton.addLesson(MODULE, 3)], ["title", ""]]))).toMatchObject({ kind: "invalid", target: MODULE });
    expect(await editorAction(IDLE, form([["do", editorButton.addModule(2)], ["title", ""]]))).toMatchObject({ kind: "invalid", target: "module" });
  });

  it("subir y mover llevan lo que se vio", async () => {
    once("moveModule", { kind: "moved" });
    expect(await editorAction(IDLE, form([["do", editorButton.moduleUp(MODULE, 2)]]))).toEqual({ kind: "done", what: "moved", target: "move", attempt: 1 });
    expect(mocks.moveModule).toHaveBeenCalledExactlyOnceWith(jar, { course: COURSE, module: MODULE, seenPosition: 2, toPosition: 1 });
    once("moveLesson", { kind: "moved" });
    await editorAction(IDLE, form([["do", editorButton.lessonMove(LESSON, MODULE, 1)], ["to", moveTarget(OTHER, 4)]]));
    expect(mocks.moveLesson).toHaveBeenCalledExactlyOnceWith(jar, { course: COURSE, lesson: LESSON, seen: { module: MODULE, position: 1 }, to: { module: OTHER, position: 4 } });
  });

  it("un «Subir» reenviado dice que cambió, no mueve dos veces", async () => {
    once("moveModule", { kind: "changed" });
    expect(await editorAction(IDLE, form([["do", editorButton.moduleUp(MODULE, 2)]]))).toMatchObject({ kind: "failed", reason: "changed" });
  });
});

describe("un módulo o una lección", () => {
  it("preguntar antes de borrar no llama a nadie", async () => {
    expect(await editorAction(IDLE, form([["do", editorButton.askDeleteLesson(LESSON)], ["title", "Una"], ["description", "Qué."]]))).toEqual({
      kind: "confirming",
      values: { title: "Una", description: "Qué." },
      attempt: 1,
    });
    expect(calls.order).toEqual([]);
  });

  it("cancelar no llama a nadie, y devuelve lo escrito", async () => {
    expect(await editorAction({ kind: "confirming", values: {}, attempt: 1 }, form([["do", editorButton.cancel()], ["title", "Una nueva"]]))).toEqual({
      kind: "kept",
      values: { title: "Una nueva", description: "" },
      attempt: 2,
    });
    expect(calls.order).toEqual([]);
  });

  it("borrada, deja los datos del curso", async () => {
    once("deleteLesson", { kind: "deleted" });
    await expect(editorAction(IDLE, form([["do", editorButton.deleteLesson(LESSON, 2)]]))).rejects.toThrow(`redirige a ${BASE}#bloque-editor-datos`);
    expect(mocks.deleteLesson).toHaveBeenCalledExactlyOnceWith(jar, { course: COURSE, lesson: LESSON, seen: 2 });
  });

  it("guardar una lección le pasa título y descripción, y al suspendido lo regresa a esa lección", async () => {
    once("saveLesson", { kind: "suspended" });
    await expect(editorAction(IDLE, form([["do", editorButton.saveLesson(LESSON, 2)], ["title", "Una"], ["description", "Qué."]]))).rejects.toThrow(
      `redirige a ${BASE}?leccion=${LESSON}`,
    );
    expect(mocks.saveLesson).toHaveBeenCalledExactlyOnceWith(jar, { course: COURSE, lesson: LESSON, seen: 2, title: "Una", description: "Qué." });
  });

  it("una sesión que ya no vale se cierra antes de irse", async () => {
    once("renameModule", { kind: "session", check: { kind: "must_sign_out", then: "sign_in" } });
    await expect(editorAction(IDLE, form([["do", editorButton.saveModule(MODULE, 3)], ["title", "Cierre"]]))).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["renameModule", "signOut", "redirect"]);
  });

  it("un formulario sin forma no llama a nadie", async () => {
    expect(await editorAction(IDLE, form([["do", "save-lesson:x:2"]]))).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });
});
