import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { asServer, ServerActor, Tx } from "@/adapters/supabase/db";
import { toDatabaseError } from "@/adapters/supabase/errors";
import type { SqlQuery } from "@/adapters/supabase/sql";

import { acceptInvitation, readTeamStanding } from "./team-records";
import { createTeamStore } from "./team-store";

// Lo que el almacén del equipo hace alrededor de sus dos consultas: a nombre de quién abre
// cada transacción, qué reintenta y dónde entiende lo que contestó la base. Las consultas
// corren contra la base de verdad en `tests/integration/34-equipo-servicios.test.ts`.

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const FACTOR = "fa000000-0000-4000-8000-000000000001";
const TICKET = "a".repeat(64);
const HANDOFF = "b".repeat(64);

interface Sent {
  text: string;
  values: readonly unknown[];
}

/** Una transacción que contesta las filas que se le digan y recuerda lo que se le mandó. */
function txWith(rows: unknown[]) {
  const sent: Sent[] = [];
  const tx: Tx = {
    query<Row>(query: SqlQuery, row: ZodType<Row>): Promise<Row[]> {
      sent.push({ text: query.text.replace(/\s+/g, " ").trim(), values: query.values });
      return Promise.resolve(rows.map((each) => row.parse(each)));
    },
    execute: () => Promise.reject(new Error("Estas consultas no ejecutan sentencias.")),
  };
  return { tx, sent };
}

/** Un `asServer` de mentira: recuerda a nombre de quién se abrió cada transacción. */
function runnerWith(rows: unknown[], failures: unknown[] = []) {
  const opened: ServerActor[] = [];
  /** Las transacciones cuya función terminó sin lanzar: las que `asServer` confirma. */
  const committed: (string | undefined)[] = [];
  const pending = [...failures];
  const { tx, sent } = txWith(rows);
  const run = (async (actor: ServerActor, fn: (tx: Tx) => Promise<unknown>) => {
    opened.push(actor);
    if (pending.length > 0) throw pending.shift();
    const result = await fn(tx);
    committed.push(actor.reason);
    return result;
  }) as typeof asServer;
  return { run, opened, committed, sent };
}

const lockConflict = (code: string) => toDatabaseError({ code, severity: "ERROR" });

describe("las dos consultas del equipo", () => {
  it("el estado se pregunta con la huella del resguardo como parámetro, y sin decir de quién es la cuenta", async () => {
    const { tx, sent } = txWith([{ state: "none", factor: null, kind: null, capabilities: [] }]);
    expect(await readTeamStanding(tx, TICKET)).toEqual({ state: "none" });
    expect(sent).toEqual([
      { text: "select state, factor::text as factor, kind, capabilities from private.team_standing($1::text)", values: [TICKET] },
    ]);
  });

  it("sin resguardo se pregunta con nulo", async () => {
    const { tx, sent } = txWith([{ state: "none", factor: null, kind: null, capabilities: [] }]);
    await readTeamStanding(tx, null);
    expect(sent[0]?.values).toEqual([null]);
  });

  it("si la base no contesta una fila, o una que no se entiende, lanza: no se adivina", async () => {
    await expect(readTeamStanding(txWith([]).tx, TICKET)).rejects.toThrow("no contestó");
    await expect(readTeamStanding(txWith([{ state: "member", factor: null, kind: null, capabilities: [] }]).tx, TICKET)).rejects.toThrow(
      "no se entiende",
    );
    await expect(readTeamStanding(txWith([{ state: "none" }]).tx, TICKET)).rejects.toThrow();
  });

  it("aceptar manda el resguardo, el factor y el código dictado, en ese orden", async () => {
    const { tx, sent } = txWith([{ answer: "accepted" }]);
    expect(await acceptInvitation(tx, TICKET, FACTOR, HANDOFF)).toBe("accepted");
    expect(sent).toEqual([
      { text: "select private.accept_admin_invitation($1::text, $2::uuid, $3::text) as answer", values: [TICKET, FACTOR, HANDOFF] },
    ]);
  });

  it("sin código dictado manda nulo", async () => {
    const { tx, sent } = txWith([{ answer: "accepted" }]);
    await acceptInvitation(tx, TICKET, FACTOR, null);
    expect(sent[0]?.values).toEqual([TICKET, FACTOR, null]);
  });

  // Tres de los rechazos escriben antes de contestar. Si la consulta lanzara por un «no», o
  // por una respuesta que no conoce, la transacción se revertiría con lo que escribieron.
  it.each(["needs_handoff", "inviter_lost_config", "no_invitation", "needs_mailbox_proof", "otra_cosa", ""])(
    "dentro de la transacción no se juzga la respuesta: %j se devuelve tal cual",
    async (answer) => {
      expect(await acceptInvitation(txWith([{ answer }]).tx, TICKET, FACTOR, null)).toBe(answer);
    },
  );

  it("sin fila devuelve vacío, que tampoco lanza ahí dentro", async () => {
    expect(await acceptInvitation(txWith([]).tx, TICKET, FACTOR, null)).toBe("");
  });
});

describe("el almacén del equipo", () => {
  it("el estado se lee como servidor, a nombre de las claims que se le pasan", async () => {
    const { run, opened, sent } = runnerWith([{ state: "needs_code", factor: FACTOR, kind: null, capabilities: [] }]);
    expect(await createTeamStore(run).standing(claims, TICKET)).toEqual({ state: "needs_code", factor: FACTOR });
    expect(opened).toEqual([{ claims, reason: "team_standing" }]);
    expect(sent[0]?.values).toEqual([TICKET]);
  });

  it("leer el estado no se reintenta: no toma candados, y un fallo ahí es «no se supo»", async () => {
    const { run, opened } = runnerWith([{ state: "none", factor: null, kind: null, capabilities: [] }], [lockConflict("40P01")]);
    await expect(createTeamStore(run).standing(claims, null)).rejects.toMatchObject({ code: "40P01" });
    expect(opened).toHaveLength(1);
  });

  it("aceptar va como servidor, con las claims de la sesión ya subida y su razón para la auditoría", async () => {
    const { run, opened, sent } = runnerWith([{ answer: "accepted" }]);
    expect(await createTeamStore(run).accept(claims, TICKET, FACTOR, HANDOFF)).toBe("accepted");
    expect(opened).toEqual([{ claims, reason: "accept_invitation" }]);
    expect(sent[0]?.values).toEqual([TICKET, FACTOR, HANDOFF]);
  });

  it.each(["40P01", "55P03"])("un choque de candados (%s) se intenta una vez más", async (code) => {
    const { run, opened } = runnerWith([{ answer: "accepted" }], [lockConflict(code)]);
    expect(await createTeamStore(run).accept(claims, TICKET, FACTOR, null)).toBe("accepted");
    expect(opened).toHaveLength(2);
  });

  it("y solo una: si insiste, es «no se supo»", async () => {
    const { run, opened } = runnerWith([{ answer: "accepted" }], [lockConflict("40P01"), lockConflict("55P03")]);
    await expect(createTeamStore(run).accept(claims, TICKET, FACTOR, null)).rejects.toMatchObject({ code: "55P03" });
    expect(opened).toHaveLength(2);
  });

  it.each([
    ["otro error de la base", toDatabaseError({ code: "57014", severity: "ERROR" })],
    ["una caída", new Error("sin base")],
  ])("%s no se reintenta: quizá sí se escribió", async (_what, failure) => {
    const { run, opened } = runnerWith([{ answer: "accepted" }], [failure]);
    await expect(createTeamStore(run).accept(claims, TICKET, FACTOR, null)).rejects.toBe(failure);
    expect(opened).toHaveLength(1);
  });

  it("una respuesta que aceptar no contesta se rechaza fuera de la transacción, ya confirmada", async () => {
    const { run, opened, committed } = runnerWith([{ answer: "granted" }]);
    await expect(createTeamStore(run).accept(claims, TICKET, FACTOR, null)).rejects.toThrow("no contesta");
    // La transacción terminó bien: si lanzara dentro, se revertiría lo que un rechazo escribió.
    expect(committed).toEqual(["accept_invitation"]);
    // Y no se reintentó: lo que no se entiende es su respuesta.
    expect(opened).toHaveLength(1);
  });

  it.each(["needs_handoff", "inviter_lost_config", "no_invitation"])("un rechazo que escribe (%s) confirma su transacción", async (answer) => {
    const { run, committed } = runnerWith([{ answer }]);
    expect(await createTeamStore(run).accept(claims, TICKET, FACTOR, null)).toBe(answer);
    expect(committed).toEqual(["accept_invitation"]);
  });
});
