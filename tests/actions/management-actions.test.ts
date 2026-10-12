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
    closeSession: logged("closeSession", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    closeOtherSessions: logged("closeOtherSessions", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    changePassword: logged("changePassword", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    signOut: logged("signOut", () => Promise.resolve("closed")),
    leaveNotice: logged("leaveNotice", () => undefined),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
    requestOrigin: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar, requestOrigin: mocks.requestOrigin }));
vi.mock("@/services/account/account", () => ({
  changeName: mocks.changeName,
  closeSession: mocks.closeSession,
  closeOtherSessions: mocks.closeOtherSessions,
  changePassword: mocks.changePassword,
  signOut: mocks.signOut,
}));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { changeNameAction, changePasswordAction, closeSessionsAction } from "@/app/(cuenta)/cuenta/actions";

const jar = { get: () => undefined, set: () => undefined };
const origin = { realIp: "198.18.0.1", userAgent: "Pruebas" };
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
  mocks.requestOrigin.mockResolvedValue(origin);
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

describe("cerrar sesiones (PA-25)", () => {
  const ID = "5e560000-0000-0000-0000-000000000001";

  function closeForm(target: string | null, extra: [string, string][] = []): FormData {
    const data = new FormData();
    if (target !== null) data.append("close", target);
    for (const [field, value] of extra) data.append(field, value);
    return data;
  }

  it("cerrar una: le pasa al servicio el tarro de esta petición y el identificador, y nada más del formulario", async () => {
    once("closeSession", { kind: "closed" });
    await closeSessionsAction(IDLE, closeForm(ID, [["keep", "otra"], ["profile", "otra-cuenta"], ["volver", "//otro.example"]]));
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(jar, { sessionId: ID });
    expect(mocks.closeOtherSessions).not.toHaveBeenCalled();
  });

  it("cerrar las demás: al servicio solo le llega el tarro. Cuál se queda lo sabe él", async () => {
    once("closeOtherSessions", { kind: "closed", count: 2 });
    await closeSessionsAction(IDLE, closeForm("others", [["keep", ID], ["session", ID]]));
    expect(mocks.closeOtherSessions).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.closeSession).not.toHaveBeenCalled();
  });

  it.each([
    ["una", ID, "closeSession", { kind: "closed" }, "one"],
    ["una que ya no estaba", ID, "closeSession", { kind: "not_found" }, "gone"],
    ["las demás", "others", "closeOtherSessions", { kind: "closed", count: 2 }, "others"],
  ] as const)("cerrada (%s): pide la página de nuevo y dice qué se cerró", async (_case, target, service, answer, what) => {
    once(service, answer);
    expect(await closeSessionsAction(IDLE, closeForm(target))).toEqual({ kind: "closed", what, attempt: 1 });
    expect(calls.order).toEqual([service, "refresh"]);
  });

  it.each([
    ["sin decir qué", closeForm(null)],
    ["con el campo vacío", closeForm("")],
    ["con algo más largo que un identificador", closeForm(`${ID}x`)],
    ["lo que no es un formulario", `close=${ID}` as unknown as FormData],
  ])("%s no se le pregunta nada a nadie", async (_case, input) => {
    expect(await closeSessionsAction(IDLE, input)).toEqual({ kind: "idle" });
    expect(calls.order).toEqual([]);
    expect(mocks.cookieJar).not.toHaveBeenCalled();
  });

  it("no se supo: lo dice y no pide la página de nuevo", async () => {
    expect(await closeSessionsAction(IDLE, closeForm(ID))).toEqual({ kind: "unavailable", attempt: 1 });
    expect(await closeSessionsAction(IDLE, closeForm("others"))).toEqual({ kind: "unavailable", attempt: 1 });
    expect(calls.order).toEqual(["closeSession", "closeOtherSessions"]);
  });

  it("del estado anterior solo lee el número de intento", async () => {
    once("closeSession", { kind: "closed" });
    const previous = { kind: "closed", what: "others", attempt: 4, keep: ID } as never;
    expect(await closeSessionsAction(previous, closeForm(ID))).toEqual({ kind: "closed", what: "one", attempt: 5 });
  });

  it("la sesión propia, mandada por aquí: se cierra con su cookie y se va a la portada", async () => {
    once("closeSession", { kind: "current" });
    await expect(closeSessionsAction(IDLE, closeForm(ID))).rejects.toThrow("redirige a /");
    expect(calls.order).toEqual(["closeSession", "signOut", "redirect"]);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("cuenta suspendida: la pantalla pasa a PA-35, sin irse a ningún lado", async () => {
    once("closeOtherSessions", { kind: "session", check: { kind: "suspended" } });
    expect(await closeSessionsAction(IDLE, closeForm("others"))).toEqual({ kind: "suspended" });
    expect(calls.order).toEqual(["closeOtherSessions"]);
  });

  it("sin sesión: a entrar, para volver a la cuenta, sin cerrar nada", async () => {
    once("closeSession", { kind: "session", check: { kind: "anonymous" } });
    await expect(closeSessionsAction(IDLE, closeForm(ID))).rejects.toThrow("redirige a /entrar?volver=%2Fcuenta");
    expect(calls.order).toEqual(["closeSession", "redirect"]);
  });

  it("una sesión que la guarda rechaza se cierra, deja su aviso y solo entonces se va", async () => {
    once("closeOtherSessions", { kind: "session", check: { kind: "must_sign_out", then: "recover" } });
    await expect(closeSessionsAction(IDLE, closeForm("others"))).rejects.toThrow("redirige a /recuperar");
    expect(calls.order).toEqual(["closeOtherSessions", "signOut", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "choose_password");
  });
});

describe("cambiar la contraseña (PA-25)", () => {
  const OLD = "la-de-antes-123";
  const NEW = "la-de-ahora-456";

  function passwordForm(current: string | null, next: string | null, extra: [string, string][] = []): FormData {
    const data = new FormData();
    if (current !== null) data.append("current", current);
    if (next !== null) data.append("password", next);
    for (const [field, value] of extra) data.append(field, value);
    return data;
  }

  it("le pasa al servicio el tarro, las dos contraseñas tal como llegaron y de dónde viene la petición, y nada más del formulario", async () => {
    once("changePassword", { kind: "changed" });
    await changePasswordAction(IDLE, passwordForm(` ${OLD} `, ` ${NEW} `, [["email", "otra@prueba.test"], ["volver", "//otro.example"]]));
    expect(mocks.changePassword).toHaveBeenCalledExactlyOnceWith(jar, { current: ` ${OLD} `, next: ` ${NEW} ` }, origin);
  });

  it("cambió: pide la página de nuevo, porque la sesión de este navegador ya es otra", async () => {
    once("changePassword", { kind: "changed" });
    expect(await changePasswordAction(IDLE, passwordForm(OLD, NEW))).toEqual({ kind: "changed", attempt: 1 });
    expect(calls.order).toEqual(["changePassword", "refresh"]);
  });

  it.each([
    [{ current: "mismatch" }],
    [{ current: "required", next: "too_short" }],
    [{ next: "same" }],
    [{ next: "weak" }],
  ] as const)("algo por corregir (%j): lo marca, y no pide la página de nuevo", async (fields) => {
    once("changePassword", { kind: "invalid", fields });
    expect(await changePasswordAction(IDLE, passwordForm(OLD, NEW))).toEqual({ kind: "invalid", fields, attempt: 1 });
    expect(calls.order).toEqual(["changePassword"]);
  });

  it("frenado, con el tope lleno y cuando no se supo: lo dice, sin irse a ningún lado", async () => {
    once("changePassword", { kind: "throttled", retryAt: new Date("2026-10-12T18:30:00.000Z") });
    expect(await changePasswordAction(IDLE, passwordForm(OLD, NEW))).toEqual({
      kind: "throttled",
      retryAt: "2026-10-12T18:30:00.000Z",
      attempt: 1,
    });
    once("changePassword", { kind: "capped" });
    expect(await changePasswordAction(IDLE, passwordForm(OLD, NEW))).toEqual({ kind: "failed", reason: "capped", attempt: 1 });
    expect(await changePasswordAction(IDLE, passwordForm(OLD, NEW))).toEqual({ kind: "failed", reason: "unavailable", attempt: 1 });
    expect(calls.order).toEqual(["changePassword", "changePassword", "changePassword"]);
  });

  it("una contraseña nunca vuelve en la respuesta, pase lo que pase", async () => {
    const answers = [
      { kind: "changed" },
      { kind: "invalid", fields: { current: "mismatch", next: "same" } },
      { kind: "throttled", retryAt: new Date("2026-10-12T18:30:00.000Z") },
      { kind: "capped" },
      { kind: "unavailable" },
      { kind: "session", check: { kind: "suspended" } },
    ];
    for (const answer of answers) {
      once("changePassword", answer);
      const state = JSON.stringify(await changePasswordAction(IDLE, passwordForm(OLD, NEW)));
      expect(state).not.toContain(OLD);
      expect(state).not.toContain(NEW);
    }
  });

  it("lo que no es un formulario llega al servicio como dos contraseñas vacías: decide él", async () => {
    once("changePassword", { kind: "invalid", fields: { current: "required", next: "too_short" } });
    expect(await changePasswordAction(IDLE, "current=x" as unknown as FormData)).toMatchObject({ kind: "invalid" });
    expect(mocks.changePassword).toHaveBeenCalledExactlyOnceWith(jar, { current: "", next: "" }, origin);
  });

  it("del estado anterior solo lee el número de intento", async () => {
    once("changePassword", { kind: "changed" });
    const previous = { kind: "invalid", fields: { current: "mismatch" }, attempt: 4, current: OLD } as never;
    expect(await changePasswordAction(previous, passwordForm(OLD, NEW))).toEqual({ kind: "changed", attempt: 5 });
    once("changePassword", { kind: "changed" });
    expect(await changePasswordAction({ attempt: "x" } as never, passwordForm(OLD, NEW))).toMatchObject({ attempt: 1 });
  });

  it("cuenta suspendida: la pantalla pasa a PA-35, sin irse a ningún lado", async () => {
    once("changePassword", { kind: "session", check: { kind: "suspended" } });
    expect(await changePasswordAction(IDLE, passwordForm(OLD, NEW))).toEqual({ kind: "suspended" });
    expect(calls.order).toEqual(["changePassword"]);
  });

  it("sin sesión: a entrar, para volver a la cuenta, sin cerrar nada", async () => {
    once("changePassword", { kind: "session", check: { kind: "anonymous" } });
    await expect(changePasswordAction(IDLE, passwordForm(OLD, NEW))).rejects.toThrow("redirige a /entrar?volver=%2Fcuenta");
    expect(calls.order).toEqual(["changePassword", "redirect"]);
  });

  it("una sesión que la guarda rechaza se cierra, deja su aviso y solo entonces se va", async () => {
    once("changePassword", { kind: "session", check: { kind: "must_sign_out", then: "recover" } });
    await expect(changePasswordAction(IDLE, passwordForm(OLD, NEW))).rejects.toThrow("redirige a /recuperar");
    expect(calls.order).toEqual(["changePassword", "signOut", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "choose_password");
  });

  // El servicio ya cerró todo y borró la cookie: la acción solo deja el aviso y se va.
  it.each([
    ["changed", "password_changed"],
    ["unknown", "password_unconfirmed"],
  ] as const)("si este navegador quedó sin sesión (%s): deja su aviso y se va a entrar, sin cerrar nada más", async (password, notice) => {
    once("changePassword", { kind: "signed_out", password });
    await expect(changePasswordAction(IDLE, passwordForm(OLD, NEW))).rejects.toThrow("redirige a /entrar?volver=%2Fcuenta");
    expect(calls.order).toEqual(["changePassword", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, notice);
  });
});
