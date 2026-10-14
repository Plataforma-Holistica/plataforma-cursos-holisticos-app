import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de la pantalla de las prácticas y los niveles (PA-67), con los
// servicios simulados: qué le pasa cada una a su servicio, en qué orden, y qué hace con cada
// respuesta. Lo que el servicio hace de verdad lo prueba su prueba de integración.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  const unavailable = () => Promise.resolve<unknown>({ kind: "unavailable" });
  return {
    giveCatalogCode: logged("giveCatalogCode", unavailable),
    addItem: logged("addItem", unavailable),
    renameItem: logged("renameItem", unavailable),
    moveItem: logged("moveItem", unavailable),
    setItemActive: logged("setItemActive", unavailable),
    leaveNotice: logged("leaveNotice", () => undefined),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/catalog/catalog", () => ({
  giveCatalogCode: mocks.giveCatalogCode,
  addItem: mocks.addItem,
  renameItem: mocks.renameItem,
  moveItem: mocks.moveItem,
  setItemActive: mocks.setItemActive,
}));
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { catalogCodeAction, levelsAction, practicesAction } from "@/app/admin/_practicas/actions";
import { catalogButton } from "@/app/admin/_practicas/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const ITEM = "b0000000-0000-4000-8000-000000000002";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}
const pressed = (value: string, extra: [string, string][] = []) => form([["do", value], ...extra]);

/** Lo que contesta la siguiente llamada a esa simulación. */
function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("dar el código otra vez", () => {
  const codeForm = (code: string) => form([["code", code]]);

  it("le pasa al servicio del catálogo el tarro de esta petición y el código tal como llegó", async () => {
    once("giveCatalogCode", { kind: "wrong_code" });
    await catalogCodeAction(IDLE, codeForm("123 456"));
    expect(mocks.giveCatalogCode).toHaveBeenCalledExactlyOnceWith(jar, "123 456");
  });

  it("un código sin forma no llega al servicio", async () => {
    expect(await catalogCodeAction(IDLE, codeForm("12a456"))).toEqual({ kind: "invalid", problem: "invalid", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("verificado: redirige a esta página, no a la del equipo", async () => {
    once("giveCatalogCode", { kind: "verified" });
    await expect(catalogCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /admin/practicas");
    expect(calls.order).toEqual(["giveCatalogCode", "redirect"]);
  });

  it("el freno rechazó: a entrar con su aviso", async () => {
    once("giveCatalogCode", { kind: "throttled" });
    await expect(catalogCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /entrar");
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "second_factor_throttled");
  });

  it("el código no vuelve en la respuesta", async () => {
    once("giveCatalogCode", { kind: "wrong_code" });
    const state = await catalogCodeAction(IDLE, codeForm("123456"));
    expect(JSON.stringify(state)).not.toContain("123456");
  });
});

describe("cada lista tiene su acción, que dice de qué lista se trata", () => {
  it.each([
    ["practices", practicesAction],
    ["levels", levelsAction],
  ] as const)("%s", async (list, action) => {
    once("setItemActive", { kind: "answered", answer: "deactivated" });
    await action(IDLE, pressed(catalogButton.deactivate(ITEM), [["list", list === "practices" ? "levels" : "practices"]]));
    // Un campo «list» en el formulario no cuenta: la lista es la de la acción.
    expect(mocks.setItemActive).toHaveBeenCalledExactlyOnceWith(jar, { list, id: ITEM, active: false });
  });
});

describe("lo que no llama a nadie", () => {
  it("«Renombrar» abre la fila, sin preguntarle nada a nadie ni volver a pedir la página", async () => {
    expect(await practicesAction(IDLE, pressed(catalogButton.rename(ITEM)))).toEqual({ kind: "renaming", id: ITEM, name: null, problem: null, attempt: 1 });
    expect(calls.order).toEqual([]);
    expect(mocks.cookieJar).not.toHaveBeenCalled();
  });

  it("«Cancelar» y un envío que no se entiende vuelven a reposo", async () => {
    expect(await practicesAction({ kind: "renaming", id: ITEM, name: null, problem: null, attempt: 2 }, pressed(catalogButton.cancel()))).toEqual(IDLE);
    expect(await practicesAction(IDLE, form([["name", "Yoga"]]))).toEqual(IDLE);
    expect(await practicesAction(IDLE, pressed(`borrar:${ITEM}`))).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it.each([
    ["vacío", "", "required"],
    ["demasiado largo", "a".repeat(41), "too_long"],
    ["con un carácter que no se ve", "Yo\u200bga", "invalid"],
  ] as const)("agregar un nombre %s: se dice en su campo, con lo escrito, sin llamar a nadie", async (_what, name, problem) => {
    expect(await practicesAction(IDLE, pressed(catalogButton.add(), [["name", name]]))).toEqual({ kind: "add_invalid", name, problem, attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("guardar un nombre sin forma: la fila sigue abierta con lo escrito, sin llamar a nadie", async () => {
    expect(await levelsAction(IDLE, pressed(catalogButton.save(ITEM), [["name", "   "]]))).toEqual({
      kind: "renaming",
      id: ITEM,
      name: "   ",
      problem: "required",
      attempt: 1,
    });
    expect(calls.order).toEqual([]);
  });
});

describe("lo que sí le pregunta al servicio", () => {
  it("agregar: el nombre tal como llegó, y la página se vuelve a pedir", async () => {
    once("addItem", { kind: "answered", answer: "added", id: ITEM });
    expect(await practicesAction(IDLE, pressed(catalogButton.add(), [["name", " Yoga "]]))).toEqual({
      kind: "done",
      what: "added",
      id: ITEM,
      name: "Yoga",
      direction: null,
      attempt: 1,
    });
    expect(mocks.addItem).toHaveBeenCalledExactlyOnceWith(jar, { list: "practices", name: " Yoga " });
    expect(calls.order).toEqual(["addItem", "refresh"]);
  });

  it("guardar el nombre nuevo de la fila del botón", async () => {
    once("renameItem", { kind: "answered", answer: "duplicate" });
    expect(await levelsAction(IDLE, pressed(catalogButton.save(ITEM), [["name", "Medio"]]))).toEqual({
      kind: "renaming",
      id: ITEM,
      name: "Medio",
      problem: "duplicate",
      attempt: 1,
    });
    expect(mocks.renameItem).toHaveBeenCalledExactlyOnceWith(jar, { list: "levels", id: ITEM, name: "Medio" });
    expect(calls.order).toEqual(["renameItem", "refresh"]);
  });

  it("mover lleva la posición que se vio", async () => {
    once("moveItem", { kind: "changed" });
    expect(await practicesAction(IDLE, pressed(catalogButton.down(ITEM, 7)))).toEqual({ kind: "failed", reason: "list_changed", name: null, attempt: 1 });
    expect(mocks.moveItem).toHaveBeenCalledExactlyOnceWith(jar, { list: "practices", id: ITEM, direction: "down", position: 7 });
  });

  it.each([
    ["sin cambios", { kind: "answered", answer: "unchanged" }],
    ["no se supo", { kind: "unknown" }],
    ["sin servicio", { kind: "unavailable" }],
  ])("%s: la página también se vuelve a pedir, porque la lista pudo cambiar", async (_what, answer) => {
    once("setItemActive", answer);
    await practicesAction(IDLE, pressed(catalogButton.reactivate(ITEM)));
    expect(calls.order).toEqual(["setItemActive", "refresh"]);
  });

  it.each([
    ["la guarda no dejó", { kind: "refused" }],
    ["la base dice que no tiene Contenido", { kind: "answered", answer: "forbidden" }],
  ])("%s: a esta página, donde decide la guarda, sin volver a pedirla", async (_what, answer) => {
    once("setItemActive", answer);
    await expect(practicesAction(IDLE, pressed(catalogButton.deactivate(ITEM)))).rejects.toThrow("redirige a /admin/practicas");
    expect(calls.order).toEqual(["setItemActive", "redirect"]);
  });

  it("el número de intento sigue al anterior, y nada más del estado anterior se lee", async () => {
    once("setItemActive", { kind: "answered", answer: "deactivated" });
    const state = await practicesAction({ kind: "failed", reason: "unknown", name: "otra", attempt: 4 }, pressed(catalogButton.deactivate(ITEM)));
    expect(state).toEqual({ kind: "done", what: "deactivated", id: ITEM, name: null, direction: null, attempt: 5 });
  });
});
