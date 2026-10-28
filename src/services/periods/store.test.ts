import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { asServer, ServerActor, Tx } from "@/adapters/supabase/db";
import { DatabaseError, toDatabaseError } from "@/adapters/supabase/errors";
import type { SqlQuery } from "@/adapters/supabase/sql";

import { CloseFailure } from "./panel";
import { createPeriodStore } from "./store";

// Lo que el almacén de los periodos hace alrededor de sus consultas: a nombre de quién y por qué abre
// cada transacción, qué reintenta y qué errores de la base dice por su nombre (el tiempo vencido, 57014;
// la suma que no cuadra al confirmar el cierre, 23514). Las consultas corren contra la base de verdad en
// `tests/integration/56-periodos.test.ts`; la confirmación de verdad del cierre, en la 54.

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const pgError = (code: string) => toDatabaseError({ code, severity: "ERROR", message: "x" });

/** Un `asServer` de mentira: lanza los errores que se le digan, uno por transacción, y después contesta `outcome`. */
function runnerWith(outcome: unknown, failures: unknown[] = []) {
  const opened: ServerActor[] = [];
  const queue = [...failures];
  const tx: Tx = {
    query<Row>(_query: SqlQuery, row: ZodType<Row>): Promise<Row[]> {
      // La revisión de «un ensayo por minuto» contesta que no hay uno reciente.
      return Promise.resolve([row.parse({ outcome, recent: false })]);
    },
    execute: () => Promise.reject(new Error("Estas consultas no ejecutan sentencias.")),
  };
  const run = (async (actor: ServerActor, work: (tx: Tx) => Promise<unknown>) => {
    opened.push(actor);
    const failure = queue.shift();
    if (failure !== undefined) throw failure;
    return work(tx);
  }) as unknown as typeof asServer;
  return { store: createPeriodStore(run), opened };
}

describe("ensayar y cerrar", () => {
  it("abren su transacción a nombre de las claims, con su motivo", async () => {
    const rehearse = runnerWith("rehearsed");
    expect(await rehearse.store.rehearse(claims, 202710)).toBe("rehearsed");
    expect(rehearse.opened).toEqual([{ claims, reason: "period_rehearsal" }]);
    const close = runnerWith("closed");
    expect(await close.store.closePeriod(claims, 202710)).toBe("closed");
    expect(close.opened).toEqual([{ claims, reason: "period_close" }]);
  });

  it("un choque de candados se intenta una vez más, y solo una", async () => {
    const once = runnerWith("closed", [pgError("40P01")]);
    expect(await once.store.closePeriod(claims, 202710)).toBe("closed");
    expect(once.opened).toHaveLength(2);
    const twice = runnerWith("closed", [pgError("55P03"), pgError("55P03")]);
    await expect(twice.store.closePeriod(claims, 202710)).rejects.toBeInstanceOf(DatabaseError);
    expect(twice.opened).toHaveLength(2);
  });

  it("el tiempo vencido de la base se dice por su nombre, al ensayar y al cerrar", async () => {
    await expect(runnerWith("rehearsed", [pgError("57014")]).store.rehearse(claims, 202710)).rejects.toEqual(new CloseFailure("timed_out"));
    await expect(runnerWith("closed", [pgError("57014")]).store.closePeriod(claims, 202710)).rejects.toEqual(new CloseFailure("timed_out"));
  });

  it("la suma que no cuadra solo al cerrar: al ensayar, un 23514 es otra cosa y sigue como error", async () => {
    await expect(runnerWith("closed", [pgError("23514")]).store.closePeriod(claims, 202710)).rejects.toEqual(new CloseFailure("unbalanced"));
    const rehearse = runnerWith("rehearsed", [pgError("23514")]).store.rehearse(claims, 202710);
    await expect(rehearse).rejects.toBeInstanceOf(DatabaseError);
    await expect(rehearse).rejects.not.toBeInstanceOf(CloseFailure);
  });

  it("otro error de la base, o uno que no es de la base, sigue tal cual", async () => {
    await expect(runnerWith("closed", [pgError("42501")]).store.closePeriod(claims, 202710)).rejects.toBeInstanceOf(DatabaseError);
    const other = new Error("sin conexión");
    await expect(runnerWith("closed", [other]).store.closePeriod(claims, 202710)).rejects.toBe(other);
  });

  it("una respuesta que no está en su lista lanza: no se pinta como hecha", async () => {
    await expect(runnerWith("closing").store.closePeriod(claims, 202710)).rejects.toThrow();
    await expect(runnerWith("reopened").store.rehearse(claims, 202710)).rejects.toThrow();
  });
});

describe("pedir el recálculo", () => {
  it("no reintenta, y no traduce errores", async () => {
    const asked = runnerWith("requested", [pgError("40P01")]);
    await expect(asked.store.requestRollup(claims, 202710)).rejects.toBeInstanceOf(DatabaseError);
    expect(asked.opened).toEqual([{ claims, reason: "rollup_request" }]);
  });
});
