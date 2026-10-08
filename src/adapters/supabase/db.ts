import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { Pool, type PoolClient, type QueryConfig } from "pg";
import type { ZodType } from "zod";

import { getEnv } from "@/config/env";

import { readVerifiedClaims, type VerifiedClaims } from "./claims";
import { buildPoolConfig } from "./config";
import {
  NestedTransactionError,
  RowValidationError,
  toDatabaseError,
  TransactionAbortedError,
  TransactionClosedError,
  TransactionControlError,
} from "./errors";
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
  /**
   * Las claims que devolvió `verifyAccessToken`. De ahí salen quién actúa y con qué nivel
   * (la base exige `aal2` para lo administrativo): no los declara quien llama, porque
   * este es el camino que salta la seguridad por fila.
   */
  claims: VerifiedClaims;
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
    set_config('idle_in_transaction_session_timeout', $9, true),
    set_config('app.tx', $10, true)`;

// Antes del commit: que la transacción siga siendo la que se preparó, con su rol. El
// testigo `app.tx` es local a la transacción: si una consulta la terminó y abrió otra
// («commit and chain»), la nueva no lo trae. Y el estado que reporta la base no cambia
// con un `set role`, pero el rol sí.
const CHECK = `select current_setting('app.tx', true) as tx, current_user::text as role`;

let cached: Pool | undefined;

function pool(): Pool {
  if (cached) return cached;
  cached = new Pool(buildPoolConfig(getEnv()));
  // Una conexión ociosa que la base cerró emite `error`: sin quien lo escuche, tumba el
  // proceso. El grupo ya la descarta por su cuenta.
  cached.on("error", () => {});
  return cached;
}

// Lo que `pg` reporta del estado de la transacción tras cada sentencia: «T» dentro de
// una, «E» dentro de una abortada, «I» fuera de toda transacción.
const IN_TRANSACTION = "T";
const ABORTED = "E";

interface TxState {
  open: boolean;
  /** Una consulta terminó la transacción por su cuenta. */
  ended: boolean;
}

function createTx(client: PoolClient, state: TxState): Tx {
  // Las consultas de una transacción corren una tras otra, aunque se pidan a la vez. Sin
  // esta fila, `pg` ya tendría encolada la siguiente cuando una termina la transacción, y
  // correría fuera de ella.
  let last: Promise<unknown> = Promise.resolve();
  function run(query: SqlQuery) {
    const next = last.then(
      () => runNow(query),
      () => runNow(query),
    );
    last = next.catch(() => {});
    return next;
  }

  async function runNow(query: SqlQuery) {
    if (state.ended) throw new TransactionControlError();
    if (!state.open) throw new TransactionClosedError();
    if (!isSqlQuery(query)) {
      throw new TypeError("La consulta debe venir de la etiqueta sql, nunca de texto suelto.");
    }
    // Protocolo extendido siempre: admite una sola sentencia por consulta. Sin valores,
    // `pg` usaría el simple, que acepta varias separadas por punto y coma. Los tipos de
    // `pg` todavía no declaran `queryMode`, aunque la biblioteca lo lee.
    const config: QueryConfig & { queryMode: "extended" } = {
      text: query.text,
      values: [...query.values],
      queryMode: "extended",
    };
    let result;
    try {
      result = await client.query(config);
    } catch (error) {
      throw toDatabaseError(error);
    }
    // Si la sentencia terminó la transacción (un commit, un rollback), lo que sigue ya no
    // corre dentro de ella: ni con el rol de la persona, ni con autor, ni se deshace.
    const status = client.getTransactionStatus();
    if (status !== IN_TRANSACTION && status !== ABORTED) {
      state.ended = true;
      state.open = false;
      throw new TransactionControlError();
    }
    return result;
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

// Marca que se está dentro de la función de una transacción, para rechazar otra adentro.
// Todo lo que se agenda dentro hereda la marca para siempre (un temporizador, una promesa
// sin esperar): por eso es un objeto que se apaga al terminar, y no un simple «sí».
const inside = new AsyncLocalStorage<{ active: boolean }>();

async function transaction<T>(settings: Settings, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Cada transacción toma una conexión y el grupo es chico: anidarlas lo agota y cuelga.
  if (inside.getStore()?.active) throw new NestedTransactionError();

  const witness = randomUUID();
  const marker = { active: true };

  const client = await pool().connect();
  const state: TxState = { open: false, ended: false };
  let broken = false;
  // Mientras está prestada, la conexión no tiene quien escuche `error` (el grupo quita su
  // oyente). Si la base la corta mientras la función espera a un tercero, ese evento sin
  // oyente tumbaría el proceso. Aquí solo la marca: la consulta siguiente fallará sola.
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
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
      witness,
    ]);
    // Al final, ya con todo fijado: desde aquí la base filtra como esa persona.
    if (settings.role === "authenticated") await client.query("set local role authenticated");

    state.open = true;
    let result: T;
    try {
      const tx = createTx(client, state);
      result = await inside.run(marker, () => fn(tx));
    } finally {
      // Antes del commit o del rollback: una consulta tardía de `fn` ya no puede correr
      // en esta conexión, que enseguida será de otra petición.
      state.open = false;
      marker.active = false;
    }

    // La función terminó bien, pero eso no dice en qué quedó la transacción.
    if (state.ended) throw new TransactionControlError();
    // Abortada: una sentencia falló y alguien atrapó el error. A un commit aquí Postgres
    // contesta ROLLBACK sin error, y se reportaría como guardado lo que se deshizo.
    if (client.getTransactionStatus() !== IN_TRANSACTION) throw new TransactionAbortedError();

    // Sigue siendo la transacción que se preparó, y con el rol con que se preparó.
    const check = await client.query<{ tx: string | null; role: string }>(CHECK);
    if (check.rows[0]?.tx !== witness || check.rows[0]?.role !== settings.role) {
      state.ended = true;
      throw new TransactionControlError();
    }

    const committed = await client.query("commit");
    if (committed.command !== "COMMIT") throw new TransactionAbortedError();
    return result;
  } catch (error) {
    state.open = false;
    marker.active = false;
    try {
      await client.query("rollback");
    } catch {
      // Sin rollback confirmado no se sabe en qué quedó la conexión: no vuelve al grupo.
      broken = true;
    }
    // Si una consulta terminó la transacción, tampoco se confía en cómo quedó.
    if (state.ended) broken = true;
    throw toDatabaseError(error);
  } finally {
    client.removeListener("error", onError);
    client.release(broken);
  }
}

/**
 * Como usuario: lo que una persona lee o escribe por sí misma. La transacción baja al rol
 * `authenticated` con su token, y la base filtra por ella aunque la consulta no lo haga.
 *
 * Solo acepta las claims que devolvió `verifyAccessToken`.
 *
 * El filtro protege de la consulta que olvida el `where`, no de SQL armado con texto de la
 * persona: `set role` consulta al usuario de la sesión, así que un `reset role` dentro de
 * la transacción recuperaría el salto de la seguridad por fila. Por eso las consultas
 * solo se escriben con la etiqueta `sql`.
 */
export async function asUser<T>(claims: VerifiedClaims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { json } = readVerifiedClaims(claims);
  return transaction(
    {
      role: "authenticated",
      claims: json,
      actorId: "",
      actorAal: "",
      actorKind: "",
      reason: "",
      requestId: "",
    },
    fn,
  );
}

/**
 * Como servidor: una escritura que depende de una validación, a nombre de la persona que
 * la pidió. La base ve a `app_service` y lee el autor de la transacción.
 *
 * Es el camino que salta la seguridad por fila, así que quién actúa no lo declara quien
 * llama: sale de las claims que devolvió `verifyAccessToken`, igual que en `asUser`. Lo
 * que no tiene una persona con sesión detrás (un aviso de cobro, un cierre) va por
 * `asSystem`.
 */
export async function asServer<T>(actor: ServerActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { claims } = readVerifiedClaims((actor as { claims?: unknown } | null)?.claims);
  return transaction(
    {
      role: "app_service",
      claims: "",
      actorId: claims.userId,
      actorAal: claims.aal,
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
