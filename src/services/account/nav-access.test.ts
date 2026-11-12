import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { NO_NAV_ACCESS } from "@/domain/access/nav-access";
import type { FailureCode } from "@/services/error-reporting/server";

import { createNavAccess, type NavStates } from "./nav-access";

// Los accesos de la barra (T-616, solicitud 2), con la base simulada. Contra la base de verdad, en
// tests/integration/106-accesos-de-la-barra.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;

function setup(read: () => Promise<NavStates>) {
  const reported: FailureCode[] = [];
  const reader = vi.fn<(claims: VerifiedClaims) => Promise<NavStates>>(read);
  const navAccess = createNavAccess({ read: reader, report: (code) => (reported.push(code), Promise.resolve()) });
  return { navAccess, reader, reported };
}

describe("navAccess", () => {
  it("lee los dos estados una sola vez, con las claims que verificó la guarda, y obedece la regla", async () => {
    const { navAccess, reader, reported } = setup(() => Promise.resolve({ team: "needs_code", teacher: "suspended" }));
    expect(await navAccess(claims)).toEqual({ admin: true, portal: true });
    expect(reader).toHaveBeenCalledExactlyOnceWith(claims);
    expect(reported).toEqual([]);
  });

  it("a quien no es del equipo ni maestro no le da nada", async () => {
    const { navAccess } = setup(() => Promise.resolve({ team: "none", teacher: "none" }));
    expect(await navAccess(claims)).toEqual(NO_NAV_ACCESS);
  });

  it("a una invitación no le da el acceso", async () => {
    const { navAccess } = setup(() => Promise.resolve({ team: "invited_unproven", teacher: "invited" }));
    expect(await navAccess(claims)).toEqual(NO_NAV_ACCESS);
  });

  it("si la base no contestó, falla cerrada y lo reporta", async () => {
    const { navAccess, reported } = setup(() => Promise.reject(new Error("sin base")));
    expect(await navAccess(claims)).toEqual(NO_NAV_ACCESS);
    expect(reported).toEqual(["nav_access_unavailable"]);
  });

  it("cada llamada lee otra vez: no recuerda lo de nadie", async () => {
    const answers: NavStates[] = [
      { team: "member", teacher: "none" },
      { team: "none", teacher: "none" },
    ];
    const { navAccess, reader } = setup(() => Promise.resolve(answers.shift() as NavStates));
    expect(await navAccess(claims)).toEqual({ admin: true, portal: false });
    expect(await navAccess(claims)).toEqual(NO_NAV_ACCESS);
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
