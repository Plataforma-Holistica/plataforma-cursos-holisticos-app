import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de las dos pantallas del segundo factor (PA-12), con los servicios
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
    giveSecondFactorCode: logged("giveSecondFactorCode", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    startSecondFactor: logged("startSecondFactor", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    confirmSecondFactor: logged("confirmSecondFactor", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    signOut: logged("signOut", () => Promise.resolve("closed")),
    forgetBrowserProofs: logged("forgetBrowserProofs", () => undefined),
    leaveNotice: logged("leaveNotice", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/account/account", () => ({
  giveSecondFactorCode: mocks.giveSecondFactorCode,
  startSecondFactor: mocks.startSecondFactor,
  confirmSecondFactor: mocks.confirmSecondFactor,
  signOut: mocks.signOut,
  forgetBrowserProofs: mocks.forgetBrowserProofs,
}));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { giveCodeAction } from "@/app/(cuenta)/entrar/segundo-factor/actions";
import { confirmSecondFactorAction, startSecondFactorAction } from "@/app/(cuenta)/entrar/segundo-factor/configurar/actions";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const FACTOR = "22222222-2222-4222-8222-222222222222";
const SECRET = "JBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/x?secret=${SECRET}`;

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
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

describe("dar el código (PA-12, pedir)", () => {
  const codeForm = (code: string, extra: [string, string][] = []) => form([["code", code], ["volver", "/admin/equipo"], ...extra]);

  it("le pasa al servicio el tarro de esta petición y el código tal como llegó, y nada más del formulario", async () => {
    once("giveSecondFactorCode", { kind: "wrong_code" });
    await giveCodeAction(IDLE, codeForm("123 456", [["factor", FACTOR], ["painted", FACTOR]]));
    expect(mocks.giveSecondFactorCode).toHaveBeenCalledExactlyOnceWith(jar, "123 456");
    expect(mocks.cookieJar).toHaveBeenCalledOnce();
  });

  it.each([
    ["", "required"],
    ["   ", "required"],
    ["12345", "invalid"],
    ["12a456", "invalid"],
    ["123-456", "invalid"],
  ] as const)("un código sin forma (%j) no llega al servicio: no es un intento, y no cuenta en el freno", async (code, problem) => {
    expect(await giveCodeAction(IDLE, codeForm(code))).toEqual({ kind: "invalid", problem, attempt: 1 });
    expect(calls.order).toEqual([]);
    expect(mocks.cookieJar).not.toHaveBeenCalled();
  });

  it("lo que no es un formulario cuenta como un código vacío, y tampoco llega al servicio", async () => {
    expect(await giveCodeAction(IDLE, "code=123456" as unknown as FormData)).toEqual({ kind: "invalid", problem: "required", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("el código vale: va al destino guardado, sin cerrar nada ni dejar aviso", async () => {
    once("giveSecondFactorCode", { kind: "verified" });
    await expect(giveCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /admin/equipo");
    expect(calls.order).toEqual(["giveSecondFactorCode", "redirect"]);
  });

  it("un destino que no vale no se sigue: con el código dado va a administración", async () => {
    once("giveSecondFactorCode", { kind: "verified" });
    await expect(giveCodeAction(IDLE, form([["code", "123456"], ["volver", "//otro.example"]]))).rejects.toThrow("redirige a /admin");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/admin");
  });

  it("el código no coincide: se pinta, con el intento que sigue, y el código no vuelve", async () => {
    once("giveSecondFactorCode", { kind: "wrong_code" });
    const state = await giveCodeAction({ kind: "failed", reason: "wrong_code", attempt: 3 }, codeForm("123456"));
    expect(state).toEqual({ kind: "failed", reason: "wrong_code", attempt: 4 });
    expect(JSON.stringify(state)).not.toContain("123456");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("del estado anterior solo se lee el número de intento", async () => {
    once("giveSecondFactorCode", { kind: "wrong_code" });
    const forged = { kind: "verified", attempt: 7, to: "/admin", code: "000000" } as never;
    expect(await giveCodeAction(forged, codeForm("123456"))).toEqual({ kind: "failed", reason: "wrong_code", attempt: 8 });
  });

  it("el freno rechazó: a entrar con su aviso, sin pedir otro cierre (Auth ya cerró todas)", async () => {
    once("giveSecondFactorCode", { kind: "throttled" });
    await expect(giveCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["giveSecondFactorCode", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "second_factor_throttled");
  });

  it("la sesión se perdió a media verificación: su cookie se borra, y va a entrar con su aviso", async () => {
    once("giveSecondFactorCode", { kind: "signed_out" });
    await expect(giveCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["giveSecondFactorCode", "signOut", "leaveNotice", "redirect"]);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "session_ended");
    // Salir por una sesión perdida no se lleva el resguardo del buzón.
    expect(mocks.forgetBrowserProofs).not.toHaveBeenCalled();
  });

  it("ya no está a un código de entrar: vuelve a la misma pantalla, donde la guarda decide", async () => {
    once("giveSecondFactorCode", { kind: "not_member" });
    await expect(giveCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /entrar/segundo-factor?volver=%2Fadmin%2Fequipo");
    expect(calls.order).toEqual(["giveSecondFactorCode", "redirect"]);
  });

  it.each([
    [{ kind: "anonymous" }, "/entrar?volver=%2Fadmin%2Fequipo", ["giveSecondFactorCode", "redirect"]],
    [{ kind: "incomplete" }, "/consentimientos?volver=%2Fadmin%2Fequipo", ["giveSecondFactorCode", "redirect"]],
    [{ kind: "must_sign_out", then: "sign_in" }, "/entrar", ["giveSecondFactorCode", "signOut", "redirect"]],
    [{ kind: "must_sign_out", then: "recover" }, "/recuperar", ["giveSecondFactorCode", "signOut", "leaveNotice", "redirect"]],
  ])("lo que niega la guarda (%j) lleva a %s", async (result, to, order) => {
    once("giveSecondFactorCode", result);
    await expect(giveCodeAction(IDLE, codeForm("123456"))).rejects.toThrow(`redirige a ${to}`);
    expect(calls.order).toEqual(order);
  });

  it("cuenta suspendida y «no se supo» se pintan: nadie sale de la pantalla ni pierde su sesión", async () => {
    once("giveSecondFactorCode", { kind: "suspended" });
    expect(await giveCodeAction(IDLE, codeForm("123456"))).toEqual({ kind: "suspended" });
    once("giveSecondFactorCode", { kind: "unavailable" });
    expect(await giveCodeAction(IDLE, codeForm("123456"))).toEqual({ kind: "failed", reason: "unavailable", attempt: 1 });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});

describe("empezar a configurar el segundo factor (PA-12, configurar)", () => {
  it("le pasa al servicio el tarro de esta petición, y nada del formulario", async () => {
    once("startSecondFactor", { kind: "needs_mailbox_proof" });
    await startSecondFactorAction(IDLE);
    expect(mocks.startSecondFactor).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.cookieJar).toHaveBeenCalledOnce();
  });

  it("empezó: devuelve la clave, su dirección y el factor, para pintarse una vez", async () => {
    once("startSecondFactor", { kind: "started", factorId: FACTOR, secret: SECRET, uri: URI, qr: null });
    expect(await startSecondFactorAction({ kind: "unavailable", attempt: 2 })).toEqual({
      kind: "started",
      factorId: FACTOR,
      secret: SECRET,
      uri: URI,
      qr: null,
      attempt: 3,
    });
    expect(calls.order).toEqual(["startSecondFactor"]);
  });

  it("el código QR sale como dirección de datos en base64: es una imagen, no marcado", async () => {
    // Con lo que rompería una dirección sin codificar: `#` corta la imagen, y `%` y las comillas, también.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><!-- 100% #1 --><rect style="fill:#000000"/></svg>';
    once("startSecondFactor", { kind: "started", factorId: FACTOR, secret: SECRET, uri: URI, qr: svg });
    const state = await startSecondFactorAction(IDLE);
    if (state.kind !== "started") throw new Error(`No empezó: ${state.kind}`);
    expect(state.qr).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from((state.qr ?? "").split(",")[1] ?? "", "base64").toString("utf8")).toBe(svg);
  });

  it("del estado anterior solo se lee el número de intento", async () => {
    once("startSecondFactor", { kind: "unavailable" });
    const forged = { kind: "started", factorId: "otro", secret: "otra", uri: "otra", qr: null, attempt: 4 } as const;
    expect(await startSecondFactorAction(forged)).toEqual({ kind: "unavailable", attempt: 5 });
  });

  it.each([
    [{ kind: "needs_mailbox_proof" }, { kind: "needs_mailbox_proof" }],
    [{ kind: "needs_second_level" }, { kind: "needs_second_level" }],
    [{ kind: "suspended" }, { kind: "suspended" }],
    [{ kind: "unavailable" }, { kind: "unavailable", attempt: 1 }],
  ])("%j se pinta, sin salir de la pantalla", async (result, expected) => {
    once("startSecondFactor", result);
    expect(await startSecondFactorAction(IDLE)).toEqual(expected);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "not_invited" }, "/entrar/segundo-factor/configurar", ["startSecondFactor", "redirect"]],
    [{ kind: "anonymous" }, "/entrar", ["startSecondFactor", "redirect"]],
    [{ kind: "incomplete" }, "/consentimientos", ["startSecondFactor", "redirect"]],
    [{ kind: "must_sign_out", then: "sign_in" }, "/entrar", ["startSecondFactor", "signOut", "redirect"]],
    [{ kind: "must_sign_out", then: "recover" }, "/recuperar", ["startSecondFactor", "signOut", "leaveNotice", "redirect"]],
  ])("%j lleva a %s", async (result, to, order) => {
    once("startSecondFactor", result);
    await expect(startSecondFactorAction(IDLE)).rejects.toThrow(`redirige a ${to}`);
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(to);
    expect(calls.order).toEqual(order);
  });
});

describe("confirmar el segundo factor, que acepta la invitación (PA-12, configurar)", () => {
  const confirmForm = (extra: [string, string][] = []) => form([["code", "123 456"], ["painted", FACTOR], ...extra]);

  it("le pasa al servicio el código, el código dictado y lo pintado, y nada más del formulario", async () => {
    once("confirmSecondFactor", { kind: "wrong_code" });
    await confirmSecondFactorAction(IDLE, confirmForm([["handoff", "ab12-cd34"], ["factor", "otro"], ["secret", SECRET], ["volver", "/admin"]]));
    expect(mocks.confirmSecondFactor).toHaveBeenCalledExactlyOnceWith(jar, { code: "123 456", handoff: "ab12-cd34", painted: FACTOR });
  });

  it.each([
    ["", "required"],
    ["12345", "invalid"],
    ["12a456", "invalid"],
  ] as const)("un código sin forma (%j) no llega al servicio: no es un intento, y no cuenta en el freno", async (code, problem) => {
    expect(await confirmSecondFactorAction(IDLE, form([["code", code], ["painted", FACTOR]]))).toEqual({
      kind: "invalid",
      fields: { code: problem },
      attempt: 1,
    });
    expect(calls.order).toEqual([]);
    expect(mocks.cookieJar).not.toHaveBeenCalled();
  });

  it("aceptada: deja el aviso y va a entrar. No cierra nada: la base ya cerró la sesión y el servicio borró su cookie", async () => {
    once("confirmSecondFactor", { kind: "accepted" });
    await expect(confirmSecondFactorAction(IDLE, confirmForm())).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["confirmSecondFactor", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "second_factor_ready");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/entrar");
  });

  it("el código no coincide: se pinta en su campo, con el intento que sigue, y nada de lo enviado vuelve", async () => {
    once("confirmSecondFactor", { kind: "wrong_code" });
    const state = await confirmSecondFactorAction({ kind: "invalid", fields: {}, attempt: 2 }, confirmForm([["handoff", "ab12cd34"]]));
    expect(state).toEqual({ kind: "invalid", fields: { code: "wrong" }, attempt: 3 });
    expect(JSON.stringify(state)).not.toMatch(/123|ab12|2222/);
  });

  it("el código dictado: si no se escribió, falta; si se escribió, no es ese", async () => {
    once("confirmSecondFactor", { kind: "needs_handoff" });
    expect(await confirmSecondFactorAction(IDLE, confirmForm())).toEqual({ kind: "invalid", fields: { handoff: "required" }, attempt: 1 });
    once("confirmSecondFactor", { kind: "needs_handoff" });
    expect(await confirmSecondFactorAction(IDLE, confirmForm([["handoff", "ab12-cd34"]]))).toEqual({
      kind: "invalid",
      fields: { handoff: "wrong" },
      attempt: 1,
    });
  });

  it.each([
    [{ kind: "start_again" }, { kind: "start_again", attempt: 1 }],
    [{ kind: "needs_mailbox_proof" }, { kind: "needs_mailbox_proof" }],
    [{ kind: "suspended" }, { kind: "suspended" }],
    [{ kind: "unavailable" }, { kind: "unavailable", attempt: 1 }],
  ])("%j se pinta, sin salir de la pantalla", async (result, expected) => {
    once("confirmSecondFactor", result);
    expect(await confirmSecondFactorAction(IDLE, confirmForm())).toEqual(expected);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });

  it("el freno rechazó: a entrar con su aviso", async () => {
    once("confirmSecondFactor", { kind: "throttled" });
    await expect(confirmSecondFactorAction(IDLE, confirmForm())).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["confirmSecondFactor", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "second_factor_throttled");
  });

  it("la sesión se perdió a media verificación: su cookie se borra, y va a entrar con su aviso", async () => {
    once("confirmSecondFactor", { kind: "signed_out" });
    await expect(confirmSecondFactorAction(IDLE, confirmForm())).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["confirmSecondFactor", "signOut", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "session_ended");
    expect(mocks.forgetBrowserProofs).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "not_invited" }, "/entrar/segundo-factor/configurar", ["confirmSecondFactor", "redirect"]],
    [{ kind: "anonymous" }, "/entrar", ["confirmSecondFactor", "redirect"]],
    [{ kind: "incomplete" }, "/consentimientos", ["confirmSecondFactor", "redirect"]],
    [{ kind: "must_sign_out", then: "sign_in" }, "/entrar", ["confirmSecondFactor", "signOut", "redirect"]],
    [{ kind: "must_sign_out", then: "recover" }, "/recuperar", ["confirmSecondFactor", "signOut", "leaveNotice", "redirect"]],
  ])("%j lleva a %s", async (result, to, order) => {
    once("confirmSecondFactor", result);
    await expect(confirmSecondFactorAction(IDLE, confirmForm())).rejects.toThrow(`redirige a ${to}`);
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(to);
    expect(calls.order).toEqual(order);
  });

  it("ninguna respuesta lleva a administración: la sesión de equipo nace entrando de nuevo", async () => {
    const results = ["accepted", "throttled", "not_invited", "signed_out", "anonymous", "incomplete"].map((kind) => ({ kind }));
    for (const result of results) {
      once("confirmSecondFactor", result);
      await expect(confirmSecondFactorAction(IDLE, confirmForm())).rejects.toThrow(/redirige a \/(entrar|consentimientos)/);
    }
    for (const [to] of mocks.redirect.mock.calls) expect(to).not.toMatch(/^\/admin/);
  });
});
