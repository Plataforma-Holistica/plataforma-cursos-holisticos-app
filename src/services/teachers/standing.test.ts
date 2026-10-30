import { describe, expect, it, vi } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";

import { createTeachers, type TeacherStanding } from "./standing";

vi.mock("server-only", () => ({}));

// En qué estado está quien pide el portal del maestro, con la base simulada. Contra la base de
// verdad, en tests/integration/73-portal.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;
const reader = {} as CookieReader;
const TEACHER = "7e000000-0000-4000-8000-000000000001";

function setup(session: SessionCheck, standing: () => Promise<TeacherStanding>) {
  const reported: FailureCode[] = [];
  const store = { standing: vi.fn<(claims: VerifiedClaims) => Promise<TeacherStanding>>(() => standing()) };
  const checkSession = vi.fn<(reader: CookieReader) => Promise<SessionCheck>>(() => Promise.resolve(session));
  const service = createTeachers({ store, checkSession, report: (code) => (reported.push(code), Promise.resolve()) });
  return { ...service, store, checkSession, reported };
}

describe("teacherStanding", () => {
  it("corre la guarda de sesión con esas cookies y le pregunta a la base a nombre de la sesión que pasó", async () => {
    const service = setup({ kind: "pass", claims }, () => Promise.resolve({ state: "active", teacher: { id: TEACHER } }));
    expect(await service.teacherStanding(reader)).toEqual({ kind: "teacher", claims, standing: { state: "active", teacher: { id: TEACHER } } });
    expect(service.checkSession).toHaveBeenCalledExactlyOnceWith(reader);
    expect(service.store.standing).toHaveBeenCalledExactlyOnceWith(claims);
  });

  it.each<SessionCheck>([
    { kind: "anonymous" },
    { kind: "suspended" },
    { kind: "must_sign_out", then: "sign_in" },
    { kind: "unavailable" },
  ])("lo que la guarda no deja pasar se contesta tal cual, sin preguntarle a la base: %j", async (session) => {
    const service = setup(session, () => Promise.resolve({ state: "none" }));
    expect(await service.teacherStanding(reader)).toEqual(session);
    expect(service.store.standing).not.toHaveBeenCalled();
  });

  it("quien no es maestro lo dice la base", async () => {
    const service = setup({ kind: "pass", claims }, () => Promise.resolve({ state: "none" }));
    expect(await service.teacherStanding(reader)).toEqual({ kind: "teacher", claims, standing: { state: "none" } });
  });

  it("si la base no contesta, «no se supo», que nunca es «no es maestro»; y se reporta", async () => {
    const service = setup({ kind: "pass", claims }, () => Promise.reject(new Error("se cayó")));
    expect(await service.teacherStanding(reader)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["teacher_unavailable"]);
  });
});
