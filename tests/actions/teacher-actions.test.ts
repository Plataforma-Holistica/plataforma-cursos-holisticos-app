import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de aceptar la invitación (PA-40) y el aviso vuelto a pedir (PA-52), T-401, con los servicios
// simulados: qué le pasa cada una a su servicio, en qué orden, y qué hace con cada respuesta. Lo que el servicio
// hace de verdad lo prueban tests/integration/81-aceptar-invitacion.test.ts y el extremo a extremo del equipo.

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
    acceptTeacherInvitation: logged("acceptTeacherInvitation", unknown),
    acceptTeacherNotice: logged("acceptTeacherNotice", unknown),
    leaveNotice: logged("leaveNotice", () => undefined),
    signOut: logged("signOut", () => Promise.resolve()),
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
vi.mock("@/services/teachers/teachers", () => ({
  acceptTeacherInvitation: mocks.acceptTeacherInvitation,
  acceptTeacherNotice: mocks.acceptTeacherNotice,
}));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { acceptNoticeAction } from "@/app/portal/_aviso/actions";
import { acceptInvitationAction } from "@/app/portal/_invitacion/actions";

const jar = { get: () => undefined, set: () => undefined };
const origin = { ip: "203.0.113.1", userAgent: "prueba" };
const IDLE = { kind: "idle" } as const;
const AGREEMENT = "c0000000-0000-4000-8000-000000000001";
const NOTICE = "c0000000-0000-4000-8000-000000000002";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}
const accepted = (extra: Record<string, string> = {}) =>
  form({ agreement: AGREEMENT, notice: NOTICE, agreed: "on", notice_agreed: "on", ...extra });
const noticed = (extra: Record<string, string> = {}) => form({ notice: NOTICE, agreed: "on", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
  mocks.requestOrigin.mockResolvedValue(origin);
});

describe("aceptar la invitación", () => {
  it("sin marcar las dos casillas no llega al servicio, y dice cuál falta", async () => {
    expect(await acceptInvitationAction(IDLE, form({ agreement: AGREEMENT, notice: NOTICE, agreed: "on" }))).toEqual({
      kind: "missing",
      agreed: true,
      noticeAgreed: false,
      attempt: 1,
    });
    expect(calls.order).toEqual([]);
  });

  it("un texto sin forma no llega al servicio: se vuelve a pintar con los de ahora", async () => {
    expect(await acceptInvitationAction(IDLE, accepted({ agreement: "no-es-un-id" }))).toEqual({ kind: "failed", reason: "changed", attempt: 1 });
    expect(calls.order).toEqual(["refresh"]);
  });

  it("le pasa al servicio solo los dos textos mostrados; aceptada, al portal con su aviso", async () => {
    once("acceptTeacherInvitation", { kind: "accepted" });
    await expect(acceptInvitationAction(IDLE, accepted({ teacher: "otro", email: "otra@prueba.test" }))).rejects.toThrow("redirige a /portal");
    expect(mocks.acceptTeacherInvitation).toHaveBeenCalledExactlyOnceWith(jar, { agreement: AGREEMENT, notice: NOTICE }, origin);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "teacher_accepted");
    expect(calls.order).toEqual(["acceptTeacherInvitation", "leaveNotice", "redirect"]);
  });

  it.each(["no_invitation", "inviter_lost_content"])(
    "con %s no se vuelve a pedir la página, que ya contesta 404: a su inicio, con el aviso",
    async (answer) => {
      once("acceptTeacherInvitation", { kind: "answered", answer });
      await expect(acceptInvitationAction(IDLE, accepted())).rejects.toThrow("redirige a /inicio");
      expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "teacher_invitation_gone");
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ kind: "answered", answer: "changed" }, { kind: "failed", reason: "changed", attempt: 1 }],
    [{ kind: "answered", answer: "unavailable" }, { kind: "failed", reason: "unavailable", attempt: 1 }],
    [{ kind: "unknown" }, { kind: "failed", reason: "unknown", attempt: 1 }],
    // La guarda de la página vuelve a preguntar, y pinta «prueba tu correo».
    [{ kind: "answered", answer: "needs_mailbox_proof" }, { kind: "idle" }],
    [{ kind: "refused", check: { kind: "suspended" } }, { kind: "idle" }],
  ])("con %j vuelve a pedir la página y contesta lo que toca", async (answer, expected) => {
    once("acceptTeacherInvitation", answer);
    expect(await acceptInvitationAction(IDLE, accepted())).toEqual(expected);
    expect(calls.order).toEqual(["acceptTeacherInvitation", "refresh"]);
  });

  it("una cuenta a la que le toca elegir contraseña va a recuperarla, con su aviso y sin sesión", async () => {
    once("acceptTeacherInvitation", { kind: "refused", check: { kind: "must_sign_out", then: "recover" } });
    await expect(acceptInvitationAction(IDLE, accepted())).rejects.toThrow("redirige a /recuperar");
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "choose_password");
    expect(calls.order).toEqual(["acceptTeacherInvitation", "signOut", "leaveNotice", "redirect"]);
  });

  it("del estado anterior solo lee el número de intento", async () => {
    expect(await acceptInvitationAction({ kind: "failed", reason: "unknown", attempt: 4 }, form({}))).toEqual({
      kind: "missing",
      agreed: false,
      noticeAgreed: false,
      attempt: 5,
    });
  });
});

describe("aceptar el aviso vuelto a pedir", () => {
  it("sin marcar la casilla no llega al servicio", async () => {
    expect(await acceptNoticeAction(IDLE, form({ notice: NOTICE }))).toEqual({ kind: "missing", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("un texto sin forma no llega al servicio", async () => {
    expect(await acceptNoticeAction(IDLE, noticed({ notice: "no-es-un-id" }))).toEqual({ kind: "failed", reason: "changed", attempt: 1 });
    expect(calls.order).toEqual(["refresh"]);
  });

  it("le pasa al servicio solo el texto mostrado; anotado y sin destino, al portal con su aviso", async () => {
    once("acceptTeacherNotice", { kind: "accepted" });
    await expect(acceptNoticeAction(IDLE, noticed())).rejects.toThrow("redirige a /portal");
    expect(mocks.acceptTeacherNotice).toHaveBeenCalledExactlyOnceWith(jar, { notice: NOTICE }, origin);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "teacher_notice_accepted");
  });

  it("anotado con destino, vuelve ahí sin dejar un aviso que esa pantalla no lee", async () => {
    once("acceptTeacherNotice", { kind: "accepted" });
    await expect(acceptNoticeAction(IDLE, noticed({ volver: "/portal/cursos" }))).rejects.toThrow("redirige a /portal/cursos");
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });

  it("un destino fuera del portal no se sigue", async () => {
    once("acceptTeacherNotice", { kind: "accepted" });
    await expect(acceptNoticeAction(IDLE, noticed({ volver: "/admin" }))).rejects.toThrow("redirige a /portal");
  });

  it.each([
    [{ kind: "changed" }, { kind: "failed", reason: "changed", attempt: 1 }],
    [{ kind: "unknown" }, { kind: "failed", reason: "unknown", attempt: 1 }],
    [{ kind: "refused", check: { kind: "suspended" } }, { kind: "idle" }],
  ])("con %j vuelve a pedir la página y contesta lo que toca", async (answer, expected) => {
    once("acceptTeacherNotice", answer);
    expect(await acceptNoticeAction(IDLE, noticed())).toEqual(expected);
    expect(calls.order).toEqual(["acceptTeacherNotice", "refresh"]);
  });

  it("una cuenta a la que le toca elegir contraseña va a recuperarla, con su aviso y sin sesión", async () => {
    once("acceptTeacherNotice", { kind: "refused", check: { kind: "must_sign_out", then: "recover" } });
    await expect(acceptNoticeAction(IDLE, noticed())).rejects.toThrow("redirige a /recuperar");
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "choose_password");
    expect(calls.order).toEqual(["acceptTeacherNotice", "signOut", "leaveNotice", "redirect"]);
  });
});
