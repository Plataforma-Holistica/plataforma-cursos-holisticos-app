import { createHash } from "node:crypto";

import { Client } from "pg";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import type { TeamStanding, TeamStore } from "@/services/account/team";
import {
  GRANT_ANSWERS,
  INVITE_ANSWERS,
  RESET_ANSWERS,
  REVOKE_ANSWERS,
  REVOKE_INVITATION_ANSWERS,
  type TeamAdminStore,
} from "@/services/account/team-admin";
import {
  acceptAnswerOf,
  acceptInvitation,
  answerOf,
  askGrant,
  askInvite,
  readTeamRoster,
  readTeamStanding,
  askReset,
  askRevokeInvitation,
  askRevoke,
} from "@/services/account/team-records";

import { localOwnerUrl } from "./local";

// Lo que las pruebas del equipo necesitan alrededor. Todo lo que cambia el equipo queda en
// la auditoría, que no admite borrado, y las pruebas de base cuentan sus renglones: por eso
// cada caso corre dentro de una transacción del dueño que se revierte, con el rol y los
// ajustes que usa cada camino.

/** La huella de un secreto, como la calcula el servidor. */
export const print = (secret: string) => createHash("sha256").update(secret).digest("hex");

/**
 * Una transacción del dueño de la base local, que se revierte siempre. Con `server`, el
 * dueño puede tomar el rol del servidor dentro de ella. Dos transacciones abiertas a la
 * vez no pueden pedirlo las dos: la segunda esperaría a la primera, que es lo que cambia.
 *
 * Mientras siga abierta, lo que borró o cambió queda sin confirmar y con sus filas tomadas.
 * Una llamada de verdad a Supabase Auth que toque una de esas filas (cerrar una sesión que
 * aceptar ya borró aquí dentro, por ejemplo) se queda esperando, y el límite de espera de
 * esta conexión no la protege: es de otra. Lo que Auth haría con esa fila se mira aquí
 * dentro, o se le contesta a mano lo que contesta ya confirmado el cambio.
 */
export async function reverted<T>(fn: (owner: Client) => Promise<T>, server = true): Promise<T> {
  const owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  try {
    await owner.query("begin");
    // Si algo se queda esperando un candado que nadie suelta, falla aquí y no cuelga lo demás.
    await owner.query("set local lock_timeout = '20s'");
    if (server) await owner.query("grant app_service to postgres with set true, inherit false");
    return await fn(owner);
  } finally {
    await owner.query("rollback").catch(() => undefined);
    await owner.end();
  }
}

const RESET =
  "select set_config('role', 'none', true), set_config('request.jwt.claims', '', true), set_config('app.actor_id', '', true), " +
  "set_config('app.actor_session', '', true), set_config('app.actor_kind', $1, true)";

/** El dueño, sin autor declarado. */
export const asOwner = (owner: Client) => owner.query(RESET, [""]);
/** El dueño declarado sistema: el arranque, la emergencia y lo que la prueba deja puesto. */
export const asSystem = (owner: Client) => owner.query(RESET, ["system"]);
/** El servidor, a nombre de una persona y con su sesión. */
export async function asServer(owner: Client, personId: string, sessionId: string): Promise<void> {
  await owner.query(RESET, [""]);
  await owner.query(
    "select set_config('app.actor_id', $1, true), set_config('app.actor_session', $2, true), set_config('role', 'app_service', true)",
    [personId, sessionId],
  );
}

/** Lo que contesta una función de la base. */
export async function answer(owner: Client, call: string, params: unknown[] = []): Promise<string | null> {
  const result = await owner.query<{ state: string | null }>(`select ${call} as state`, params);
  return result.rows[0]?.state ?? null;
}

/**
 * El almacén del equipo sobre esa transacción: las mismas consultas que usa la aplicación,
 * como servidor y a nombre de las claims que se le pasen, pero sin confirmar. Así los
 * servicios del equipo corren contra la base de verdad y lo que cambian se revierte.
 */
export function teamStoreOn(owner: Client): TeamStore & TeamAdminStore {
  const tx: Tx = {
    query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
  };
  async function acting<T>(claims: VerifiedClaims, work: () => Promise<T>): Promise<T> {
    await asServer(owner, claims.userId, claims.sessionId ?? "");
    try {
      return await work();
    } finally {
      await asOwner(owner);
    }
  }
  return {
    standing: (claims, ticketPrint) => acting(claims, () => readTeamStanding(tx, ticketPrint)),
    accept: (claims, ticketPrint, factorId, handoffPrint) =>
      acting(claims, async () => acceptAnswerOf(await acceptInvitation(tx, ticketPrint, factorId, handoffPrint))),
    roster: (claims) => acting(claims, () => readTeamRoster(tx)),
    invite: (claims, email, capabilities) =>
      acting(claims, async () => answerOf(INVITE_ANSWERS, await askInvite(tx, email, capabilities))),
    revokeInvitation: (claims, invitationId) =>
      acting(claims, async () => answerOf(REVOKE_INVITATION_ANSWERS, await askRevokeInvitation(tx, invitationId))),
    grant: (claims, profileId, capability) =>
      acting(claims, async () => answerOf(GRANT_ANSWERS, await askGrant(tx, profileId, capability))),
    revoke: (claims, profileId, capability) =>
      acting(claims, async () => answerOf(REVOKE_ANSWERS, await askRevoke(tx, profileId, capability))),
    resetFactor: (claims, profileId, handoff, version) =>
      acting(claims, async () => answerOf(RESET_ANSWERS, await askReset(tx, profileId, handoff, version))),
  };
}

/** Con qué se le preguntó a la base por el estado de alguien. */
export interface StandingQuestion {
  userId: string;
  sessionId: string | null;
  aal: string;
  /** La huella del resguardo que traía ese navegador, o nulo. */
  ticket: string | null;
}

/**
 * Un almacén del equipo que contesta el estado que se le diga y anota con qué se le preguntó.
 * Es para probar qué estado sale cuando alguien acaba de quedar dentro. Ahí no sirve una
 * invitación dentro de una transacción que se revierte: entrar anota la sesión tomando el
 * candado de fila del perfil, y la invitación sin confirmar lo tendría tomado. Lo que la
 * base contesta de verdad con una invitación viva se prueba en `34-equipo-servicios`.
 */
export function answeringStore(standing: TeamStanding | "throws"): { teamStore: TeamStore & TeamAdminStore; asked: StandingQuestion[] } {
  const asked: StandingQuestion[] = [];
  const never = () => Promise.reject(new Error("Aquí no se cambia ni se lee al equipo."));
  const teamStore: TeamStore & TeamAdminStore = {
    standing: (claims, ticketPrint) => {
      asked.push({ userId: claims.userId, sessionId: claims.sessionId, aal: claims.aal, ticket: ticketPrint });
      return standing === "throws" ? Promise.reject(new Error("La base no contestó.")) : Promise.resolve(standing);
    },
    accept: () => Promise.reject(new Error("Aquí no se acepta nada.")),
    roster: never,
    invite: never,
    revokeInvitation: never,
    grant: never,
    revoke: never,
    resetFactor: never,
  };
  return { teamStore, asked };
}
