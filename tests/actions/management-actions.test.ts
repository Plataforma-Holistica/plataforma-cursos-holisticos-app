import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de la pantalla de la cuenta (PA-25), con los servicios
// simulados: qué le pasa cada una a su servicio, en qué orden, y qué hace con cada
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
  return {
    changeName: logged("changeName", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    signOut: logged("signOut", () => Promise.resolve("closed")),
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
vi.mock("@/services/account/account", () => ({ changeName: mocks.changeName, signOut: mocks.signOut }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { changeNameAction } from "@/app/(cuenta)/cuenta/actions";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;

function nameForm(name: string, extra: [string, string][] = []): FormData {
  const data = new FormData();
  data.append("name", name);
  for (const [field, value] of extra) data.append(field, value);
  return data;
}

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

describe("cambiar el nombre (PA-25)", () => {
  it("le pasa al servicio el tarro de esta petición y el nombre tal como llegó, y nada más del formulario", async () => {
    once("changeName", { kind: "saved", name: "Ana" });
    await changeNameAction(IDLE, nameForm("  Ana ", [["volver", "//otro.example"], ["profile", "otra-cuenta"]]));
    expect(mocks.changeName).toHaveBeenCalledExactlyOnceWith(jar, { name: "  Ana " });
  });

  it("guardado: pide la página de nuevo y contesta con el nombre como quedó", async () => {
    once("changeName", { kind: "saved", name: "Ana" });
    expect(await changeNameAction(IDLE, nameForm("  Ana "))).toEqual({ kind: "saved", name: "Ana", attempt: 1 });
    expect(calls.order).toEqual(["changeName", "refresh"]);
  });

  it.each(["empty", "too_long", "invalid"] as const)("un nombre que no se puede guardar (%s): lo marca y conserva lo escrito", async (reason) => {
    once("changeName", { kind: "invalid", reason });
    expect(await changeNameAction(IDLE, nameForm(" ... "))).toEqual({ kind: "invalid", name: " ... ", problem: reason, attempt: 1 });
    expect(calls.order).toEqual(["changeName"]);
  });

  it("no se supo: lo dice, conserva lo escrito y no pide la página de nuevo", async () => {
    expect(await changeNameAction(IDLE, nameForm("Ana"))).toEqual({ kind: "unavailable", name: "Ana", attempt: 1 });
    expect(calls.order).toEqual(["changeName"]);
  });

  it("lo que no es un formulario llega al servicio como un nombre vacío: decide él", async () => {
    once("changeName", { kind: "invalid", reason: "empty" });
    expect(await changeNameAction(IDLE, "name=Ana" as unknown as FormData)).toEqual({
      kind: "invalid",
      name: "",
      problem: "empty",
      attempt: 1,
    });
    expect(mocks.changeName).toHaveBeenCalledExactlyOnceWith(jar, { name: "" });
  });

  it("del estado anterior solo lee el número de intento", async () => {
    once("changeName", { kind: "saved", name: "Ana" });
    const previous = { kind: "saved", name: "Otra persona", attempt: 4, profile: "otra-cuenta" } as never;
    expect(await changeNameAction(previous, nameForm("Ana"))).toEqual({ kind: "saved", name: "Ana", attempt: 5 });
    once("changeName", { kind: "saved", name: "Ana" });
    expect(await changeNameAction({ attempt: "x" } as never, nameForm("Ana"))).toMatchObject({ attempt: 1 });
  });

  it("cuenta suspendida: la pantalla pasa a PA-35, sin irse a ningún lado", async () => {
    once("changeName", { kind: "session", check: { kind: "suspended" } });
    expect(await changeNameAction(IDLE, nameForm("Ana"))).toEqual({ kind: "suspended" });
    expect(calls.order).toEqual(["changeName"]);
  });

  it("sin sesión: a entrar, para volver a la cuenta, sin cerrar nada", async () => {
    once("changeName", { kind: "session", check: { kind: "anonymous" } });
    await expect(changeNameAction(IDLE, nameForm("Ana"))).rejects.toThrow("redirige a /entrar?volver=%2Fcuenta");
    expect(calls.order).toEqual(["changeName", "redirect"]);
  });

  it("una sesión que la guarda rechaza se cierra, deja su aviso y solo entonces se va", async () => {
    once("changeName", { kind: "session", check: { kind: "must_sign_out", then: "recover" } });
    await expect(changeNameAction(IDLE, nameForm("Ana"))).rejects.toThrow("redirige a /recuperar");
    expect(calls.order).toEqual(["changeName", "signOut", "leaveNotice", "redirect"]);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "choose_password");

    calls.order = [];
    once("changeName", { kind: "session", check: { kind: "must_sign_out", then: "sign_in" } });
    await expect(changeNameAction(IDLE, nameForm("Ana"))).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["changeName", "signOut", "redirect"]);
  });
});
