import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de la pantalla del equipo (PA-86), con los servicios simulados:
// qué le pasa cada una a su servicio, en qué orden, y qué hace con cada respuesta. Lo que el
// servicio hace de verdad lo prueba su prueba de integración.

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
    giveFreshCode: logged("giveFreshCode", unavailable),
    inviteAdmin: logged("inviteAdmin", unavailable),
    reinviteAdmin: logged("reinviteAdmin", unavailable),
    revokeInvitation: logged("revokeInvitation", unavailable),
    grantCapability: logged("grantCapability", unavailable),
    revokeCapability: logged("revokeCapability", unavailable),
    prepareReset: logged("prepareReset", unavailable),
    resetSecondFactor: logged("resetSecondFactor", unavailable),
    signOut: logged("signOut", () => Promise.resolve("closed")),
    forgetBrowserProofs: logged("forgetBrowserProofs", () => undefined),
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
vi.mock("@/services/account/account", () => ({
  giveFreshCode: mocks.giveFreshCode,
  inviteAdmin: mocks.inviteAdmin,
  reinviteAdmin: mocks.reinviteAdmin,
  revokeInvitation: mocks.revokeInvitation,
  grantCapability: mocks.grantCapability,
  revokeCapability: mocks.revokeCapability,
  prepareReset: mocks.prepareReset,
  resetSecondFactor: mocks.resetSecondFactor,
  signOut: mocks.signOut,
  forgetBrowserProofs: mocks.forgetBrowserProofs,
}));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { freshCodeAction, invitationsAction, inviteAction, resetAction, teamAction } from "@/app/admin/_equipo/actions";
import { invitationButton, resetButton, teamButton, type TeamIntent } from "@/app/admin/_equipo/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const PERSON = "b0000000-0000-4000-8000-000000000002";
const INVITATION = "d0000000-0000-4000-8000-000000000004";
const CODE = "ABCD-EFGH-JKMN-PQRS";

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
  const codeForm = (code: string, extra: [string, string][] = []) => form([["code", code], ...extra]);

  it("le pasa al servicio el tarro de esta petición y el código tal como llegó, y nada más del formulario", async () => {
    once("giveFreshCode", { kind: "wrong_code" });
    await freshCodeAction(IDLE, codeForm("123 456", [["factor", PERSON], ["volver", "/inicio"]]));
    expect(mocks.giveFreshCode).toHaveBeenCalledExactlyOnceWith(jar, "123 456");
  });

  it.each([
    ["", "required"],
    ["   ", "required"],
    ["12345", "invalid"],
    ["12a456", "invalid"],
  ] as const)("un código sin forma (%j) no llega al servicio: no es un intento, y no cuenta en el freno", async (code, problem) => {
    expect(await freshCodeAction(IDLE, codeForm(code))).toEqual({ kind: "invalid", problem, attempt: 1 });
    expect(calls.order).toEqual([]);
    expect(mocks.cookieJar).not.toHaveBeenCalled();
  });

  it("verificado: redirige a esta misma página, sin pintar nada ni volver a pedirla", async () => {
    once("giveFreshCode", { kind: "verified" });
    await expect(freshCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /admin/equipo");
    expect(calls.order).toEqual(["giveFreshCode", "redirect"]);
  });

  it("no coincide: se pinta, con el intento que sigue, y el código no vuelve", async () => {
    once("giveFreshCode", { kind: "wrong_code" });
    const state = await freshCodeAction({ kind: "failed", reason: "wrong_code", attempt: 3 }, codeForm("123456"));
    expect(state).toEqual({ kind: "failed", reason: "wrong_code", attempt: 4 });
    expect(JSON.stringify(state)).not.toContain("123456");
  });

  it("el freno rechazó: a entrar con su aviso, sin pedir otro cierre (Auth ya cerró todas)", async () => {
    once("giveFreshCode", { kind: "throttled" });
    await expect(freshCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["giveFreshCode", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "second_factor_throttled");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("a quien la guarda no dejó se le manda a la página, donde decide ella", async () => {
    once("giveFreshCode", { kind: "refused" });
    await expect(freshCodeAction(IDLE, codeForm("123456"))).rejects.toThrow("redirige a /admin/equipo");
    expect(calls.order).toEqual(["giveFreshCode", "redirect"]);
  });

  it.each(["unavailable", "not_available"] as const)("%s se pinta en el bloque", async (reason) => {
    once("giveFreshCode", { kind: reason });
    expect(await freshCodeAction(IDLE, codeForm("123456"))).toEqual({ kind: "failed", reason, attempt: 1 });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("invitar", () => {
  const inviteForm = (email: string, capabilities: string[], extra: [string, string][] = []) =>
    form([["email", email], ...capabilities.map((each) => ["capability", each] as [string, string]), ...extra]);

  it("le pasa al servicio el correo y las casillas tal como llegaron, y nada que diga quién invita", async () => {
    once("inviteAdmin", { kind: "answered", answer: "invited_new" });
    await inviteAction(IDLE, inviteForm(" Ana@Prueba.test ", ["support", "config"], [["actor", PERSON], ["invitedBy", PERSON]]));
    expect(mocks.inviteAdmin).toHaveBeenCalledExactlyOnceWith(jar, { email: " Ana@Prueba.test ", capabilities: ["support", "config"] });
  });

  it("invitada: se dice a quién, como quedó guardado, y la página se vuelve a pedir", async () => {
    once("inviteAdmin", { kind: "answered", answer: "invited_existing" });
    expect(await inviteAction(IDLE, inviteForm(" Ana@Prueba.test ", ["support"]))).toEqual({
      kind: "done",
      answer: "invited_existing",
      email: "ana@prueba.test",
      attempt: 1,
    });
    expect(calls.order).toEqual(["inviteAdmin", "refresh"]);
  });

  it.each([
    [inviteForm("", ["support"]), { email: "required" }],
    [inviteForm("ana.prueba.test", ["support"]), { email: "invalid" }],
    [inviteForm("ana@prueba.test", []), { capabilities: true }],
    [inviteForm("", []), { email: "required", capabilities: true }],
  ])("lo que no tiene forma no le pregunta nada a nadie, y lo escrito vuelve", async (data, problems) => {
    const state = await inviteAction(IDLE, data);
    expect(state).toMatchObject({ kind: "invalid", problems, attempt: 1 });
    expect(state).toHaveProperty("email");
    expect(calls.order).toEqual([]);
    expect(mocks.cookieJar).not.toHaveBeenCalled();
  });

  it("lo que no es un formulario cuenta como vacío", async () => {
    expect(await inviteAction(IDLE, "email=ana@prueba.test" as unknown as FormData)).toMatchObject({
      kind: "invalid",
      problems: { email: "required", capabilities: true },
    });
    expect(calls.order).toEqual([]);
  });

  it.each([
    ["already_invited", "already_invited"],
    ["already_member", "already_member"],
    ["ineligible", "ineligible"],
    ["invalid", "invalid"],
    ["unavailable", "not_configured"],
    ["needs_fresh_code", "needs_code"],
  ])("la base contesta %s: se pinta, lo escrito vuelve y la página se vuelve a pedir", async (answer, reason) => {
    once("inviteAdmin", { kind: "answered", answer });
    expect(await inviteAction(IDLE, inviteForm("ana@prueba.test", ["support"]))).toEqual({
      kind: "failed",
      reason,
      email: "ana@prueba.test",
      capabilities: ["support"],
      attempt: 1,
    });
    expect(calls.order).toEqual(["inviteAdmin", "refresh"]);
  });

  it.each(["unavailable", "unknown"] as const)("%s nunca se pinta como hecho", async (kind) => {
    once("inviteAdmin", { kind });
    expect(await inviteAction(IDLE, inviteForm("ana@prueba.test", ["support"]))).toMatchObject({ kind: "failed", reason: kind });
  });

  it("lo que el servicio encontró sin forma se dice en su campo", async () => {
    once("inviteAdmin", { kind: "malformed", email: null, capabilities: true });
    expect(await inviteAction(IDLE, inviteForm("ana@prueba.test", ["owner"]))).toMatchObject({ kind: "invalid", problems: { capabilities: true } });
  });

  it.each([{ kind: "refused" }, { kind: "answered", answer: "forbidden" }])("sin permiso (%j): a la página, sin pintar nada", async (result) => {
    once("inviteAdmin", result);
    await expect(inviteAction(IDLE, inviteForm("ana@prueba.test", ["support"]))).rejects.toThrow("redirige a /admin/equipo");
    expect(calls.order).toEqual(["inviteAdmin", "redirect"]);
  });

  it("del estado anterior solo se lee el número de intento", async () => {
    once("inviteAdmin", { kind: "answered", answer: "invited_new" });
    const forged = { kind: "done", answer: "invited_new", email: "otra@prueba.test", attempt: 7 } as never;
    expect(await inviteAction(forged, inviteForm("ana@prueba.test", ["support"]))).toMatchObject({ email: "ana@prueba.test", attempt: 8 });
  });
});

describe("dar y quitar una capacidad", () => {
  const revoke: TeamIntent = { type: "revoke", profile: PERSON, capability: "support" };
  const grant: TeamIntent = { type: "grant", profile: PERSON, capability: "content" };

  it("preguntar no le pregunta nada a nadie: contesta «confirma», con a quién y qué", async () => {
    expect(await teamAction(IDLE, pressed(teamButton.ask(revoke)))).toEqual({ kind: "confirm", intent: revoke, changed: false, attempt: 1 });
    expect(calls.order).toEqual([]);
    expect(mocks.cookieJar).not.toHaveBeenCalled();
  });

  it.each([
    ["«Cancelar»", pressed(teamButton.cancel)],
    ["un envío sin botón", form([["profile", PERSON]])],
    ["más de una intención", form([["do", teamButton.ask(revoke)], ["do", teamButton.confirm(grant)]])],
    ["lo que no es un formulario", "do=cancel" as unknown as FormData],
  ])("%s deja el bloque como estaba, sin llamar a nadie", async (_what, data) => {
    expect(await teamAction({ kind: "confirm", intent: revoke, changed: false, attempt: 4 }, data)).toEqual({ kind: "idle" });
    expect(calls.order).toEqual([]);
  });

  it("dar: le pasa al servicio a quién y qué, tal como lo dice el botón", async () => {
    once("grantCapability", { kind: "answered", answer: "granted" });
    expect(await teamAction(IDLE, pressed(teamButton.confirm(grant), [["actor", PERSON]]))).toEqual({ kind: "done", what: "granted", attempt: 1 });
    expect(mocks.grantCapability).toHaveBeenCalledExactlyOnceWith(jar, { profile: PERSON, capability: "content" });
    expect(calls.order).toEqual(["grantCapability", "refresh"]);
  });

  it("quitar: le pasa además lo que se confirmó, para que el servicio lo compruebe", async () => {
    once("revokeCapability", { kind: "answered", answer: "revoked" });
    expect(await teamAction(IDLE, pressed(teamButton.confirm(revoke, "last")))).toEqual({ kind: "done", what: "revoked", attempt: 1 });
    expect(mocks.revokeCapability).toHaveBeenCalledExactlyOnceWith(jar, { profile: PERSON, capability: "support", confirmed: "last" });
    expect(mocks.grantCapability).not.toHaveBeenCalled();
    expect(calls.order).toEqual(["revokeCapability", "refresh"]);
  });

  it("a quién se le hace sale del botón, nunca del estado anterior", async () => {
    once("revokeCapability", { kind: "answered", answer: "revoked" });
    const other: TeamIntent = { type: "grant", profile: "c0000000-0000-4000-8000-000000000003", capability: "config" };
    await teamAction({ kind: "confirm", intent: other, changed: false, attempt: 2 }, pressed(teamButton.confirm(revoke)));
    expect(mocks.revokeCapability).toHaveBeenCalledExactlyOnceWith(jar, { profile: PERSON, capability: "support", confirmed: "" });
  });

  it("si lo confirmado ya no es lo que pasaría, vuelve a preguntar, con la lista de ahora", async () => {
    once("revokeCapability", { kind: "changed" });
    expect(await teamAction(IDLE, pressed(teamButton.confirm(revoke, "")))).toEqual({ kind: "confirm", intent: revoke, changed: true, attempt: 1 });
    expect(calls.order).toEqual(["revokeCapability", "refresh"]);
  });

  it("quitársela a una misma: a entrar con su aviso, sin cerrar nada (ya lo hizo el servicio)", async () => {
    once("revokeCapability", { kind: "revoked_self" });
    await expect(teamAction(IDLE, pressed(teamButton.confirm(revoke, "self")))).rejects.toThrow("redirige a /entrar");
    expect(calls.order).toEqual(["revokeCapability", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "capability_removed");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each([
    ["grantCapability", grant, "already_has", "already_has"],
    ["grantCapability", grant, "not_member", "not_member"],
    ["grantCapability", grant, "ineligible", "ineligible"],
    ["grantCapability", grant, "invalid", "invalid"],
    ["grantCapability", grant, "needs_fresh_code", "needs_code"],
    ["revokeCapability", revoke, "not_found", "not_held"],
    ["revokeCapability", revoke, "min_config", "min_config"],
    ["revokeCapability", revoke, "needs_fresh_code", "needs_code"],
  ] as const)("%s contesta %s: se pinta, y la página se vuelve a pedir", async (service, intent, answer, reason) => {
    once(service, { kind: "answered", answer });
    expect(await teamAction(IDLE, pressed(teamButton.confirm(intent)))).toEqual({ kind: "failed", reason, attempt: 1 });
    expect(calls.order).toEqual([service, "refresh"]);
  });

  it.each(["unavailable", "unknown"] as const)("%s nunca se pinta como hecho", async (kind) => {
    once("revokeCapability", { kind });
    expect(await teamAction(IDLE, pressed(teamButton.confirm(revoke)))).toEqual({ kind: "failed", reason: kind, attempt: 1 });
  });

  it.each([{ kind: "refused" }, { kind: "answered", answer: "forbidden" }])("sin permiso (%j): a la página, sin pintar nada", async (result) => {
    once("grantCapability", result);
    await expect(teamAction(IDLE, pressed(teamButton.confirm(grant)))).rejects.toThrow("redirige a /admin/equipo");
    expect(calls.order).toEqual(["grantCapability", "redirect"]);
  });
});

describe("las invitaciones", () => {
  it("preguntar por revocar no llama a nadie", async () => {
    expect(await invitationsAction(IDLE, pressed(invitationButton.ask(INVITATION)))).toEqual({ kind: "confirm", id: INVITATION, attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("revocar: le pasa al servicio cuál, y nada más", async () => {
    once("revokeInvitation", { kind: "answered", answer: "revoked" });
    expect(await invitationsAction(IDLE, pressed(invitationButton.revoke(INVITATION), [["email", "otra@prueba.test"]]))).toEqual({
      kind: "done",
      what: "revoked",
      attempt: 1,
    });
    expect(mocks.revokeInvitation).toHaveBeenCalledExactlyOnceWith(jar, { id: INVITATION });
    expect(calls.order).toEqual(["revokeInvitation", "refresh"]);
  });

  it("invitar de nuevo: del formulario solo llega cuál, nunca a quién ni con qué", async () => {
    once("reinviteAdmin", { kind: "answered", answer: "invited_new" });
    const data = pressed(invitationButton.reinvite(INVITATION), [["email", "otra@prueba.test"], ["capability", "config"]]);
    expect(await invitationsAction(IDLE, data)).toEqual({ kind: "done", what: "reinvited", attempt: 1 });
    expect(mocks.reinviteAdmin).toHaveBeenCalledExactlyOnceWith(jar, { id: INVITATION });
    expect(mocks.inviteAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ["revokeInvitation", invitationButton.revoke(INVITATION), { kind: "answered", answer: "not_found" }, "gone"],
    ["revokeInvitation", invitationButton.revoke(INVITATION), { kind: "answered", answer: "needs_fresh_code" }, "needs_code"],
    ["revokeInvitation", invitationButton.revoke(INVITATION), { kind: "unknown" }, "unknown"],
    ["reinviteAdmin", invitationButton.reinvite(INVITATION), { kind: "gone" }, "gone"],
    ["reinviteAdmin", invitationButton.reinvite(INVITATION), { kind: "answered", answer: "already_member" }, "already_member"],
    ["reinviteAdmin", invitationButton.reinvite(INVITATION), { kind: "answered", answer: "unavailable" }, "not_configured"],
    ["reinviteAdmin", invitationButton.reinvite(INVITATION), { kind: "unavailable" }, "unavailable"],
  ] as const)("%s con %s contesta %j: se pinta %s", async (service, button, result, reason) => {
    once(service, result);
    expect(await invitationsAction(IDLE, pressed(button))).toEqual({ kind: "failed", reason, attempt: 1 });
  });

  it("«Cancelar», o un envío que no se entiende, no llama a nadie", async () => {
    expect(await invitationsAction(IDLE, pressed(invitationButton.cancel))).toEqual({ kind: "idle" });
    expect(await invitationsAction(IDLE, pressed("confirm:revoke:la-de-ana"))).toEqual({ kind: "idle" });
    expect(calls.order).toEqual([]);
  });

  it("sin permiso: a la página", async () => {
    once("revokeInvitation", { kind: "refused" });
    await expect(invitationsAction(IDLE, pressed(invitationButton.revoke(INVITATION)))).rejects.toThrow("redirige a /admin/equipo");
  });
});

describe("restablecer un segundo factor", () => {
  it("elegir: el servicio deja el testigo, y se pregunta. Todavía no se restablece nada", async () => {
    once("prepareReset", { kind: "ready" });
    expect(await resetAction(IDLE, pressed(resetButton.choose(PERSON)))).toEqual({ kind: "confirm", profile: PERSON, changed: false, attempt: 1 });
    expect(mocks.prepareReset).toHaveBeenCalledExactlyOnceWith(jar, { profile: PERSON });
    expect(mocks.resetSecondFactor).not.toHaveBeenCalled();
    expect(calls.order).toEqual(["prepareReset", "refresh"]);
  });

  it("confirmar: le pasa al servicio a quién y lo que se confirmó, y devuelve el código una vez", async () => {
    once("resetSecondFactor", { kind: "reset", code: CODE });
    expect(await resetAction(IDLE, pressed(resetButton.confirm(PERSON, "alone")))).toEqual({ kind: "code", code: CODE, attempt: 1 });
    expect(mocks.resetSecondFactor).toHaveBeenCalledExactlyOnceWith(jar, { profile: PERSON, confirmed: "alone" });
    expect(mocks.prepareReset).not.toHaveBeenCalled();
    expect(calls.order).toEqual(["resetSecondFactor", "refresh"]);
  });

  it("a quién se restablece sale del botón, nunca del estado anterior", async () => {
    once("resetSecondFactor", { kind: "reset", code: CODE });
    const before = { kind: "confirm", profile: "c0000000-0000-4000-8000-000000000003", changed: false, attempt: 2 } as const;
    await resetAction(before, pressed(resetButton.confirm(PERSON, "")));
    expect(mocks.resetSecondFactor).toHaveBeenCalledExactlyOnceWith(jar, { profile: PERSON, confirmed: "" });
  });

  it("el código de una respuesta anterior no vuelve en la siguiente", async () => {
    once("resetSecondFactor", { kind: "already_sent" });
    const state = await resetAction({ kind: "code", code: CODE, attempt: 1 }, pressed(resetButton.confirm(PERSON, "")));
    expect(state).toEqual({ kind: "failed", reason: "already_sent", attempt: 2 });
    expect(JSON.stringify(state)).not.toContain("ABCD");
  });

  it("si lo confirmado ya no es lo que pasaría, vuelve a preguntar", async () => {
    once("resetSecondFactor", { kind: "changed" });
    expect(await resetAction(IDLE, pressed(resetButton.confirm(PERSON, "")))).toEqual({ kind: "confirm", profile: PERSON, changed: true, attempt: 1 });
  });

  it.each([
    [{ kind: "answered", answer: "self" }, "self"],
    [{ kind: "answered", answer: "ineligible" }, "ineligible"],
    [{ kind: "answered", answer: "not_member" }, "not_member"],
    [{ kind: "answered", answer: "invalid" }, "invalid"],
    [{ kind: "answered", answer: "unavailable" }, "not_configured"],
    [{ kind: "answered", answer: "needs_fresh_code" }, "needs_code"],
    [{ kind: "unknown" }, "unknown"],
    [{ kind: "unavailable" }, "unavailable"],
  ])("restablecer contesta %j: se pinta %s, sin código", async (result, reason) => {
    once("resetSecondFactor", result);
    const state = await resetAction(IDLE, pressed(resetButton.confirm(PERSON, "")));
    expect(state).toEqual({ kind: "failed", reason, attempt: 1 });
    expect(state).not.toHaveProperty("code");
  });

  it.each([
    ["«Cancelar»", pressed(resetButton.cancel)],
    ["un envío que no se entiende", pressed("choose:ana")],
    ["más de una intención", form([["do", resetButton.choose(PERSON)], ["do", resetButton.confirm(PERSON, "")]])],
  ])("%s no llama a nadie", async (_what, data) => {
    expect(await resetAction({ kind: "confirm", profile: PERSON, changed: false, attempt: 3 }, data)).toEqual({ kind: "idle" });
    expect(calls.order).toEqual([]);
  });

  it("a quien la pantalla no ofrece (una misma) no se le dice nada", async () => {
    once("prepareReset", { kind: "malformed" });
    expect(await resetAction(IDLE, pressed(resetButton.choose(PERSON)))).toEqual({ kind: "idle" });
  });

  it.each([
    ["prepareReset", resetButton.choose(PERSON), { kind: "refused" }],
    ["resetSecondFactor", resetButton.confirm(PERSON, ""), { kind: "refused" }],
    ["resetSecondFactor", resetButton.confirm(PERSON, ""), { kind: "answered", answer: "forbidden" }],
  ] as const)("sin permiso (%s): a la página, sin pintar nada", async (service, button, result) => {
    once(service, result);
    await expect(resetAction(IDLE, pressed(button))).rejects.toThrow("redirige a /admin/equipo");
    expect(calls.order).toEqual([service, "redirect"]);
  });
});
