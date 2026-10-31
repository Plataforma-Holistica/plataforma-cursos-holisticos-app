import { beforeEach, describe, expect, it, vi } from "vitest";

// La guarda de una página, sin base: le pregunta al servicio, redirige cuando la tabla lo
// dice y, si no, le devuelve a la página qué pintar. La tabla está en guard-steps.test.ts.

const mocks = vi.hoisted(() => ({
  checkSession: vi.fn(),
  teamStanding: vi.fn(),
  teacherStanding: vi.fn(),
  cookieReader: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`redirige a ${to}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("no existe");
  }),
}));
vi.mock("@/services/account/account", () => ({ checkSession: mocks.checkSession, teamStanding: mocks.teamStanding }));
vi.mock("@/services/teachers/teachers", () => ({ teacherStanding: mocks.teacherStanding }));
vi.mock("./request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));

import type { PendingAccount, SessionCheck, TeamCheck, TeamStanding, VerifiedClaims } from "@/services/account/account";
import type { TeacherCheck } from "@/services/teachers/standing";

import {
  requireAdmin,
  requireFactorSetup,
  requireIncompleteSession,
  requireLessonSession,
  requireSecondFactor,
  requireSession,
  requireTeacher,
  visitorOnly,
} from "./guard";

const reader = { get: () => undefined };
const claims = { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 } as VerifiedClaims;
const pending: PendingAccount = { variant: "complete_account", missing: { name: true, adultDeclaration: false, documents: [] } };
const answers = (check: SessionCheck) => mocks.checkSession.mockResolvedValue(check);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieReader.mockResolvedValue(reader);
});

describe("requireSession", () => {
  it("le pregunta al servicio con las cookies de esta petición", async () => {
    answers({ kind: "pass", claims });
    expect(await requireSession("/inicio")).toEqual({ kind: "render", claims });
    expect(mocks.checkSession).toHaveBeenCalledExactlyOnceWith(reader);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each<[SessionCheck, string]>([
    [{ kind: "anonymous" }, "/entrar?volver=%2Finicio"],
    [{ kind: "incomplete", claims, ...pending }, "/consentimientos?volver=%2Finicio"],
    [{ kind: "must_sign_out", then: "sign_in" }, "/sesion/cerrar"],
    [{ kind: "must_sign_out", then: "recover" }, "/sesion/cerrar"],
  ])("%j redirige a %s, y la página no se pinta", async (check, to) => {
    answers(check);
    await expect(requireSession("/inicio")).rejects.toThrow(`redirige a ${to}`);
  });

  it.each<[SessionCheck]>([[{ kind: "suspended" }], [{ kind: "unavailable" }]])("%j no redirige: la página pinta ese estado", async (check) => {
    answers(check);
    expect(await requireSession("/inicio")).toEqual({ kind: check.kind });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("requireLessonSession", () => {
  const path = "/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002";
  const back = encodeURIComponent(path);

  it("con sesión, pinta, y no pregunta si el curso es abierto", async () => {
    answers({ kind: "pass", claims });
    const isOpen = vi.fn(() => Promise.resolve(true));
    expect(await requireLessonSession(path, isOpen)).toEqual({ kind: "render", claims });
    expect(isOpen).not.toHaveBeenCalled();
  });

  it.each<[boolean | null, string]>([
    [true, `/registro?volver=${back}`],
    [false, `/entrar?volver=${back}`],
    [null, `/entrar?volver=${back}`],
  ])("sin sesión, con el curso abierto %s, redirige a %s", async (open, to) => {
    answers({ kind: "anonymous" });
    const isOpen = vi.fn(() => Promise.resolve(open));
    await expect(requireLessonSession(path, isOpen)).rejects.toThrow(`redirige a ${to}`);
    expect(isOpen).toHaveBeenCalledOnce();
  });

  it.each<[SessionCheck]>([[{ kind: "suspended" }], [{ kind: "unavailable" }]])("%j no redirige: la página pinta ese estado", async (check) => {
    answers(check);
    expect(await requireLessonSession(path, () => Promise.resolve(true))).toEqual({ kind: check.kind });
  });
});

describe("requireIncompleteSession", () => {
  it("solo se pinta para una cuenta a la que le falta algo", async () => {
    answers({ kind: "incomplete", claims, ...pending });
    expect(await requireIncompleteSession("/inicio")).toEqual({ kind: "render", claims, pending });
  });

  it.each<[SessionCheck, string]>([
    [{ kind: "pass", claims }, "/inicio?x=1"],
    [{ kind: "anonymous" }, "/entrar?volver=%2Finicio%3Fx%3D1"],
    [{ kind: "must_sign_out", then: "sign_in" }, "/sesion/cerrar"],
  ])("%j redirige a %s", async (check, to) => {
    answers(check);
    await expect(requireIncompleteSession("/inicio?x=1")).rejects.toThrow(`redirige a ${to}`);
  });

  it.each<[SessionCheck]>([[{ kind: "suspended" }], [{ kind: "unavailable" }]])("%j no redirige", async (check) => {
    answers(check);
    expect(await requireIncompleteSession(null)).toEqual({ kind: check.kind });
  });
});

describe("visitorOnly", () => {
  it.each<[SessionCheck]>([[{ kind: "pass", claims }], [{ kind: "incomplete", claims, ...pending }], [{ kind: "suspended" }]])(
    "%j: quien ya tiene sesión se va a su inicio",
    async (check) => {
      answers(check);
      await expect(visitorOnly()).rejects.toThrow("redirige a /inicio");
    },
  );

  it.each<[SessionCheck]>([[{ kind: "anonymous" }], [{ kind: "unavailable" }], [{ kind: "must_sign_out", then: "sign_in" }]])(
    "%j: la pantalla se pinta",
    async (check) => {
      answers(check);
      await expect(visitorOnly()).resolves.toBeUndefined();
      expect(mocks.redirect).not.toHaveBeenCalled();
    },
  );
});

// Las tres del equipo le preguntan a `teamStanding`, no a `checkSession`: quién es del
// equipo lo dice la base, con el estado de esa sesión.

const FACTOR = "22222222-2222-4222-8222-222222222222";
const team = (standing: TeamStanding, inProgress: string | null = null): TeamCheck => ({ kind: "team", claims, standing, inProgress });
const stands = (check: TeamCheck) => mocks.teamStanding.mockResolvedValue(check);
const member: TeamStanding = { state: "member", factor: FACTOR, capabilities: ["content"] };

describe("requireAdmin", () => {
  it("le pregunta al servicio del equipo con las cookies de esta petición, y no a la guarda de sesión a secas", async () => {
    stands(team(member));
    expect(await requireAdmin("/admin")).toEqual({ kind: "render", claims, capabilities: ["content"] });
    expect(mocks.teamStanding).toHaveBeenCalledExactlyOnceWith(reader);
    expect(mocks.checkSession).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it.each<[TeamCheck, string]>([
    [{ kind: "anonymous" }, "/entrar?volver=%2Fadmin%2Fequipo"],
    [{ kind: "incomplete", claims, ...pending }, "/consentimientos?volver=%2Fadmin%2Fequipo"],
    [{ kind: "must_sign_out", then: "sign_in" }, "/sesion/cerrar"],
    [team({ state: "invited", kind: "grant", capabilities: ["config"] }), "/entrar/segundo-factor/configurar"],
    [team({ state: "invited_unproven", kind: "grant" }), "/entrar/segundo-factor/configurar"],
    [team({ state: "unbound" }), "/entrar/segundo-factor"],
    [team({ state: "needs_code", factor: FACTOR }), "/entrar/segundo-factor?volver=%2Fadmin%2Fequipo"],
  ])("%j redirige a %s, y la página no se pinta", async (check, to) => {
    stands(check);
    await expect(requireAdmin("/admin/equipo")).rejects.toThrow(`redirige a ${to}`);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("a quien no es del equipo le contesta que la ruta no existe, sin redirigir", async () => {
    stands(team({ state: "none" }));
    await expect(requireAdmin("/admin")).rejects.toThrow("no existe");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each<[TeamCheck]>([[{ kind: "suspended" }], [{ kind: "unavailable" }]])("%j no redirige ni es un 404: la página pinta ese estado", async (check) => {
    stands(check);
    expect(await requireAdmin("/admin")).toEqual({ kind: check.kind });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("le pasa a la tabla la capacidad que la pantalla pide", async () => {
    stands(team(member));
    expect(await requireAdmin("/admin/equipo", "config")).toEqual({ kind: "forbidden", capability: "config" });
    expect(await requireAdmin("/admin/equipo", "content")).toEqual({ kind: "render", claims, capabilities: ["content"] });
  });
});

describe("requireSecondFactor", () => {
  it("pinta el formulario a quien le falta dar su código", async () => {
    stands(team({ state: "needs_code", factor: FACTOR }));
    expect(await requireSecondFactor("/admin")).toEqual({ kind: "render", view: "code" });
    expect(mocks.teamStanding).toHaveBeenCalledExactlyOnceWith(reader);
    expect(mocks.checkSession).not.toHaveBeenCalled();
  });

  it.each<[TeamCheck, string]>([
    [team(member), "/admin/equipo"],
    [{ kind: "anonymous" }, "/entrar?volver=%2Fadmin%2Fequipo"],
    [team({ state: "invited", kind: "grant", capabilities: [] }), "/entrar/segundo-factor/configurar"],
    [{ kind: "must_sign_out", then: "recover" }, "/sesion/cerrar"],
  ])("%j redirige a %s", async (check, to) => {
    stands(check);
    await expect(requireSecondFactor("/admin/equipo")).rejects.toThrow(`redirige a ${to}`);
  });

  it("a quien no es del equipo le contesta que la ruta no existe", async () => {
    stands(team({ state: "none" }));
    await expect(requireSecondFactor(null)).rejects.toThrow("no existe");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each<[TeamCheck]>([[{ kind: "suspended" }], [{ kind: "unavailable" }]])("%j no redirige", async (check) => {
    stands(check);
    expect(await requireSecondFactor(null)).toEqual({ kind: check.kind });
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});

describe("requireFactorSetup", () => {
  it("pinta «Empezar» a quien tiene una invitación y ya probó su buzón", async () => {
    stands(team({ state: "invited", kind: "grant", capabilities: ["content"] }));
    expect(await requireFactorSetup()).toEqual({ kind: "render", view: "start", handoff: false });
    expect(mocks.teamStanding).toHaveBeenCalledExactlyOnceWith(reader);
    expect(mocks.checkSession).not.toHaveBeenCalled();
  });

  it("le pasa a la tabla el factor que ese navegador ya empezó", async () => {
    stands(team({ state: "invited", kind: "rebind", capabilities: [] }, FACTOR));
    expect(await requireFactorSetup()).toEqual({ kind: "render", view: "resume", painted: FACTOR, handoff: true });
  });

  it.each<[TeamCheck, string]>([
    [team(member), "/admin"],
    [team({ state: "needs_code", factor: FACTOR }), "/entrar/segundo-factor"],
    [{ kind: "anonymous" }, "/entrar"],
    [{ kind: "incomplete", claims, ...pending }, "/consentimientos"],
  ])("%j redirige a %s", async (check, to) => {
    stands(check);
    await expect(requireFactorSetup()).rejects.toThrow(`redirige a ${to}`);
  });

  it("a quien no es del equipo le contesta que la ruta no existe", async () => {
    stands(team({ state: "none" }));
    await expect(requireFactorSetup()).rejects.toThrow("no existe");
  });

  it.each<[TeamCheck]>([[{ kind: "suspended" }], [{ kind: "unavailable" }]])("%j no redirige", async (check) => {
    stands(check);
    expect(await requireFactorSetup()).toEqual({ kind: check.kind });
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});

describe("requireTeacher", () => {
  const TEACHER = "33333333-3333-4333-8333-333333333333";
  const teaches = (check: TeacherCheck) => mocks.teacherStanding.mockResolvedValue(check);

  it("le pregunta al servicio del maestro con las cookies de esta petición, y no a la guarda de sesión a secas", async () => {
    teaches({ kind: "teacher", claims, standing: { state: "active", teacher: { id: TEACHER } } });
    expect(await requireTeacher("/portal/cursos")).toEqual({ kind: "render", screen: "work", claims, teacher: { id: TEACHER, status: "active", notice: null } });
    expect(mocks.teacherStanding).toHaveBeenCalledExactlyOnceWith(reader);
    expect(mocks.checkSession).not.toHaveBeenCalled();
    expect(mocks.teamStanding).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it.each<[TeacherCheck, string]>([
    [{ kind: "anonymous" }, "/entrar?volver=%2Fportal%2Fcursos"],
    [{ kind: "incomplete", claims, ...pending }, "/consentimientos?volver=%2Fportal%2Fcursos"],
    [{ kind: "must_sign_out", then: "sign_in" }, "/sesion/cerrar"],
  ])("%j redirige a %s, y la página no se pinta", async (check, to) => {
    teaches(check);
    await expect(requireTeacher("/portal/cursos")).rejects.toThrow(`redirige a ${to}`);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("a quien no es maestro le contesta que la ruta no existe, sin redirigir", async () => {
    teaches({ kind: "teacher", claims, standing: { state: "none" } });
    await expect(requireTeacher("/portal/cursos")).rejects.toThrow("no existe");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each<[TeacherCheck]>([[{ kind: "suspended" }], [{ kind: "unavailable" }]])("%j no redirige ni es un 404: la página pinta ese estado", async (check) => {
    teaches(check);
    expect(await requireTeacher("/portal/cursos")).toEqual({ kind: check.kind });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});
