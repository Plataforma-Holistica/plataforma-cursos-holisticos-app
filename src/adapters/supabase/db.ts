import "server-only";

import { Pool, type PoolClient } from "pg";
import { z, type ZodType } from "zod";

import { getEnv } from "@/config/env";

import { buildPoolConfig } from "./config";
import { RowValidationError, toDatabaseError, TransactionClosedError } from "./errors";
import { isSqlQuery, type SqlQuery } from "./sql";

// El único camino del código a la base (ADR-31, TRD §8.10).
//
// La aplicación entra como app_service, que salta la seguridad por fila. Por eso el
// cliente no sale de este archivo: lo único que se exporta son funciones que abren una
// transacción ya preparada, y cada una declara por quién se actúa. Son el espejo de los
// ayudantes de las pruebas de base (supabase/tests/_ayuda.psql).
//
// Todo ajuste va con `set_config(..., true)`, local a la transacción: es lo que admite el
// concentrador en modo de transacción, y lo que impide que algo se cuele a la petición
// siguiente. Por lo mismo no hay sentencias con nombre.

/** Lo que recibe la función de una transacción. Deja de servir cuando la función termina. */
export interface Tx {
  /** Corre una consulta y valida cada fila con su esquema. */
  query<Row>(query: SqlQuery, row: ZodType<Row>): Promise<Row[]>;
  /** Corre una sentencia y devuelve cuántas filas tocó. */
  execute(query: SqlQuery): Promise<number>;
}

/** Una persona, por la que el servidor escribe después de validar. */
export interface ServerActor {
  /** Identificador del perfil que actúa. */
  actorId: string;
  /** Nivel de autenticación de su sesión: la base exige `aal2` para lo administrativo. */
  aal: "aal1" | "aal2";
  /** Por qué se hace el cambio. Queda en la auditoría. */
  reason?: string;
  /** Liga el cambio con el registro técnico de la petición. */
  requestId?: string;
}

/** Un trabajo del sistema, sin persona detrás. */
export interface SystemContext {
  reason?: string;
  requestId?: string;
}

interface Settings {
  role: "app_service" | "authenticated";
  claims: string;
  actorId: string;
  actorAal: string;
  actorKind: string;
  reason: string;
  requestId: string;
}

// Los límites que trae el rol `authenticated` no aplican al bajar con `set role`: estos
// son los únicos frenos, y valen para las tres funciones.
const STATEMENT_TIMEOUT = "10s";
const LOCK_TIMEOUT = "5s";
const IDLE_IN_TRANSACTION_TIMEOUT = "15s";

// Se fijan todos en cada transacción; los que no aplican, vacíos. Así «como servidor» y
// «como sistema» nunca llevan un token (la base le da prioridad sobre el autor declarado)
// y ninguna función depende de lo que haya dejado la anterior. Los tres `request.jwt.claim*`
// de una pieza son los nombres viejos, que `auth.uid()` todavía lee primero.
const PREPARE = `
  select
    set_config('request.jwt.claims', $1, true),
    set_config('request.jwt.claim', '', true),
    set_config('request.jwt.claim.sub', '', true),
    set_config('request.jwt.claim.role', '', true),
    set_config('app.actor_id', $2, true),
    set_config('app.actor_aal', $3, true),
    set_config('app.actor_kind', $4, true),
    set_config('app.reason', $5, true),
    set_config('app.request_id', $6, true),
    set_config('statement_timeout', $7, true),
    set_config('lock_timeout', $8, true),
    set_config('idle_in_transaction_session_timeout', $9, true)`;

let cached: Pool | undefined;

function pool(): Pool {
  if (cached) return cached;
  cached = new Pool(buildPoolConfig(getEnv()));
  // Una conexión ociosa que la base cerró emite `error`: sin quien lo escuche, tumba el
  // proceso. El grupo ya la descarta por su cuenta.
  cached.on("error", () => {});
  return cached;
}

function createTx(client: PoolClient, state: { open: boolean }): Tx {
  async function run(query: SqlQuery) {
    if (!state.open) throw new TransactionClosedError();
    if (!isSqlQuery(query)) {
      throw new TypeError("La consulta debe venir de la etiqueta sql, nunca de texto suelto.");
    }
    try {
      return await client.query({ text: query.text, values: [...query.values] });
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  return {
    async query(query, row) {
      const result = await run(query);
      return result.rows.map((raw: unknown) => {
        const parsed = row.safeParse(raw);
        if (!parsed.success) throw new RowValidationError(parsed.error);
        return parsed.data;
      });
    },
    async execute(query) {
      const result = await run(query);
      return result.rowCount ?? 0;
    },
  };
}

async function transaction<T>(settings: Settings, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  const state = { open: false };
  let broken = false;
  try {
    await client.query("begin");
    await client.query(PREPARE, [
      settings.claims,
      settings.actorId,
      settings.actorAal,
      settings.actorKind,
      settings.reason,
      settings.requestId,
      STATEMENT_TIMEOUT,
      LOCK_TIMEOUT,
      IDLE_IN_TRANSACTION_TIMEOUT,
    ]);
    // Al final, ya con todo fijado: desde aquí la base filtra como esa persona.
    if (settings.role === "authenticated") await client.query("set local role authenticated");

    state.open = true;
    let result: T;
    try {
      result = await fn(createTx(client, state));
    } finally {
      // Antes del commit o del rollback: una consulta tardía de `fn` ya no puede correr
      // en esta conexión, que enseguida será de otra petición.
      state.open = false;
    }
    await client.query("commit");
    return result;
  } catch (error) {
    state.open = false;
    try {
      await client.query("rollback");
    } catch {
      // Sin rollback confirmado no se sabe en qué quedó la conexión: no vuelve al grupo.
      broken = true;
    }
    throw toDatabaseError(error);
  } finally {
    client.release(broken);
  }
}

const actorId = z.uuid();

/**
 * Como servidor: una escritura que depende de una validación, a nombre de la persona que
 * la pidió. La base ve a `app_service` y lee el autor de la transacción.
 */
export async function asServer<T>(actor: ServerActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!actorId.safeParse(actor.actorId).success) {
    throw new TypeError("asServer: actorId debe ser el identificador de un perfil.");
  }
  return transaction(
    {
      role: "app_service",
      claims: "",
      actorId: actor.actorId,
      actorAal: actor.aal,
      actorKind: "",
      reason: actor.reason ?? "",
      requestId: actor.requestId ?? "",
    },
    fn,
  );
}

/** Como sistema: un trabajo sin persona detrás (un cierre, una semilla, un barrido). */
export async function asSystem<T>(context: SystemContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(
    {
      role: "app_service",
      claims: "",
      actorId: "",
      actorAal: "",
      actorKind: "system",
      reason: context.reason ?? "",
      requestId: context.requestId ?? "",
    },
    fn,
  );
}
