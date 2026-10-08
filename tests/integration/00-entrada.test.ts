import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// La base sobre la que se apoya el adaptador (ADR-31, TRD §8.10), probada con el cliente
// crudo: la aplicación entra como app_service, puede bajar al rol de una persona y no
// puede subir a ningún otro. Si esto falla, lo demás no tiene sentido.

const PERMISSION_DENIED = "42501";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

async function inTransaction<T>(work: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    return await work();
  } finally {
    await client.query("rollback");
  }
}

async function currentUser(): Promise<string> {
  const result = await client.query<{ current_user: string }>("select current_user");
  return result.rows[0]?.current_user ?? "";
}

describe("entrada de la aplicación a la base", () => {
  it("DATABASE_URL entra como app_service, que salta la seguridad por fila", async () => {
    const result = await client.query<{ session_user: string; bypass: boolean }>(
      "select session_user, (select rolbypassrls from pg_roles where rolname = session_user) as bypass",
    );
    expect(result.rows[0]).toEqual({ session_user: "app_service", bypass: true });
  });

  it.each(["authenticated", "anon"])("puede bajar al rol %s", async (role) => {
    await inTransaction(async () => {
      await client.query(`set local role ${role}`);
      expect(await currentUser()).toBe(role);
    });
  });

  it.each(["service_role", "postgres", "supabase_admin"])(
    "no puede subir al rol %s",
    async (role) => {
      await inTransaction(async () => {
        await expect(client.query(`set local role ${role}`)).rejects.toMatchObject({
          code: PERMISSION_DENIED,
        });
      });
    },
  );

  it("al terminar la transacción vuelve a ser app_service", async () => {
    await inTransaction(async () => {
      await client.query("set local role authenticated");
    });
    expect(await currentUser()).toBe("app_service");
  });
});
