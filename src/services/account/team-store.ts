import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry, type TeamStore } from "./team";
import { acceptAnswerOf, acceptInvitation, readTeamStanding } from "./team-records";

// Lo que los servicios del equipo le preguntan a la base, a nombre de las claims que
// verificaron: cada pregunta abre su transacción como servidor, con quién actúa y con qué
// sesión tomados de esas claims.

/** `run` es `asServer`. Solo las pruebas de este archivo pasan otro, para ver qué se reintenta. */
export function createTeamStore(run: typeof asServer = asServer): TeamStore {
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
  };
}

export const databaseTeamStore = createTeamStore();
