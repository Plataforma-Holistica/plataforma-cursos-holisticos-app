import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, type Tx } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry, type TeamStore } from "./team";
import {
  GRANT_ANSWERS,
  INVITE_ANSWERS,
  RESET_ANSWERS,
  REVOKE_ANSWERS,
  REVOKE_INVITATION_ANSWERS,
  type TeamAdminStore,
} from "./team-admin";
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
} from "./team-records";

// Lo que los servicios del equipo le preguntan a la base, a nombre de las claims que
// verificaron: cada pregunta abre su transacción como servidor, con quién actúa y con qué
// sesión tomados de esas claims.

/** `run` es `asServer`. Solo las pruebas de este archivo pasan otro, para ver qué se reintenta. */
export function createTeamStore(run: typeof asServer = asServer): TeamStore & TeamAdminStore {
  /**
   * Un cambio al equipo. Toman el candado del equipo y escriben en tablas de Supabase Auth,
   * y Auth puede estar tocando las mismas filas: un choque de candados revierte la
   * transacción entera, y se intenta una vez más. Ninguna de las cinco escribe antes de
   * rechazar, así que repetirla es seguro. Lo que contestó se entiende ya confirmada.
   */
  async function change<Answer extends string>(
    claims: VerifiedClaims,
    reason: string,
    known: readonly Answer[],
    work: (tx: Tx) => Promise<string>,
  ): Promise<Answer> {
    return answerOf(known, await withLockRetry(() => run({ claims, reason }, work), isLockConflict));
  }

  return {
    // Solo lee y no toma candados: no hay choque que reintentar.
    standing: (claims, ticketPrint) => run({ claims, reason: "team_standing" }, (tx) => readTeamStanding(tx, ticketPrint)),

    // Aceptar escribe en tablas de Supabase Auth, y Auth puede estar tocando las mismas
    // filas: un choque de candados revierte la transacción entera, y se intenta una vez más.
    // Lo que contestó se entiende ya confirmada la transacción: tres de sus rechazos
    // escriben, y lanzar dentro los revertiría.
    accept: async (claims, ticketPrint, factorId, handoffPrint) =>
      acceptAnswerOf(
        await withLockRetry(
          () => run({ claims, reason: "accept_invitation" }, (tx) => acceptInvitation(tx, ticketPrint, factorId, handoffPrint)),
          isLockConflict,
        ),
      ),

    // Solo lee, como el estado.
    roster: (claims) => run({ claims, reason: "team_roster" }, (tx) => readTeamRoster(tx)),

    invite: (claims, email, capabilities) =>
      change(claims, "invite_admin", INVITE_ANSWERS, (tx) => askInvite(tx, email, capabilities)),
    revokeInvitation: (claims, invitationId) =>
      change(claims, "revoke_admin_invitation", REVOKE_INVITATION_ANSWERS, (tx) => askRevokeInvitation(tx, invitationId)),
    grant: (claims, profileId, capability) =>
      change(claims, "grant_capability", GRANT_ANSWERS, (tx) => askGrant(tx, profileId, capability)),
    revoke: (claims, profileId, capability) =>
      change(claims, "revoke_capability", REVOKE_ANSWERS, (tx) => askRevoke(tx, profileId, capability)),
    resetFactor: (claims, profileId, handoff, version) =>
      change(claims, "reset_second_factor", RESET_ANSWERS, (tx) => askReset(tx, profileId, handoff, version)),
  };
}

export const databaseTeamStore = createTeamStore();
