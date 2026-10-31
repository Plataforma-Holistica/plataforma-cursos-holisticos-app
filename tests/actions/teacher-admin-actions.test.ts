import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de administrar a los maestros (PA-65 y PA-66; T-401), con los servicios simulados: qué le pasa cada una a
// su servicio, en qué orden, y qué hace con cada respuesta. Lo que el servicio hace de verdad lo prueban
// tests/integration/82-administrar-maestros.test.ts y el extremo a extremo del equipo.

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
    inviteTeacher: logged("inviteTeacher", unknown),
    reinviteTeacher: logged("reinviteTeacher", unknown),
    revokeTeacherInvitation: logged("revokeTeacherInvitation", unknown),
    setTeacherFounder: logged("setTeacherFounder", unknown),
    suspendTeacher: logged("suspendTeacher", unknown),
    liftTeacherSuspension: logged("liftTeacherSuspension", unknown),
    decideTeacherFraud: logged("decideTeacherFraud", unknown),
    giveTeacherCode: logged("giveTeacherCode", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    leaveNotice: logged("leaveNotice", () => undefined),
    clearNotice: logged("clearNotice", () => undefined),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/teachers/teacher-admin", () => ({
  inviteTeacher: mocks.inviteTeacher,
  reinviteTeacher: mocks.reinviteTeacher,
  revokeTeacherInvitation: mocks.revokeTeacherInvitation,
  setTeacherFounder: mocks.setTeacherFounder,
  suspendTeacher: mocks.suspendTeacher,
  liftTeacherSuspension: mocks.liftTeacherSuspension,
  decideTeacherFraud: mocks.decideTeacherFraud,
  giveTeacherCode: mocks.giveTeacherCode,
}));
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice, clearNotice: mocks.clearNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { teachersAction, teachersCodeAction } from "@/app/admin/_maestros/actions";
import { teachersButton } from "@/app/admin/_maestros/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const TEACHER = "b0000000-0000-4000-8000-000000000002";
const REQUEST = "c0000000-0000-4000-8000-000000000004";
const SEEN = "active.-.accepted.-.0.0.0";
const PAGE = `/admin/maestros/${TEACHER}`;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}
const answered = (answer: string) => ({ kind: "answered", answer });
const SERVICES = ["inviteTeacher", "reinviteTeacher", "revokeTeacherInvitation", "setTeacherFounder", "suspendTeacher", "liftTeacherSuspension", "decideTeacherFraud"] as const;
const noServiceCalled = () => {
  for (const name of SERVICES) expect(mocks[name]).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("lo que no llega al servicio", () => {
  it.each([[form({})], [form({ do: "cancel" })], [form({ do: "borrar:todo" })]])("sin intención que se entienda, nada", async (data) => {
    expect(await teachersAction(IDLE, data)).toEqual({ kind: "idle" });
    noServiceCalled();
  });

  it("invitar sin nombre ni correo se dice en sus campos, con lo escrito", async () => {
    expect(await teachersAction(IDLE, form({ do: "invite", name: "", email: "sin-arroba" }))).toEqual({
      kind: "invalid",
      step: "invite",
      teacher: null,
      problems: ["name", "email"],
      drafts: { name: "", email: "sin-arroba" },
      attempt: 1,
    });
    noServiceCalled();
  });

  it("«Seguir revisando» no llama a nadie, y conserva lo escrito", async () => {
    expect(await teachersAction(IDLE, form({ do: teachersButton.cancel("suspend", TEACHER), reason: "Motivo", notice: "Aviso" }))).toEqual({
      kind: "editing",
      form: "suspend",
      teacher: TEACHER,
      drafts: { reason: "Motivo", notice: "Aviso" },
      attempt: 1,
    });
    noServiceCalled();
  });

  it("preguntar antes de suspender no llama a nadie, y conserva lo escrito", async () => {
    expect(await teachersAction(IDLE, form({ do: teachersButton.askSuspend(TEACHER, SEEN), reason: "Motivo", notice: "Aviso" }))).toEqual({
      kind: "asking",
      ask: "suspend",
      teacher: TEACHER,
      drafts: { reason: "Motivo", notice: "Aviso" },
      attempt: 1,
    });
    noServiceCalled();
  });

  it("preguntar antes de confirmar un fraude tampoco, y pide el texto para el maestro antes", async () => {
    const asked = await teachersAction(IDLE, form({ do: teachersButton.askConfirm(TEACHER, SEEN, REQUEST), notice: "" }));
    expect(asked).toMatchObject({ kind: "invalid", problems: ["notice"] });
    expect(await teachersAction(IDLE, form({ do: teachersButton.askConfirm(TEACHER, SEEN, REQUEST), notice: "Aviso" }))).toMatchObject({ kind: "asking", ask: "confirm" });
    noServiceCalled();
  });

  it("del estado anterior solo lee el número de intento", async () => {
    const previous = { kind: "asking", ask: "suspend", teacher: "otro", drafts: { reason: "de antes" }, attempt: 4 } as const;
    expect(await teachersAction(previous, form({ do: teachersButton.suspend(TEACHER, SEEN), reason: "", notice: "" }))).toMatchObject({
      kind: "invalid",
      teacher: TEACHER,
      attempt: 5,
    });
  });
});

describe("lo que le pasa a cada servicio", () => {
  it("invitar: el nombre y el correo; hecho, a la lista con su aviso", async () => {
    once("inviteTeacher", answered("invited_new"));
    await expect(teachersAction(IDLE, form({ do: "invite", name: "Nora", email: "nora@prueba.test" }))).rejects.toThrow("redirige a /admin/maestros");
    expect(mocks.inviteTeacher).toHaveBeenCalledExactlyOnceWith(jar, { name: "Nora", email: "nora@prueba.test" });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "teacher_invited");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reenviar y revocar: de quién y lo que se vio, del botón", async () => {
    once("reinviteTeacher", answered("invited_new"));
    await expect(teachersAction(IDLE, form({ do: teachersButton.reinvite(TEACHER, SEEN) }))).rejects.toThrow("redirige a /admin/maestros");
    expect(mocks.reinviteTeacher).toHaveBeenCalledExactlyOnceWith(jar, { teacher: TEACHER, seen: SEEN });
    once("revokeTeacherInvitation", answered("revoked"));
    await expect(teachersAction(IDLE, form({ do: teachersButton.revoke(TEACHER, SEEN) }))).rejects.toThrow("redirige a /admin/maestros");
    expect(mocks.revokeTeacherInvitation).toHaveBeenCalledExactlyOnceWith(jar, { teacher: TEACHER, seen: SEEN });
  });

  it("el fundador: guardar lleva el día; quitar, nulo; vuelven a la ficha", async () => {
    once("setTeacherFounder", answered("set"));
    await expect(teachersAction(IDLE, form({ do: teachersButton.founder(TEACHER, SEEN), since: "2026-11-01" }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.setTeacherFounder).toHaveBeenLastCalledWith(jar, { teacher: TEACHER, seen: SEEN, since: "2026-11-01" });
    once("setTeacherFounder", answered("cleared"));
    await expect(teachersAction(IDLE, form({ do: teachersButton.clearFounder(TEACHER, SEEN), since: "2026-11-01" }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.setTeacherFounder).toHaveBeenLastCalledWith(jar, { teacher: TEACHER, seen: SEEN, since: null });
  });

  it("suspender lleva el motivo y el texto", async () => {
    once("suspendTeacher", answered("suspended"));
    await expect(teachersAction(IDLE, form({ do: teachersButton.suspend(TEACHER, SEEN), reason: "Motivo", notice: "Aviso" }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.suspendTeacher).toHaveBeenCalledExactlyOnceWith(jar, { teacher: TEACHER, seen: SEEN, reason: "Motivo", notice: "Aviso" });
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "teacher_suspended");
  });

  it("levantar", async () => {
    once("liftTeacherSuspension", answered("lifted"));
    await expect(teachersAction(IDLE, form({ do: teachersButton.lift(TEACHER, SEEN) }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.liftTeacherSuspension).toHaveBeenCalledExactlyOnceWith(jar, { teacher: TEACHER, seen: SEEN });
  });

  it("confirmar y rechazar dicen cuál con el botón, no con el formulario", async () => {
    once("decideTeacherFraud", answered("confirmed"));
    await expect(teachersAction(IDLE, form({ do: teachersButton.confirm(TEACHER, SEEN, REQUEST), notice: "Aviso", note: "", confirm: "false" }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.decideTeacherFraud).toHaveBeenLastCalledWith(jar, { teacher: TEACHER, seen: SEEN, request: REQUEST, confirm: true, note: "", notice: "Aviso" });
    once("decideTeacherFraud", answered("rejected"));
    await expect(teachersAction(IDLE, form({ do: teachersButton.reject(TEACHER, SEEN, REQUEST), notice: "", note: "Sin caso", confirm: "true" }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.decideTeacherFraud).toHaveBeenLastCalledWith(jar, { teacher: TEACHER, seen: SEEN, request: REQUEST, confirm: false, note: "Sin caso", notice: "" });
  });
});

describe("lo que no salió", () => {
  it("vuelve a pedir la página, conserva lo escrito y dice por qué", async () => {
    once("suspendTeacher", { kind: "changed" });
    expect(await teachersAction(IDLE, form({ do: teachersButton.suspend(TEACHER, SEEN), reason: "Motivo", notice: "Aviso" }))).toEqual({
      kind: "failed",
      reason: "changed",
      step: "suspend",
      teacher: TEACHER,
      drafts: { reason: "Motivo", notice: "Aviso" },
      attempt: 1,
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("«no se supo» nunca se pinta como hecho", async () => {
    expect(await teachersAction(IDLE, form({ do: teachersButton.lift(TEACHER, SEEN) }))).toMatchObject({ kind: "failed", reason: "unknown" });
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });

  it("a quien la guarda no dejó, a la misma página, donde decide ella", async () => {
    once("liftTeacherSuspension", { kind: "refused" });
    await expect(teachersAction(IDLE, form({ do: teachersButton.lift(TEACHER, SEEN) }))).rejects.toThrow(`redirige a ${PAGE}`);
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });

  it("el aviso con el que se llegó no vuelve a salir junto a otra respuesta", async () => {
    await teachersAction(IDLE, form({ do: teachersButton.lift(TEACHER, SEEN) }));
    expect(calls.order[0]).toBe("clearNotice");
  });
});

describe("dar el código", () => {
  it("sin forma no llega al servicio", async () => {
    expect(await teachersCodeAction(null, IDLE, form({ code: "12" }))).toMatchObject({ kind: "invalid" });
    expect(mocks.giveTeacherCode).not.toHaveBeenCalled();
  });

  it("verificado, a la lista: recargar no lo reenvía", async () => {
    once("giveTeacherCode", { kind: "verified" });
    await expect(teachersCodeAction(null, IDLE, form({ code: "123456" }))).rejects.toThrow(/redirige a \/admin\/maestros$/);
    expect(mocks.giveTeacherCode).toHaveBeenCalledExactlyOnceWith(jar, "123456");
  });

  it("dado desde una ficha, vuelve a esa ficha", async () => {
    once("giveTeacherCode", { kind: "verified" });
    await expect(teachersCodeAction(TEACHER, IDLE, form({ code: "123456" }))).rejects.toThrow(`redirige a ${PAGE}`);
  });

  it("un maestro sin forma no arma una dirección: a la lista", async () => {
    once("giveTeacherCode", { kind: "verified" });
    await expect(teachersCodeAction("//otro.example", IDLE, form({ code: "123456" }))).rejects.toThrow(/redirige a \/admin\/maestros$/);
  });

  it("equivocado se dice", async () => {
    once("giveTeacherCode", { kind: "wrong_code" });
    expect(await teachersCodeAction(null, IDLE, form({ code: "123456" }))).toEqual({ kind: "failed", reason: "wrong_code", attempt: 1 });
  });
});
