import { describe, expect, it } from "vitest";

import type { PendingAccount, SessionCheck, TeamCheck, TeamStanding, VerifiedClaims } from "@/services/account/account";

import {
  adminPageStep,
  closedSessionRoute,
  consentsPageStep,
  factorSetupPageStep,
  lessonPageStep,
  publicPageStep,
  secondFactorPageStep,
  sessionPageStep,
  visitorPageStep,
} from "./guard-steps";

// Qué hace cada tipo de pantalla con lo que contesta la guarda de sesión (flujo de la app
// §6.2 y §6.3). La guarda decide; esto solo traduce su respuesta a pintar o a redirigir.

const claims = { userId: "11111111-1111-4111-8111-111111111111", aal: "aal1", sessionId: null, issuedAt: 0 } as VerifiedClaims;
const pending: PendingAccount = {
  variant: "complete_account",
  missing: { name: true, adultDeclaration: false, documents: [{ docType: "terms", why: "never_given" }] },
};

const checks: Record<string, SessionCheck> = {
  anonymous: { kind: "anonymous" },
  pass: { kind: "pass", claims },
  incomplete: { kind: "incomplete", claims, ...pending },
  suspended: { kind: "suspended" },
  closeToRecover: { kind: "must_sign_out", then: "recover" },
  closeToSignIn: { kind: "must_sign_out", then: "sign_in" },
  unavailable: { kind: "unavailable" },
};
const check = (name: keyof typeof checks): SessionCheck => {
  const found = checks[name];
  if (!found) throw new Error(`No hay un caso llamado ${name}.`);
  return found;
};

describe("una pantalla con sesión", () => {
  it.each([
    ["anonymous", { kind: "redirect", to: "/entrar?volver=%2Finicio" }],
    ["pass", { kind: "render", claims }],
    ["incomplete", { kind: "redirect", to: "/consentimientos?volver=%2Finicio" }],
    ["suspended", { kind: "suspended" }],
    ["closeToRecover", { kind: "redirect", to: "/sesion/cerrar" }],
    ["closeToSignIn", { kind: "redirect", to: "/sesion/cerrar" }],
    ["unavailable", { kind: "unavailable" }],
  ] as const)("%s", (name, expected) => {
    expect(sessionPageStep(check(name), "/inicio")).toEqual(expected);
  });

  it("solo se pinta cuando la guarda dijo que pasa", () => {
    for (const [name, value] of Object.entries(checks)) {
      expect(sessionPageStep(value, "/inicio").kind === "render").toBe(name === "pass");
    }
  });

  it("guarda la ruta que se pidió, con su consulta", () => {
    expect(sessionPageStep(check("anonymous"), "/inicio/algo?x=1")).toEqual({
      kind: "redirect",
      to: "/entrar?volver=%2Finicio%2Falgo%3Fx%3D1",
    });
    expect(sessionPageStep(check("incomplete"), "/inicio/algo?x=1")).toEqual({
      kind: "redirect",
      to: "/consentimientos?volver=%2Finicio%2Falgo%3Fx%3D1",
    });
  });
});

describe("la pantalla de una lección (T-203; flujo §6.3)", () => {
  const path = "/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002";
  const back = encodeURIComponent(path);

  it.each([
    ["pass", { kind: "render", claims }],
    ["incomplete", { kind: "redirect", to: `/consentimientos?volver=${back}` }],
    ["suspended", { kind: "suspended" }],
    ["closeToRecover", { kind: "redirect", to: "/sesion/cerrar" }],
    ["closeToSignIn", { kind: "redirect", to: "/sesion/cerrar" }],
    ["unavailable", { kind: "unavailable" }],
  ] as const)("%s: como cualquier pantalla con sesión", (name, expected) => {
    expect(lessonPageStep(check(name), path, false)).toEqual(expected);
    expect(lessonPageStep(check(name), path, true)).toEqual(expected);
  });

  it("sin sesión, la lección de un curso normal manda a entrar; la del abierto, a registrarse", () => {
    expect(lessonPageStep(check("anonymous"), path, false)).toEqual({ kind: "redirect", to: `/entrar?volver=${back}` });
    expect(lessonPageStep(check("anonymous"), path, true)).toEqual({ kind: "redirect", to: `/registro?volver=${back}` });
  });

  it("si no se supo si el curso es abierto, a entrar: es lo que sirve a quien ya tiene cuenta", () => {
    expect(lessonPageStep(check("anonymous"), path, null)).toEqual({ kind: "redirect", to: `/entrar?volver=${back}` });
  });
});

describe("la pantalla que pide lo que le falta a la cuenta", () => {
  it.each([
    ["anonymous", { kind: "redirect", to: "/entrar?volver=%2Finicio%3Fx%3D1" }],
    ["pass", { kind: "redirect", to: "/inicio?x=1" }],
    ["incomplete", { kind: "render", claims, pending }],
    ["suspended", { kind: "suspended" }],
    ["closeToRecover", { kind: "redirect", to: "/sesion/cerrar" }],
    ["closeToSignIn", { kind: "redirect", to: "/sesion/cerrar" }],
    ["unavailable", { kind: "unavailable" }],
  ] as const)("%s", (name, expected) => {
    expect(consentsPageStep(check(name), "/inicio?x=1")).toEqual(expected);
  });

  it("a quien ya no le falta nada lo manda a donde iba, y si ese destino no vale, al inicio", () => {
    expect(consentsPageStep(check("pass"), null)).toEqual({ kind: "redirect", to: "/inicio" });
    expect(consentsPageStep(check("pass"), "//otro.example")).toEqual({ kind: "redirect", to: "/inicio" });
    expect(consentsPageStep(check("pass"), "/consentimientos")).toEqual({ kind: "redirect", to: "/inicio" });
    expect(consentsPageStep(check("anonymous"), "//otro.example")).toEqual({ kind: "redirect", to: "/entrar" });
  });
});

describe("una pantalla de visitante: entrar y registrarse", () => {
  it.each([
    ["anonymous", { kind: "render" }],
    ["pass", { kind: "redirect", to: "/inicio" }],
    ["incomplete", { kind: "redirect", to: "/inicio" }],
    ["suspended", { kind: "redirect", to: "/inicio" }],
    // Una cookie que ya no vale no estorba: entrar cierra la sesión que el navegador traía.
    ["closeToRecover", { kind: "render" }],
    ["closeToSignIn", { kind: "render" }],
    // Cuando no se supo, se deja intentar: entrar tiene su propia respuesta de «no disponible».
    ["unavailable", { kind: "render" }],
  ] as const)("%s", (name, expected) => {
    expect(visitorPageStep(check(name))).toEqual(expected);
  });
});

describe("una pantalla pública que cambia según quién mira (T-210)", () => {
  it("con una sesión que pasa, mira un alumno, con sus claims", () => {
    expect(publicPageStep(check("pass"))).toEqual({ kind: "student", claims });
  });

  // Nunca redirige ni pinta un estado: lo que cualquiera ve, se ve.
  it.each(["anonymous", "closeToRecover", "closeToSignIn"] as const)("%s mira como visitante", (name) => {
    expect(publicPageStep(check(name))).toEqual({ kind: "visitor" });
  });

  // «No se supo» nunca es «sin sesión»: no se le ofrece registrarse a quien quizá ya paga.
  it.each(["incomplete", "suspended", "unavailable"] as const)("%s no se sabe quién es: ni alumno ni visitante", (name) => {
    expect(publicPageStep(check(name))).toEqual({ kind: "unknown" });
  });
});

describe("a dónde va quien pasó por la ruta que cierra una sesión rechazada", () => {
  it.each([
    ["recover", { to: "/recuperar", notice: "choose_password" }],
    ["sign_in", { to: "/entrar", notice: null }],
    ["none", { to: "/entrar", notice: null }],
    ["kept", { to: "/inicio", notice: null }],
  ] as const)("%s", (result, expected) => {
    expect(closedSessionRoute(result)).toEqual(expected);
  });

  it("ninguna salida vuelve a la ruta que cierra: no puede dar vueltas sola", () => {
    for (const result of ["recover", "sign_in", "none", "kept"] as const) {
      expect(closedSessionRoute(result).to).not.toContain("/sesion");
    }
  });
});

// Las pantallas del equipo (T-105; flujo de la app §6.2). La entrada es lo que contesta
// `teamStanding`: lo que la guarda de sesión niega, o el estado que dice la base.

const FACTOR = "22222222-2222-4222-8222-222222222222";
const member: TeamStanding = { state: "member", factor: FACTOR, capabilities: ["content", "support"] };
const standings: Record<string, TeamStanding> = {
  none: { state: "none" },
  invitedUnproven: { state: "invited_unproven", kind: "grant" },
  invited: { state: "invited", kind: "grant", capabilities: ["content"] },
  unbound: { state: "unbound" },
  needsCode: { state: "needs_code", factor: FACTOR },
  member,
};
const team = (standing: TeamStanding, inProgress: string | null = null): TeamCheck => ({ kind: "team", claims, standing, inProgress });
const teamChecks: Record<string, TeamCheck> = {
  anonymous: { kind: "anonymous" },
  incomplete: { kind: "incomplete", claims, ...pending },
  suspended: { kind: "suspended" },
  closeToRecover: { kind: "must_sign_out", then: "recover" },
  closeToSignIn: { kind: "must_sign_out", then: "sign_in" },
  unavailable: { kind: "unavailable" },
  ...Object.fromEntries(Object.entries(standings).map(([name, standing]) => [name, team(standing)])),
};
const teamCheck = (name: string): TeamCheck => {
  const found = teamChecks[name];
  if (!found) throw new Error(`No hay un caso llamado ${name}.`);
  return found;
};

describe("una pantalla de administración", () => {
  it.each([
    ["anonymous", { kind: "redirect", to: "/entrar?volver=%2Fadmin%2Fequipo" }],
    ["incomplete", { kind: "redirect", to: "/consentimientos?volver=%2Fadmin%2Fequipo" }],
    ["suspended", { kind: "suspended" }],
    ["closeToRecover", { kind: "redirect", to: "/sesion/cerrar" }],
    ["closeToSignIn", { kind: "redirect", to: "/sesion/cerrar" }],
    ["unavailable", { kind: "unavailable" }],
    // Quien no es del equipo recibe lo mismo que en una ruta que no existe.
    ["none", { kind: "not_found" }],
    ["invitedUnproven", { kind: "redirect", to: "/entrar/segundo-factor/configurar" }],
    ["invited", { kind: "redirect", to: "/entrar/segundo-factor/configurar" }],
    ["unbound", { kind: "redirect", to: "/entrar/segundo-factor" }],
    ["needsCode", { kind: "redirect", to: "/entrar/segundo-factor?volver=%2Fadmin%2Fequipo" }],
    ["member", { kind: "render", claims, capabilities: ["content", "support"] }],
  ] as const)("%s", (name, expected) => {
    expect(adminPageStep(teamCheck(name), "/admin/equipo")).toEqual(expected);
  });

  it("solo se pinta para quien es del equipo con la sesión que pasa la puerta", () => {
    for (const [name, value] of Object.entries(teamChecks)) {
      expect(adminPageStep(value, "/admin").kind === "render", name).toBe(name === "member");
    }
  });

  it("una pantalla que pide una capacidad se pinta solo a quien la tiene; a quien no, PA-88", () => {
    expect(adminPageStep(teamCheck("member"), "/admin/equipo", "content")).toEqual({
      kind: "render",
      claims,
      capabilities: ["content", "support"],
    });
    expect(adminPageStep(teamCheck("member"), "/admin/equipo", "config")).toEqual({ kind: "forbidden", capability: "config" });
  });

  it("la capacidad pedida no le cambia nada a quien no es del equipo: no se entera de que esa pantalla existe", () => {
    for (const [name, value] of Object.entries(teamChecks)) {
      if (name === "member") continue;
      expect(adminPageStep(value, "/admin/equipo", "config"), name).toEqual(adminPageStep(value, "/admin/equipo"));
    }
  });

  it("lo que una invitación ofrece todavía no se tiene", () => {
    const offered = team({ state: "invited", kind: "grant", capabilities: ["config"] });
    expect(adminPageStep(offered, "/admin", "config")).toEqual({ kind: "redirect", to: "/entrar/segundo-factor/configurar" });
  });

  it("una ruta que no vale como destino no se guarda", () => {
    expect(adminPageStep(teamCheck("anonymous"), "/admin/%2e%2e/x")).toEqual({ kind: "redirect", to: "/entrar" });
    expect(adminPageStep(teamCheck("needsCode"), "/admin//otro.example")).toEqual({ kind: "redirect", to: "/entrar/segundo-factor" });
  });
});

describe("la pantalla de dar el código del segundo factor", () => {
  it.each([
    ["anonymous", { kind: "redirect", to: "/entrar?volver=%2Fadmin%2Fequipo" }],
    ["incomplete", { kind: "redirect", to: "/consentimientos?volver=%2Fadmin%2Fequipo" }],
    ["suspended", { kind: "suspended" }],
    ["closeToRecover", { kind: "redirect", to: "/sesion/cerrar" }],
    ["closeToSignIn", { kind: "redirect", to: "/sesion/cerrar" }],
    ["unavailable", { kind: "unavailable" }],
    ["none", { kind: "not_found" }],
    ["invitedUnproven", { kind: "redirect", to: "/entrar/segundo-factor/configurar" }],
    ["invited", { kind: "redirect", to: "/entrar/segundo-factor/configurar" }],
    ["unbound", { kind: "render", view: "unbound" }],
    ["needsCode", { kind: "render", view: "code" }],
    ["member", { kind: "redirect", to: "/admin/equipo" }],
  ] as const)("%s", (name, expected) => {
    expect(secondFactorPageStep(teamCheck(name), "/admin/equipo")).toEqual(expected);
  });

  it("quien ya dio su código y no trae un destino que valga va a administración", () => {
    for (const returnTo of [null, undefined, "", "//otro.example", "/entrar/segundo-factor"]) {
      expect(secondFactorPageStep(teamCheck("member"), returnTo)).toEqual({ kind: "redirect", to: "/admin" });
      expect(secondFactorPageStep(teamCheck("anonymous"), returnTo)).toEqual({ kind: "redirect", to: "/entrar" });
      expect(secondFactorPageStep(teamCheck("incomplete"), returnTo)).toEqual({ kind: "redirect", to: "/consentimientos" });
    }
  });
});

describe("la pantalla de configurar el segundo factor", () => {
  it.each([
    ["anonymous", { kind: "redirect", to: "/entrar" }],
    ["incomplete", { kind: "redirect", to: "/consentimientos" }],
    ["suspended", { kind: "suspended" }],
    ["closeToRecover", { kind: "redirect", to: "/sesion/cerrar" }],
    ["closeToSignIn", { kind: "redirect", to: "/sesion/cerrar" }],
    ["unavailable", { kind: "unavailable" }],
    ["none", { kind: "not_found" }],
    ["invitedUnproven", { kind: "render", view: "prove_mailbox" }],
    ["invited", { kind: "render", view: "start", handoff: false }],
    ["unbound", { kind: "redirect", to: "/entrar/segundo-factor" }],
    ["needsCode", { kind: "redirect", to: "/entrar/segundo-factor" }],
    ["member", { kind: "redirect", to: "/admin" }],
  ] as const)("%s", (name, expected) => {
    expect(factorSetupPageStep(teamCheck(name))).toEqual(expected);
  });

  it("una invitación de restablecimiento pide además el código dictado", () => {
    const rebind: TeamStanding = { state: "invited", kind: "rebind", capabilities: [] };
    expect(factorSetupPageStep(team(rebind))).toEqual({ kind: "render", view: "start", handoff: true });
    expect(factorSetupPageStep(team(rebind, FACTOR))).toEqual({ kind: "render", view: "resume", painted: FACTOR, handoff: true });
  });

  it("con un factor ya empezado en ese navegador pinta el campo del código, sin la clave", () => {
    expect(factorSetupPageStep(team(standings.invited as TeamStanding, FACTOR))).toEqual({
      kind: "render",
      view: "resume",
      painted: FACTOR,
      handoff: false,
    });
  });

  it("el factor empezado no le cambia nada a quien no tiene una invitación que pueda aceptar", () => {
    for (const [name, standing] of Object.entries(standings)) {
      if (name === "invited") continue;
      expect(factorSetupPageStep(team(standing, FACTOR)), name).toEqual(factorSetupPageStep(team(standing)));
    }
  });
});

describe("las tres pantallas del equipo, juntas", () => {
  const pages = {
    admin: (check: TeamCheck) => adminPageStep(check, "/admin"),
    secondFactor: (check: TeamCheck) => secondFactorPageStep(check, "/admin"),
    factorSetup: (check: TeamCheck) => factorSetupPageStep(check),
  };
  const own = { admin: "/admin", secondFactor: "/entrar/segundo-factor", factorSetup: "/entrar/segundo-factor/configurar" };
  const pathOf = (to: string) => to.split("?")[0];

  it("ninguna se redirige a sí misma", () => {
    for (const [page, step] of Object.entries(pages) as [keyof typeof pages, (check: TeamCheck) => { kind: string; to?: string }][]) {
      for (const [name, value] of Object.entries(teamChecks)) {
        const result = step(value);
        if (result.kind === "redirect") expect(pathOf(result.to ?? ""), `${page} con ${name}`).not.toBe(own[page]);
      }
    }
  });

  it("cada estado del equipo termina en una pantalla que lo pinta: no hay vueltas", () => {
    const byPath: Record<string, (check: TeamCheck) => { kind: string; to?: string }> = {
      "/admin": pages.admin,
      "/entrar/segundo-factor": pages.secondFactor,
      "/entrar/segundo-factor/configurar": pages.factorSetup,
    };
    for (const [name, standing] of Object.entries(standings)) {
      for (const start of Object.keys(byPath)) {
        let at = start;
        let result = byPath[at]?.(team(standing));
        for (let hops = 0; result?.kind === "redirect" && hops < 4; hops += 1) {
          at = pathOf(result.to ?? "") ?? "";
          result = byPath[at]?.(team(standing));
        }
        expect(result?.kind, `${name} desde ${start}`).not.toBe("redirect");
        expect(result, `${name} desde ${start}`).toBeDefined();
      }
    }
  });

  it("«no se supo» nunca se trata como «no es del equipo», ni manda a entrar", () => {
    for (const step of Object.values(pages)) expect(step(teamCheck("unavailable"))).toEqual({ kind: "unavailable" });
  });

  it("quien no es del equipo recibe lo mismo en las tres: que esa ruta no existe", () => {
    for (const step of Object.values(pages)) expect(step(teamCheck("none"))).toEqual({ kind: "not_found" });
  });
});
