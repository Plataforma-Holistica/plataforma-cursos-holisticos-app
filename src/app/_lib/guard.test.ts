import { beforeEach, describe, expect, it, vi } from "vitest";

// La guarda de una página, sin base: le pregunta al servicio, redirige cuando la tabla lo
// dice y, si no, le devuelve a la página qué pintar. La tabla está en guard-steps.test.ts.

const mocks = vi.hoisted(() => ({
  checkSession: vi.fn(),
  cookieReader: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`redirige a ${to}`);
  }),
}));
vi.mock("@/services/account/account", () => ({ checkSession: mocks.checkSession }));
vi.mock("./request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import type { PendingAccount, SessionCheck, VerifiedClaims } from "@/services/account/account";

import { requireIncompleteSession, requireSession, visitorOnly } from "./guard";

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
