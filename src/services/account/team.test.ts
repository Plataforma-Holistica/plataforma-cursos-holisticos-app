import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";

import type { SessionCheck } from "./admission";
import { createEnrolledFactors } from "./enrolled-factor";
import { createMailboxTickets } from "./mailbox-ticket";
import { createTeam, handoffPrint, withLockRetry, type AcceptAnswer, type TeamStanding } from "./team";

// Los servicios del equipo, con todo lo de fuera simulado: aquí se prueba qué deciden con
// cada respuesta de la guarda, de la base y de Auth, y en qué orden llaman. Contra el Auth y
// la base de verdad se prueban en `tests/integration/34-equipo-servicios.test.ts`.

const SESSION = "5e000000-0000-4000-8000-000000000001";
const FACTOR = "fa000000-0000-4000-8000-000000000001";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal1", sessionId: SESSION, issuedAt: 0 } as VerifiedClaims;
const raised = { ...claims, aal: "aal2" } as VerifiedClaims;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const tickets = createMailboxTickets({ secure: () => false });
const factors = createEnrolledFactors({ secure: () => false });
const TICKET = "t".repeat(43);

function jarOf(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (name: string) => values.get(name),
    set(name: string, value: string, options: { maxAge: number }) {
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}

/** Un navegador con el resguardo del buzón y, si se pide, con el factor dado de alta en esta sesión. */
const browser = (withFactor = true, session = SESSION) =>
  jarOf({ "plataforma-resguardo": TICKET, ...(withFactor ? { "plataforma-factor": `${session}.${FACTOR}` } : {}) });

const INVITED: TeamStanding = { state: "invited", kind: "grant", capabilities: ["support"] };
const REBIND: TeamStanding = { state: "invited", kind: "rebind", capabilities: [] };
const MEMBER: TeamStanding = { state: "member", factor: BOUND, capabilities: ["config"] };

interface Setup {
  check?: SessionCheck;
  standing?: TeamStanding | TeamStanding[] | "throws";
  accept?: AcceptAnswer | "throws";
  enroll?: unknown;
  verify?: unknown;
  remove?: "removed" | "unknown";
  signOut?: "closed" | "unknown";
}

function teamWith(setup: Setup = {}) {
  const calls: string[] = [];
  const reported: string[] = [];
  const standings = Array.isArray(setup.standing) ? [...setup.standing] : null;
  const auth = {
    enrollFactor: vi.fn(() => {
      calls.push("enroll");
      return Promise.resolve(setup.enroll ?? { ok: true, factorId: FACTOR, secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" });
    }),
    verifyFactor: vi.fn((_jar: unknown, factorId: string, code: string) => {
      calls.push(`verify ${factorId} ${code}`);
      return Promise.resolve(setup.verify ?? { kind: "verified", claims: raised });
    }),
    removeFactor: vi.fn((_jar: unknown, factorId: string) => {
      calls.push(`remove ${factorId}`);
      return Promise.resolve(setup.remove ?? "removed");
    }),
    signOut: vi.fn(() => {
      calls.push("signOut");
      return Promise.resolve(setup.signOut ?? "closed");
    }),
  };
  const store = {
    standing: vi.fn((asked: VerifiedClaims, print: string | null) => {
      calls.push(`standing ${asked.aal} ${print === null ? "sin" : print === sha256(TICKET) ? "resguardo" : "otro"}`);
      if (setup.standing === "throws") return Promise.reject(new Error("sin base"));
      if (standings) return Promise.resolve(standings.length > 1 ? (standings.shift() as TeamStanding) : (standings[0] as TeamStanding));
      return Promise.resolve((setup.standing as TeamStanding | undefined) ?? INVITED);
    }),
    accept: vi.fn((asked: VerifiedClaims, print: string, factorId: string, handoff: string | null) => {
      calls.push(`accept ${asked.aal} ${print === sha256(TICKET) ? "resguardo" : "otro"} ${factorId} ${handoff ?? "sin"}`);
      if (setup.accept === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.accept ?? "accepted");
    }),
  };
  const team = createTeam(
    {
      auth: auth as never,
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { checkSession: () => Promise.resolve(setup.check ?? { kind: "pass", claims }), store, tickets, factors },
  );
  return { ...team, calls, reported, auth, store };
}

const REFUSALS: SessionCheck[] = [
  { kind: "anonymous" },
  { kind: "suspended" },
  { kind: "must_sign_out", then: "recover" },
  { kind: "unavailable" },
  { kind: "incomplete", claims, variant: "complete_account", missing: { name: true, adultDeclaration: false, documents: [] } },
];

describe("el código dictado al restablecer", () => {
  it.each([
    ["AB12CD34", "AB12CD34"],
    ["ab12cd34", "AB12CD34"],
    ["ab12-cd34", "AB12CD34"],
    ["  ab12 cd34  ", "AB12CD34"],
    ["A".repeat(32), "A".repeat(32)],
  ])("%j se normaliza antes de sacarle la huella", (typed, normal) => {
    expect(handoffPrint(typed)).toBe(sha256(normal));
  });

  it.each([undefined, null, 12345678, "", "   ", "corto12", "A".repeat(33), "ab12/cd34", "ab12ñd34", ["AB12CD34"]])(
    "lo que no tiene forma de código (%j) no tiene huella",
    (typed) => {
      expect(handoffPrint(typed)).toBeNull();
    },
  );
});

describe("reintentar cuando la base cortó a uno de dos", () => {
  const retryable = (error: unknown) => error === "candado";

  it("lo que sale bien a la primera no se repite", async () => {
    const work = vi.fn(() => Promise.resolve("listo"));
    expect(await withLockRetry(work, retryable)).toBe("listo");
    expect(work).toHaveBeenCalledOnce();
  });

  it("un corte por candado se reintenta una vez", async () => {
    const work = vi.fn().mockRejectedValueOnce("candado").mockResolvedValueOnce("listo");
    expect(await withLockRetry(work, retryable)).toBe("listo");
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("y solo una: si insiste, se cae", async () => {
    const work = vi.fn(() => Promise.reject("candado"));
    await expect(withLockRetry(work, retryable)).rejects.toBe("candado");
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("otro fallo no se reintenta", async () => {
    const work = vi.fn(() => Promise.reject("otra cosa"));
    await expect(withLockRetry(work, retryable)).rejects.toBe("otra cosa");
    expect(work).toHaveBeenCalledOnce();
  });
});

describe("en qué estado está quien pide", () => {
  it.each(REFUSALS)("si la guarda de sesión no deja pasar (%j), eso es lo que se contesta, sin preguntar más", async (check) => {
    const team = teamWith({ check });
    expect(await team.teamStanding(browser())).toEqual(check);
    expect(team.calls).toEqual([]);
  });

  it("con sesión que pasa, pregunta a la base con las claims de la guarda y la huella del resguardo del navegador", async () => {
    const team = teamWith({ standing: MEMBER });
    expect(await team.teamStanding(browser())).toEqual({ kind: "team", claims, standing: MEMBER });
    expect(team.calls).toEqual(["standing aal1 resguardo"]);
  });

  it("sin resguardo en el navegador pregunta sin él", async () => {
    const team = teamWith({ standing: { state: "none" } });
    await team.teamStanding(jarOf());
    expect(team.calls).toEqual(["standing aal1 sin"]);
  });

  it("si la base no contesta, no se supo, y queda dicho", async () => {
    const team = teamWith({ standing: "throws" });
    expect(await team.teamStanding(browser())).toEqual({ kind: "unavailable" });
    expect(team.reported).toEqual(["team_unavailable"]);
  });
});

describe("empezar a configurar el segundo factor", () => {
  it.each(REFUSALS)("sin sesión que pase (%j) no empieza nada", async (check) => {
    const team = teamWith({ check });
    expect(await team.startSecondFactor(browser(false))).toEqual(check);
    expect(team.calls).toEqual([]);
  });

  it.each<[TeamStanding, string]>([
    [{ state: "none" }, "not_invited"],
    [{ state: "unbound" }, "not_invited"],
    [MEMBER, "not_invited"],
    [{ state: "needs_code", factor: BOUND }, "not_invited"],
    [{ state: "invited_unproven", kind: "grant" }, "needs_mailbox_proof"],
  ])("quien está en %j no da de alta ningún factor", async (standing, kind) => {
    const team = teamWith({ standing });
    expect(await team.startSecondFactor(browser(false))).toEqual({ kind });
    expect(team.auth.enrollFactor).not.toHaveBeenCalled();
  });

  it("la persona invitada con su resguardo: se da de alta, y el factor queda anotado en ese navegador, atado a esa sesión", async () => {
    const team = teamWith();
    const jar = browser(false);
    expect(await team.startSecondFactor(jar)).toEqual({
      kind: "started",
      factorId: FACTOR,
      secret: "JBSWY3DPEHPK3PXP",
      uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
    });
    expect(jar.get("plataforma-factor")).toBe(`${SESSION}.${FACTOR}`);
    expect(team.calls).toEqual(["standing aal1 resguardo", "enroll"]);
  });

  it("si la cuenta ya tiene un factor verificado y la sesión no ha subido de nivel, se dice: no es una caída", async () => {
    const enroll = { ok: false, reason: "needs_second_level" };
    // Haya o no un factor anotado en ese navegador: dar de alta ya quitó los que estaban a
    // medias, así que no promete ninguno con el que seguir.
    for (const jar of [browser(true), browser(false)]) {
      const team = teamWith({ enroll });
      expect(await team.startSecondFactor(jar)).toEqual({ kind: "needs_second_level" });
      expect(team.reported).toEqual([]);
    }
  });

  it.each(["no_session", "unknown"])("si Auth contesta %s, no se supo: no queda nada anotado", async (reason) => {
    const team = teamWith({ enroll: { ok: false, reason } });
    const jar = browser(false);
    expect(await team.startSecondFactor(jar)).toEqual({ kind: "unavailable" });
    expect(jar.get("plataforma-factor")).toBeUndefined();
  });

  it.each([null, "", "no-es-una-sesion"])("si no hay con qué anotarlo (sesión %j), no se supo: sin anotación no habría cómo verificarlo", async (sessionId) => {
    const team = teamWith({ check: { kind: "pass", claims: { ...claims, sessionId } as VerifiedClaims } });
    const jar = browser(false);
    expect(await team.startSecondFactor(jar)).toEqual({ kind: "unavailable" });
    expect(jar.get("plataforma-factor")).toBeUndefined();
  });
});

describe("confirmar el segundo factor, que acepta la invitación", () => {
  it.each(REFUSALS)("sin sesión que pase (%j) no verifica nada", async (check) => {
    const team = teamWith({ check });
    expect(await team.confirmSecondFactor(browser(), { code: "123456" })).toEqual(check);
    expect(team.calls).toEqual([]);
  });

  it.each<[TeamStanding, string]>([
    [{ state: "none" }, "not_invited"],
    [{ state: "unbound" }, "not_invited"],
    [MEMBER, "not_invited"],
    [{ state: "needs_code", factor: BOUND }, "not_invited"],
    [{ state: "invited_unproven", kind: "rebind" }, "needs_mailbox_proof"],
  ])("quien está en %j no verifica ni acepta", async (standing, kind) => {
    const team = teamWith({ standing });
    expect(await team.confirmSecondFactor(browser(), { code: "123456" })).toEqual({ kind });
    expect(team.auth.verifyFactor).not.toHaveBeenCalled();
    expect(team.store.accept).not.toHaveBeenCalled();
  });

  it("sin un factor dado de alta en este navegador y en esta sesión, hay que empezar de nuevo", async () => {
    for (const jar of [browser(false), browser(true, "5e000000-0000-4000-8000-0000000000ff")]) {
      const team = teamWith();
      expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "start_again" });
      expect(team.auth.verifyFactor).not.toHaveBeenCalled();
    }
  });

  it("sin el resguardo en este navegador no se verifica ni se acepta, diga lo que diga el estado", async () => {
    // La base no diría «invitada» sin el resguardo: es una segunda barrera, por si lo dijera.
    const team = teamWith({ standing: INVITED });
    const jar = jarOf({ "plataforma-factor": `${SESSION}.${FACTOR}` });
    expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "needs_mailbox_proof" });
    expect(team.calls).toEqual(["standing aal1 sin"]);
    expect(jar.get("plataforma-factor")).toBe(`${SESSION}.${FACTOR}`);
  });

  it("con todo en su lugar: verifica ese factor, acepta con las claims nuevas, limpia el navegador y cierra la sesión", async () => {
    const team = teamWith();
    const jar = browser();
    expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "accepted" });
    expect(team.calls).toEqual([
      "standing aal1 resguardo",
      `verify ${FACTOR} 123456`,
      // Con las claims que devolvió verificar, no con las de antes.
      `accept aal2 resguardo ${FACTOR} sin`,
      "signOut",
    ]);
    expect(jar.get("plataforma-resguardo")).toBeUndefined();
    expect(jar.get("plataforma-factor")).toBeUndefined();
    expect(team.reported).toEqual([]);
  });

  it("si la sesión no se pudo cerrar al final, se aceptó igual y queda dicho", async () => {
    const team = teamWith({ signOut: "unknown" });
    expect(await team.confirmSecondFactor(browser(), { code: "123456" })).toEqual({ kind: "accepted" });
    expect(team.reported).toEqual(["session_not_closed"]);
  });

  it.each<[unknown, string, boolean, string[]]>([
    [{ kind: "wrong_code" }, "wrong_code", true, []],
    [{ kind: "throttled" }, "throttled", true, []],
    [{ kind: "factor_gone" }, "start_again", false, []],
    [{ kind: "no_session" }, "signed_out", true, []],
    // El adaptador ya cerró esa sesión: que alguien lo sepa, como cuando pasa al entrar.
    [{ kind: "oversized_session" }, "signed_out", true, ["session_oversized"]],
    [{ kind: "unknown" }, "unavailable", true, []],
  ])("si verificar contesta %j, no se acepta nada", async (verify, kind, keepsFactor, reported) => {
    const team = teamWith({ verify });
    const jar = browser();
    expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind });
    expect(team.store.accept).not.toHaveBeenCalled();
    expect(team.auth.signOut).not.toHaveBeenCalled();
    // El resguardo no se toca: sirve para el siguiente intento.
    expect(jar.get("plataforma-resguardo")).toBe(TICKET);
    expect(jar.get("plataforma-factor") !== undefined).toBe(keepsFactor);
    expect(team.reported).toEqual(reported);
  });

  describe("un restablecimiento pide además el código dictado", () => {
    it.each([undefined, "", "corto", 12345678])("sin un código con forma (%j) no se verifica ni se llama a la base: un nulo gastaría un intento", async (handoff) => {
      const team = teamWith({ standing: REBIND });
      expect(await team.confirmSecondFactor(browser(), { code: "123456", handoff })).toEqual({ kind: "needs_handoff" });
      expect(team.calls).toEqual(["standing aal1 resguardo"]);
    });

    it("con él, a la base le llega su huella", async () => {
      const team = teamWith({ standing: REBIND });
      expect(await team.confirmSecondFactor(browser(), { code: "123456", handoff: "ab12-cd34" })).toEqual({ kind: "accepted" });
      expect(team.calls).toContain(`accept aal2 resguardo ${FACTOR} ${sha256("AB12CD34")}`);
    });

    it("si no es el que es, se dice, y el factor ya verificado se queda para el siguiente intento", async () => {
      const team = teamWith({ standing: REBIND, accept: "needs_handoff" });
      const jar = browser();
      expect(await team.confirmSecondFactor(jar, { code: "123456", handoff: "ZZ99ZZ99" })).toEqual({ kind: "needs_handoff" });
      // Se volvió a leer el estado, y la invitación sigue viva.
      expect(team.calls.slice(-1)).toEqual(["standing aal2 resguardo"]);
      expect(team.auth.removeFactor).not.toHaveBeenCalled();
      expect(team.auth.signOut).not.toHaveBeenCalled();
      expect(jar.get("plataforma-factor")).toBe(`${SESSION}.${FACTOR}`);
      expect(team.reported).toEqual([]);
    });

    // El fallo que llega al límite revoca la invitación, y la base contesta el mismo
    // «el código dictado no es». Sin invitación no hay siguiente intento: el factor
    // verificado se quedaría en la cuenta sin que nadie lo atara.
    it.each<TeamStanding>([{ state: "unbound" }, { state: "none" }])(
      "si con ese fallo la invitación dejó de existir (%j), el factor se quita y ya no se pide el código dictado",
      async (now) => {
        const team = teamWith({ standing: [REBIND, now], accept: "needs_handoff" });
        const jar = browser();
        expect(await team.confirmSecondFactor(jar, { code: "123456", handoff: "ZZ99ZZ99" })).toEqual({ kind: "not_invited" });
        expect(team.calls.slice(-2)).toEqual(["standing aal2 resguardo", `remove ${FACTOR}`]);
        expect(jar.get("plataforma-factor")).toBeUndefined();
        expect(team.auth.signOut).not.toHaveBeenCalled();
      },
    );

    it.each<TeamStanding | "throws">([{ state: "invited_unproven", kind: "rebind" }, "throws"])(
      "si después del fallo el estado es %j, el factor se queda: la invitación sigue viva, o no se supo, y a ciegas no se quita nada",
      async (now) => {
        const team = teamWith({ accept: "needs_handoff" });
        team.store.standing.mockResolvedValueOnce(REBIND);
        if (now === "throws") team.store.standing.mockRejectedValueOnce(new Error("sin base"));
        else team.store.standing.mockResolvedValueOnce(now);
        const jar = browser();
        expect(await team.confirmSecondFactor(jar, { code: "123456", handoff: "ZZ99ZZ99" })).toEqual({ kind: "needs_handoff" });
        expect(team.auth.removeFactor).not.toHaveBeenCalled();
        expect(team.auth.signOut).not.toHaveBeenCalled();
        expect(jar.get("plataforma-factor")).toBe(`${SESSION}.${FACTOR}`);
        expect(team.reported).toEqual([]);
      },
    );

    // Dos envíos casi a la vez, uno con el código dictado mal y otro bien: al malo la base
    // le cuenta el fallo, y cuando vuelve a mirar, el bueno ya ató.
    it.each<TeamStanding>([MEMBER, { state: "needs_code", factor: FACTOR }])(
      "si después del fallo ya tiene su atadura (%j), se aceptó en otro envío: no se le quita nada",
      async (now) => {
        const team = teamWith({ standing: [REBIND, now], accept: "needs_handoff" });
        const jar = browser();
        expect(await team.confirmSecondFactor(jar, { code: "123456", handoff: "ZZ99ZZ99" })).toEqual({ kind: "accepted" });
        expect(team.auth.removeFactor).not.toHaveBeenCalled();
        expect(team.calls.slice(-1)).toEqual(["signOut"]);
        expect(team.reported).toEqual([]);
      },
    );

    it("una invitación que da capacidades no manda código dictado aunque llegue uno", async () => {
      const team = teamWith({ standing: INVITED });
      await team.confirmSecondFactor(browser(), { code: "123456", handoff: "AB12CD34" });
      expect(team.calls).toContain(`accept aal2 resguardo ${FACTOR} sin`);
    });
  });

  describe("cuando verificar subió el nivel y aceptar dice que no", () => {
    it.each<[AcceptAnswer, string]>([
      ["inviter_lost_config", "not_invited"],
      ["ineligible", "not_invited"],
      ["needs_mailbox_proof", "needs_mailbox_proof"],
    ])("con %s el factor recién verificado se quita: no puede quedar un factor que nadie ató", async (accept, kind) => {
      const team = teamWith({ accept });
      const jar = browser();
      expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind });
      expect(team.calls.slice(-1)).toEqual([`remove ${FACTOR}`]);
      expect(jar.get("plataforma-factor")).toBeUndefined();
      expect(team.auth.signOut).not.toHaveBeenCalled();
      expect(team.reported).toEqual([]);
    });

    it("si no se pudo quitar, queda dicho", async () => {
      const team = teamWith({ accept: "ineligible", remove: "unknown" });
      expect(await team.confirmSecondFactor(browser(), { code: "123456" })).toEqual({ kind: "not_invited" });
      expect(team.reported).toEqual(["second_factor_not_removed"]);
    });

    // La regla es una sola: nunca se le quita un factor a alguien sin haber visto, después
    // del no, que no quedó atada. Vale para todo no, también los que no deberían poder
    // llegar con la persona atada: basta una carrera con otro envío para que lleguen.
    describe.each<AcceptAnswer>(["inviter_lost_config", "ineligible", "needs_mailbox_proof", "no_invitation", "already_bound"])(
      "antes de quitar el factor por %s se vuelve a leer el estado",
      (accept) => {
        it("se lee después de aceptar, con las claims de la sesión ya subida", async () => {
          const team = teamWith({ accept });
          await team.confirmSecondFactor(browser(), { code: "123456" });
          expect(team.calls.slice(-3)).toEqual([expect.stringContaining("accept aal2"), "standing aal2 resguardo", `remove ${FACTOR}`]);
        });

        it.each<TeamStanding>([MEMBER, { state: "needs_code", factor: FACTOR }])("si ya tiene su atadura (%j), no se le quita: se aceptó", async (now) => {
          const team = teamWith({ accept, standing: [INVITED, now] });
          const jar = browser();
          expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "accepted" });
          expect(team.auth.removeFactor).not.toHaveBeenCalled();
          expect(team.calls.slice(-1)).toEqual(["signOut"]);
          expect(team.reported).toEqual([]);
        });

        it.each<TeamStanding>([{ state: "none" }, { state: "unbound" }, INVITED, { state: "invited_unproven", kind: "grant" }])(
          "si sigue sin atadura (%j), el factor se quita, y se contesta lo que dijo la base",
          async (now) => {
            const team = teamWith({ accept, standing: [INVITED, now] });
            const jar = browser();
            expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({
              kind: accept === "needs_mailbox_proof" ? "needs_mailbox_proof" : "not_invited",
            });
            expect(team.calls.slice(-1)).toEqual([`remove ${FACTOR}`]);
            expect(team.auth.signOut).not.toHaveBeenCalled();
            expect(jar.get("plataforma-factor")).toBeUndefined();
            expect(team.reported).toEqual([]);
          },
        );

        it("si al volver a leer no se supo, no se quita nada y queda dicho", async () => {
          const team = teamWith({ accept });
          team.store.standing.mockResolvedValueOnce(INVITED).mockRejectedValueOnce(new Error("sin base"));
          const jar = browser();
          expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "unavailable" });
          expect(team.auth.removeFactor).not.toHaveBeenCalled();
          expect(team.auth.signOut).not.toHaveBeenCalled();
          expect(jar.get("plataforma-factor")).toBe(`${SESSION}.${FACTOR}`);
          expect(team.reported).toEqual(["invitation_not_accepted"]);
        });
      },
    );

    it.each<AcceptAnswer>(["needs_code", "unavailable"])("con %s, que es falta de configuración, no hace falta volver a leer: nada se quita", async (accept) => {
      const team = teamWith({ accept });
      await team.confirmSecondFactor(browser(), { code: "123456" });
      expect(team.calls.slice(-1)).toEqual([expect.stringContaining("accept aal2")]);
    });

    it("y aceptada, tampoco: no se pregunta de más", async () => {
      const team = teamWith();
      await team.confirmSecondFactor(browser(), { code: "123456" });
      expect(team.store.standing).toHaveBeenCalledOnce();
    });

    // Un doble envío: el primero ya aceptó, y al segundo la base le dice que no hay
    // invitación. El factor de este navegador es el que quedó atado: quitarlo dejaría a la
    // persona sin con qué entrar. Vale también si esta sesión no pasa la puerta (el primero
    // ya la cerró, o falta la vigencia del segundo factor): atada es atada.
    describe.each<AcceptAnswer>(["no_invitation", "already_bound"])("con %s se vuelve a preguntar el estado", (accept) => {
      it.each<TeamStanding>([MEMBER, { state: "needs_code", factor: FACTOR }, { state: "needs_code", factor: BOUND }])(
        "si ya tiene su atadura (%j), es que ya se había aceptado: no se le quita nada",
        async (now) => {
          const team = teamWith({ accept, standing: [INVITED, now] });
          const jar = browser();
          expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "accepted" });
          expect(team.calls).toEqual(["standing aal1 resguardo", `verify ${FACTOR} 123456`, expect.stringContaining("accept aal2"), "standing aal2 resguardo", "signOut"]);
          expect(team.auth.removeFactor).not.toHaveBeenCalled();
          expect(jar.get("plataforma-resguardo")).toBeUndefined();
          expect(jar.get("plataforma-factor")).toBeUndefined();
          expect(team.reported).toEqual([]);
        },
      );

      it.each<TeamStanding>([{ state: "none" }, { state: "unbound" }, INVITED, { state: "invited_unproven", kind: "grant" }])(
        "si sigue sin atadura (%j), ya no hay invitación que aceptar: el factor recién verificado se quita",
        async (now) => {
          const team = teamWith({ accept, standing: [INVITED, now] });
          const jar = browser();
          expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "not_invited" });
          expect(team.calls.slice(-1)).toEqual([`remove ${FACTOR}`]);
          expect(team.auth.signOut).not.toHaveBeenCalled();
          expect(jar.get("plataforma-factor")).toBeUndefined();
        },
      );
    });

    it.each<AcceptAnswer | "throws">(["needs_code", "unavailable", "throws"])(
      "con %s no se supo: el factor se queda, para reintentar, y queda dicho",
      async (accept) => {
        const team = teamWith({ accept });
        const jar = browser();
        expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "unavailable" });
        expect(team.auth.removeFactor).not.toHaveBeenCalled();
        expect(team.auth.signOut).not.toHaveBeenCalled();
        expect(jar.get("plataforma-factor")).toBe(`${SESSION}.${FACTOR}`);
        expect(jar.get("plataforma-resguardo")).toBe(TICKET);
        expect(team.reported).toEqual(["invitation_not_accepted"]);
      },
    );

    // La transacción pudo confirmarse y perderse su respuesta. Si la persona ya tiene su
    // atadura, se aceptó: decirle «inténtalo de nuevo» la mandaría a un «no estás invitada».
    it.each<TeamStanding>([MEMBER, { state: "needs_code", factor: FACTOR }])(
      "si aceptar no contesta y al volver a preguntar ya tiene su atadura (%j), se aceptó",
      async (now) => {
        const team = teamWith({ accept: "throws", standing: [INVITED, now] });
        const jar = browser();
        expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "accepted" });
        expect(team.calls.slice(-2)).toEqual(["standing aal2 resguardo", "signOut"]);
        expect(team.auth.removeFactor).not.toHaveBeenCalled();
        expect(jar.get("plataforma-resguardo")).toBeUndefined();
        expect(jar.get("plataforma-factor")).toBeUndefined();
        // A la persona se le dice que sí, y a quien opera, que la base no contestó bien.
        expect(team.reported).toEqual(["invitation_answer_lost"]);
      },
    );

    it.each<TeamStanding>([INVITED, { state: "invited_unproven", kind: "grant" }, { state: "none" }, { state: "unbound" }])(
      "si aceptar no contesta y sigue sin atadura (%j), no se supo: nada se quita, y queda dicho",
      async (now) => {
        const team = teamWith({ accept: "throws", standing: [INVITED, now] });
        const jar = browser();
        expect(await team.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "unavailable" });
        expect(team.auth.removeFactor).not.toHaveBeenCalled();
        expect(team.auth.signOut).not.toHaveBeenCalled();
        expect(jar.get("plataforma-factor")).toBe(`${SESSION}.${FACTOR}`);
        expect(team.reported).toEqual(["invitation_not_accepted"]);
      },
    );

    it("si aceptar no contesta y la base tampoco al volver a preguntar, no se supo", async () => {
      const team = teamWith({ accept: "throws" });
      team.store.standing.mockResolvedValueOnce(INVITED).mockRejectedValueOnce(new Error("sin base"));
      expect(await team.confirmSecondFactor(browser(), { code: "123456" })).toEqual({ kind: "unavailable" });
      expect(team.auth.removeFactor).not.toHaveBeenCalled();
      expect(team.reported).toEqual(["invitation_not_accepted"]);
    });

    it("si al volver a preguntar el estado la base no contesta, no se supo", async () => {
      const team = teamWith({ accept: "no_invitation" });
      team.store.standing.mockResolvedValueOnce(INVITED).mockRejectedValueOnce(new Error("sin base"));
      expect(await team.confirmSecondFactor(browser(), { code: "123456" })).toEqual({ kind: "unavailable" });
      expect(team.auth.removeFactor).not.toHaveBeenCalled();
      expect(team.reported).toEqual(["invitation_not_accepted"]);
    });
  });
});

describe("dar el código al entrar", () => {
  it.each(REFUSALS)("sin sesión que pase (%j) no verifica nada", async (check) => {
    const team = teamWith({ check });
    expect(await team.giveSecondFactorCode(browser(), "123456")).toEqual(check);
    expect(team.calls).toEqual([]);
  });

  it.each<TeamStanding>([{ state: "none" }, { state: "unbound" }, INVITED, { state: "invited_unproven", kind: "grant" }])(
    "quien está en %j no tiene código que dar",
    async (standing) => {
      const team = teamWith({ standing });
      expect(await team.giveSecondFactorCode(browser(), "123456")).toEqual({ kind: "not_member" });
      expect(team.auth.verifyFactor).not.toHaveBeenCalled();
    },
  );

  it("a quien le falta el código se le verifica el factor que dice la base, no el que diga el navegador", async () => {
    const team = teamWith({ standing: [{ state: "needs_code", factor: BOUND }, MEMBER] });
    expect(await team.giveSecondFactorCode(browser(), "123456")).toEqual({ kind: "verified" });
    expect(team.calls).toEqual(["standing aal1 resguardo", `verify ${BOUND} 123456`, "standing aal2 resguardo"]);
  });

  it("quien ya es del equipo puede darlo otra vez: es como se refresca antes de cambiar el equipo", async () => {
    const team = teamWith({ standing: MEMBER });
    expect(await team.giveSecondFactorCode(browser(), "123456")).toEqual({ kind: "verified" });
    expect(team.calls).toContain(`verify ${BOUND} 123456`);
  });

  it("si después de verificar la base sigue sin verla del equipo, no se supo, y queda dicho", async () => {
    const team = teamWith({ standing: { state: "needs_code", factor: BOUND } });
    expect(await team.giveSecondFactorCode(browser(), "123456")).toEqual({ kind: "unavailable" });
    expect(team.reported).toEqual(["team_unavailable"]);
  });

  it.each<[unknown, string, string[]]>([
    [{ kind: "wrong_code" }, "wrong_code", []],
    [{ kind: "throttled" }, "throttled", []],
    [{ kind: "factor_gone" }, "not_member", []],
    [{ kind: "no_session" }, "signed_out", []],
    // El adaptador ya cerró esa sesión: que alguien lo sepa, como cuando pasa al entrar.
    [{ kind: "oversized_session" }, "signed_out", ["session_oversized"]],
    [{ kind: "unknown" }, "unavailable", []],
  ])("si verificar contesta %j, se dice eso", async (verify, kind, reported) => {
    const team = teamWith({ standing: { state: "needs_code", factor: BOUND }, verify });
    expect(await team.giveSecondFactorCode(browser(), "123456")).toEqual({ kind });
    // No se vuelve a preguntar el estado: nada cambió.
    expect(team.store.standing).toHaveBeenCalledOnce();
    expect(team.reported).toEqual(reported);
  });
});
