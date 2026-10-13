import { describe, expect, it } from "vitest";

import { ACCEPT_ANSWERS } from "./team";
import { GRANT_ANSWERS, INVITE_ANSWERS, RESET_ANSWERS, REVOKE_ANSWERS, REVOKE_INVITATION_ANSWERS } from "./team-admin";
import { acceptAnswerOf, answerOf, rosterOf, standingOf, type StandingRow } from "./team-records";

// Lo que la base contesta se entiende o no se entiende: aquí no se adivina. Las consultas
// contra la base de verdad se prueban en `tests/integration/34-equipo-servicios.test.ts`.

const FACTOR = "fa000000-0000-4000-8000-0000000000b0";
const row = (over: Partial<StandingRow> & { state: string }): StandingRow => ({ factor: null, kind: null, capabilities: [], ...over });

describe("el estado del equipo, como lo contesta la base", () => {
  it("quien no es del equipo ni tiene invitación", () => {
    expect(standingOf(row({ state: "none" }))).toEqual({ state: "none" });
  });

  it("quien conserva capacidades y no tiene con qué volver", () => {
    expect(standingOf(row({ state: "unbound" }))).toEqual({ state: "unbound" });
  });

  it("quien es del equipo trae su factor atado y sus capacidades activas", () => {
    expect(standingOf(row({ state: "member", factor: FACTOR, capabilities: ["config", "support"] }))).toEqual({
      state: "member",
      factor: FACTOR,
      capabilities: ["config", "support"],
    });
  });

  it("a quien le falta el código se le dice con qué factor", () => {
    expect(standingOf(row({ state: "needs_code", factor: FACTOR }))).toEqual({ state: "needs_code", factor: FACTOR });
  });

  it.each(["grant", "rebind"] as const)("una invitación %s con el buzón probado dice qué daría", (kind) => {
    const capabilities = kind === "grant" ? ["support"] : [];
    expect(standingOf(row({ state: "invited", kind, capabilities }))).toEqual({ state: "invited", kind, capabilities });
  });

  it("sin el buzón probado no dice qué daría, aunque la fila lo trajera", () => {
    expect(standingOf(row({ state: "invited_unproven", kind: "grant", capabilities: ["config"] }))).toEqual({
      state: "invited_unproven",
      kind: "grant",
    });
  });

  it("lo que sobra en la fila no pasa al estado", () => {
    expect(standingOf(row({ state: "none", factor: FACTOR, kind: "grant", capabilities: ["config"] }))).toEqual({ state: "none" });
    expect(standingOf(row({ state: "needs_code", factor: FACTOR, kind: "grant", capabilities: ["config"] }))).toEqual({
      state: "needs_code",
      factor: FACTOR,
    });
  });

  it.each<[string, StandingRow]>([
    ["un estado que no se conoce", row({ state: "admin" })],
    ["un estado vacío", row({ state: "" })],
    ["un estado con mayúsculas", row({ state: "Member", factor: FACTOR, capabilities: ["config"] })],
    ["del equipo, sin factor", row({ state: "member", capabilities: ["config"] })],
    ["del equipo, con algo que no es un factor", row({ state: "member", factor: "el-de-siempre", capabilities: ["config"] })],
    ["del equipo, sin ninguna capacidad", row({ state: "member", factor: FACTOR })],
    ["falta el código, sin decir de cuál factor", row({ state: "needs_code" })],
    ["falta el código, con un factor en mayúsculas", row({ state: "needs_code", factor: FACTOR.toUpperCase() })],
    ["invitada, sin tipo", row({ state: "invited", capabilities: ["config"] })],
    ["invitada, de un tipo que no existe", row({ state: "invited", kind: "owner", capabilities: ["config"] })],
    ["invitada sin probar, sin tipo", row({ state: "invited_unproven" })],
  ])("no se adivina: %s", (_what, bad) => {
    expect(() => standingOf(bad)).toThrow("no se entiende");
  });
});

describe("lo que contesta aceptar una invitación", () => {
  it.each(ACCEPT_ANSWERS)("%s es una de sus respuestas", (answer) => {
    expect(acceptAnswerOf(answer)).toBe(answer);
  });

  it("son nueve, las que escribe la función de la base", () => {
    expect([...ACCEPT_ANSWERS].sort()).toEqual([
      "accepted",
      "already_bound",
      "ineligible",
      "inviter_lost_config",
      "needs_code",
      "needs_handoff",
      "needs_mailbox_proof",
      "no_invitation",
      "unavailable",
    ]);
  });

  it.each(["", "Accepted", "accepted ", "ok", "forbidden", "needs_fresh_code"])("%j no lo es, y no se toma por ninguna", (answer) => {
    expect(() => acceptAnswerOf(answer)).toThrow("no contesta");
  });
});

describe("lo que contesta cada cambio al equipo", () => {
  it("cada lista es la que escribe su función de la base", () => {
    expect([...INVITE_ANSWERS].sort()).toEqual([
      "already_invited",
      "already_member",
      "forbidden",
      "ineligible",
      "invalid",
      "invited_existing",
      "invited_new",
      "needs_fresh_code",
      "unavailable",
    ]);
    expect([...REVOKE_INVITATION_ANSWERS].sort()).toEqual(["forbidden", "needs_fresh_code", "not_found", "revoked"]);
    expect([...GRANT_ANSWERS].sort()).toEqual(["already_has", "forbidden", "granted", "ineligible", "invalid", "needs_fresh_code", "not_member"]);
    expect([...REVOKE_ANSWERS].sort()).toEqual(["forbidden", "min_config", "needs_fresh_code", "not_found", "revoked"]);
    expect([...RESET_ANSWERS].sort()).toEqual([
      "forbidden",
      "ineligible",
      "invalid",
      "needs_fresh_code",
      "not_member",
      "reset",
      "self",
      "unavailable",
    ]);
  });

  it("una respuesta de su lista se entiende", () => {
    expect(answerOf(REVOKE_ANSWERS, "min_config")).toBe("min_config");
  });

  it.each(["", "Revoked", "revoked ", "ok", "granted", "reset"])("%j no es de la lista de quitar, y no se toma por ninguna", (answer) => {
    expect(() => answerOf(REVOKE_ANSWERS, answer)).toThrow("no contesta");
  });
});

describe("la lista del equipo, como la contesta la base", () => {
  const ME = "a0000000-0000-4000-8000-000000000001";
  const OTHER = "b0000000-0000-4000-8000-000000000002";
  const INVITATION = "d0000000-0000-4000-8000-000000000004";
  const rawMember = (over: Record<string, unknown> = {}) => ({
    profile_id: ME,
    email: "yo@prueba.test",
    display_name: null,
    status: "active",
    capabilities: ["config", "support"],
    factor: "bound",
    rebind: "none",
    config_removable: true,
    is_self: true,
    ...over,
  });
  const rawInvitation = (over: Record<string, unknown> = {}) => ({
    id: INVITATION,
    kind: "grant",
    email: "invitada@prueba.test",
    profile_id: null,
    capabilities: ["support", "content"],
    invited_by: ME,
    created_at: "2026-10-13T23:41:05.123456+00:00",
    expires_at: "2026-10-20T23:41:05.123456+00:00",
    expired: false,
    acceptable: true,
    ...over,
  });
  const raw = (over: Record<string, unknown> = {}) => ({ fresh_code: true, members: [rawMember()], invitations: [], ...over });

  it("nulo es nulo: quien pregunta no pasa la puerta con configuración", () => {
    expect(rosterOf(null)).toBeNull();
  });

  it("cada persona, con sus capacidades en el orden en que la aplicación las nombra", () => {
    const other = rawMember({
      profile_id: OTHER,
      email: null,
      display_name: "Otra",
      status: "suspended",
      capabilities: ["content"],
      factor: "none",
      rebind: "expired",
      config_removable: false,
      is_self: false,
    });
    expect(rosterOf(raw({ fresh_code: false, members: [rawMember(), other] }))).toEqual({
      freshCode: false,
      members: [
        {
          profileId: ME,
          email: "yo@prueba.test",
          displayName: null,
          status: "active",
          capabilities: ["support", "config"],
          factor: "bound",
          rebind: "none",
          configRemovable: true,
          isSelf: true,
        },
        {
          profileId: OTHER,
          email: null,
          displayName: "Otra",
          status: "suspended",
          capabilities: ["content"],
          factor: "none",
          rebind: "expired",
          configRemovable: false,
          isSelf: false,
        },
      ],
      invitations: [],
    });
  });

  it("cada invitación, con sus horas y sus capacidades en el orden en que se pidieron", () => {
    const rebind = rawInvitation({ kind: "rebind", profile_id: OTHER, capabilities: [], invited_by: null, expired: true, acceptable: false });
    expect(rosterOf(raw({ invitations: [rawInvitation(), rebind] }))?.invitations).toEqual([
      {
        id: INVITATION,
        kind: "grant",
        email: "invitada@prueba.test",
        profileId: null,
        capabilities: ["support", "content"],
        invitedBy: ME,
        createdAt: new Date("2026-10-13T23:41:05.123Z"),
        expiresAt: new Date("2026-10-20T23:41:05.123Z"),
        expired: false,
        acceptable: true,
      },
      {
        id: INVITATION,
        kind: "rebind",
        email: "invitada@prueba.test",
        profileId: OTHER,
        capabilities: [],
        invitedBy: null,
        createdAt: new Date("2026-10-13T23:41:05.123Z"),
        expiresAt: new Date("2026-10-20T23:41:05.123Z"),
        expired: true,
        acceptable: false,
      },
    ]);
  });

  it("un estado de cuenta que no es activa ni suspendida no se adivina: es «otro»", () => {
    const other = rawMember({ profile_id: OTHER, status: "deleted", is_self: false });
    expect(rosterOf(raw({ members: [rawMember(), other] }))?.members[1]?.status).toBe("other");
  });

  it.each<[string, unknown]>([
    ["algo que no es un objeto", "lista"],
    ["sin personas", raw({ members: [] })],
    ["con las personas en nulo", raw({ members: null })],
    ["sin decir si el código es reciente", raw({ fresh_code: null })],
    ["sin invitaciones", raw({ invitations: null })],
    ["con un campo que este código no conoce", raw({ secreto: "x" })],
    ["una persona con un campo de más", raw({ members: [rawMember({ factor_id: "fa000000-0000-4000-8000-0000000000b0" })] })],
    ["una persona sin capacidades", raw({ members: [rawMember({ capabilities: [] })] })],
    ["una persona con una capacidad que no existe", raw({ members: [rawMember({ capabilities: ["owner"] })] })],
    ["una persona con un identificador sin forma", raw({ members: [rawMember({ profile_id: "yo" })] })],
    ["una persona con un estado de factor que no existe", raw({ members: [rawMember({ factor: "verified" })] })],
    ["una persona con una invitación para volver que no existe", raw({ members: [rawMember({ rebind: "sent" })] })],
    ["sin la fila de quien pregunta", raw({ members: [rawMember({ is_self: false })] })],
    ["con dos filas de quien pregunta", raw({ members: [rawMember(), rawMember({ profile_id: OTHER })] })],
    ["una invitación con la huella del código dictado", raw({ invitations: [rawInvitation({ handoff: "a".repeat(64) })] })],
    ["una invitación de un tipo que no existe", raw({ invitations: [rawInvitation({ kind: "transfer" })] })],
    ["una invitación con una hora que no lo es", raw({ invitations: [rawInvitation({ expires_at: "mañana" })] })],
    ["una invitación con una capacidad que no existe", raw({ invitations: [rawInvitation({ capabilities: ["owner"] })] })],
    ["una invitación con quien invitó sin forma", raw({ invitations: [rawInvitation({ invited_by: "ella" })] })],
  ])("%s no se entiende, y lanza: quien llama lo trata como «no se supo»", (_what, value) => {
    expect(() => rosterOf(value)).toThrow();
  });
});
