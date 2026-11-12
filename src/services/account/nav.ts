import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { reportFailure } from "@/services/error-reporting/server";

import { createNavAccess } from "./nav-access";
import { readNavStates } from "./team-records";

// Los accesos de la barra del alumno, ya armados: lo que importan las pantallas (T-616, solicitud 2). Una sola
// transacción como el servidor, con las claims de la guarda: sin otro `checkSession`.

export type { NavAccess } from "./nav-access";

export const navAccess = createNavAccess({
  read: (claims) => asServer({ claims, reason: "nav_access" }, readNavStates),
  report: reportFailure,
});
