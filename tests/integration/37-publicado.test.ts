import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { localOwnerUrl } from "./helpers/local";
import { ownerQuery } from "./helpers/users";

// Lo publicado (T-107): los candados. Cargar un curso y aprobarlo toman los candados de las
// dos listas del catálogo, en el mismo orden que desactivar una práctica, y se niegan fuera
// de read committed. Todo corre en transacciones del dueño que se revierten: prácticas y
// cursos escriben en la auditoría, que no admite borrado.

/** Una conexión del dueño, con una transacción abierta y declarada como sistema. */
async function asSystem(): Promise<Client> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  await client.query("begin");
  await client.query("select set_config('app.actor_kind', 'system', true)");
  return client;
}

async function close(client: Client): Promise<void> {
  await client.query("rollback").catch(() => undefined);
  await client.end();
}

/** Si esa conexión está esperando un candado. Hasta diez segundos: con la máquina cargada, la espera tarda en verse. */
async function waiting(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await ownerQuery<{ waiting: boolean }>(
      "select coalesce(wait_event_type = 'Lock' or wait_event = 'advisory', false) as waiting from pg_stat_activity where pid = $1",
      [pid],
    );
    if (row?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const pidOf = async (client: Client) => (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid ?? -1;

describe("los candados de lo publicado", () => {
  it.each([
    ["cargar un curso", "select private.system_load_course(gen_random_uuid(), '{}'::jsonb)"],
    ["aprobar un curso", "select private.approve_course(gen_random_uuid())"],
  ])("%s se niega con una foto fija de la base", async (_what, statement) => {
    const client = new Client({ connectionString: localOwnerUrl() });
    await client.connect();
    try {
      await client.query("begin isolation level repeatable read");
      await client.query("select set_config('app.actor_kind', 'system', true)");
      await expect(client.query(statement)).rejects.toMatchObject({ code: "25000" });
    } finally {
      await close(client);
    }
  });

  it.each([
    ["aprobar", "practices", "select private.approve_course(gen_random_uuid())"],
    ["cargar", "practices", "select private.system_load_course(gen_random_uuid(), '{}'::jsonb)"],
    ["aprobar", "levels", "select private.approve_course(gen_random_uuid())"],
    ["cargar", "levels", "select private.system_load_course(gen_random_uuid(), '{}'::jsonb)"],
    // «En uso» (segunda solicitud): desactivar mira dentro del mismo candado.
    ["desactivar", "practices", "select private.catalog_set_active('practices', gen_random_uuid(), false)"],
    ["desactivar", "levels", "select private.catalog_set_active('levels', gen_random_uuid(), false)"],
  ])("%s espera a quien tiene el candado de %s, antes de mirar nada más", async (_what, list, statement) => {
    const holder = await asSystem();
    const other = await asSystem();
    try {
      // Quien agrega a una lista toma su candado y no termina todavía.
      await holder.query("select private.system_catalog_add($1::text::public.catalog_list, 'Elemento que espera')", [list]);
      const pid = await pidOf(other);
      const pending = other.query(statement).then(
        () => "contestó",
        (error: { code?: string }) => error.code ?? "falló",
      );
      expect(await waiting(pid)).toBe(true);
      await holder.query("rollback");
      // Ya sin el candado contesta lo que le toca: aprobar sin nadie que actúe, «forbidden»;
      // cargar sin maestro, «teacher_missing». Nada de eso es un error.
      expect(await pending).toBe("contestó");
    } finally {
      await close(holder);
      await close(other);
    }
  });

  it("un video de prueba no entra en una sesión donde el ajuste del guion nunca se definió", async () => {
    // Una conexión nueva: el ajuste no existe (es nulo), no está vacío. Declarada sistema,
    // como lo haría quien opera la base.
    const client = await asSystem();
    try {
      await client.query("select private.system_catalog_add('practices', 'Práctica sin ajuste'), private.system_catalog_add('levels', 'Nivel sin ajuste')");
      const teacher = (await client.query<{ id: string }>("select private.system_add_teacher('Sin ajuste', 'sin-ajuste', null) as id")).rows[0]?.id;
      const course = {
        slug: "sin-ajuste",
        title: "Sin ajuste",
        practice: "practica-sin-ajuste",
        level: "nivel-sin-ajuste",
        modules: [{ title: "Uno", lessons: [{ title: "Una", video: { provider: "test", asset_id: "a", playback_id: "p", duration_seconds: 10 } }] }],
      };
      await expect(client.query("select private.system_load_course($1::uuid, $2::jsonb)", [teacher, JSON.stringify(course)])).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await close(client);
    }
  });
});
