import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { localOwnerUrl } from "./helpers/local";
import { ownerQuery } from "./helpers/users";

// El freno de los códigos del segundo factor (RF-106; TRD §9.2, fila «Segundo factor»), en
// lo que una prueba de base no puede ver porque corre en una sola conexión: que dos intentos
// del mismo factor van uno tras otro. Sin eso, dos fallos a la vez se pisarían la cuenta, y
// quien adivina con muchas conexiones tendría más intentos de los que el freno dice.
//
// Aquí se llama a la función del gancho directo, como dueño de la base: lo que se prueba es
// su candado, no que Auth la llame (eso lo prueba `30-auth-config.test.ts`).

const factors: string[] = [];

function factor(): string {
  const id = randomUUID();
  factors.push(id);
  return id;
}

const failedAttempt = (factorId: string) => JSON.stringify({ factor_id: factorId, factor_type: "totp", valid: false });
const HOOK = "select private.second_factor_attempt($1::jsonb) ->> 'decision' as decision";
const LOCK = "select pg_advisory_xact_lock(hashtextextended('second_factor:' || $1, 0))";

async function failuresOf(factorId: string): Promise<number> {
  const rows = await ownerQuery<{ n: number }>(
    "select failed_count as n from private.second_factor_attempts where factor_id = $1",
    [factorId],
  );
  return rows[0]?.n ?? 0;
}

async function connected(): Promise<Client> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  return client;
}

afterAll(async () => {
  await ownerQuery("delete from private.second_factor_attempts where factor_id = any($1::uuid[])", [factors]);
});

describe("dos intentos del mismo factor a la vez", () => {
  it("el segundo espera a que termine el primero, y el de otro factor no espera a nadie", async () => {
    const mine = factor();
    const other = factor();
    const first = await connected();
    const second = await connected();
    try {
      // El primero tiene tomado el candado de ese factor, como un intento a medio contar.
      await first.query("begin");
      await first.query(LOCK, [mine]);

      await second.query("begin");
      await second.query("set local lock_timeout = '400ms'");
      await expect(second.query(HOOK, [failedAttempt(mine)])).rejects.toMatchObject({ code: "55P03" });
      await second.query("rollback");

      // El de otro factor pasa sin esperar.
      await second.query("begin");
      await second.query("set local lock_timeout = '400ms'");
      expect((await second.query<{ decision: string }>(HOOK, [failedAttempt(other)])).rows[0]?.decision).toBe("continue");
      await second.query("commit");

      // Suelto el candado, el intento se cuenta.
      await first.query("rollback");
      expect((await second.query<{ decision: string }>(HOOK, [failedAttempt(mine)])).rows[0]?.decision).toBe("continue");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
    }
    expect(await failuresOf(mine)).toBe(1);
    expect(await failuresOf(other)).toBe(1);
  });

  it("cuatro fallos a la vez, por cuatro conexiones, cuentan cuatro", async () => {
    const mine = factor();
    const clients = await Promise.all([connected(), connected(), connected(), connected()]);
    try {
      const decisions = await Promise.all(
        clients.map(async (client) => (await client.query<{ decision: string }>(HOOK, [failedAttempt(mine)])).rows[0]?.decision),
      );
      expect(decisions).toEqual(["continue", "continue", "continue", "continue"]);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
    expect(await failuresOf(mine)).toBe(4);
  });
});
