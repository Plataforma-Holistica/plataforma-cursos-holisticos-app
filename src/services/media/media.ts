import "server-only";

import { signPlayback } from "@/adapters/mux/sign";
import { getEnv } from "@/config/env";

import { checkSession, teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createMediaGrant } from "./grant";
import { databaseMediaStore } from "./store";

// La función única de medios, ya armada con las guardas (del equipo para revisar, de sesión
// para ver), la base, la llave de firma de Mux y el registro de errores. Lo que importan las
// pantallas.

export type { MediaGrant, ReviewGrant } from "./grant";

export const { getMediaGrant } = createMediaGrant(
  { report: reportFailure },
  {
    teamStanding,
    checkSession,
    store: databaseMediaStore,
    signingKey: () => {
      const env = getEnv();
      return env.MUX_SIGNING_KEY_ID !== undefined && env.MUX_SIGNING_PRIVATE_KEY !== undefined
        ? { id: env.MUX_SIGNING_KEY_ID, privateKey: env.MUX_SIGNING_PRIVATE_KEY }
        : null;
    },
    sign: signPlayback,
    now: () => Math.floor(Date.now() / 1000),
  },
);
