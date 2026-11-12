import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { NO_NAV_ACCESS, navAccessOf, type NavAccess, type TeacherNavState, type TeamNavState } from "@/domain/access/nav-access";
import type { FailureCode } from "@/services/error-reporting/server";

// Los accesos de la barra del alumno (T-616, solicitud 2): «Mi portal» y «Administración». Una comodidad, como
// el menú lateral: quién entra lo decide la guarda de esa pantalla. Lo arma `nav.ts`, y lo pide cada pantalla
// después de su guarda, con las claims que verificó, a la par de lo suyo.
//
// Nunca pasa por ninguna memoria: recordarlo sería la única forma de mostrarle «Administración» a otra persona.
// Lo que no se supo no abre nada, y se reporta.

export { NO_NAV_ACCESS, opensPortal, type NavAccess } from "@/domain/access/nav-access";

/** Los dos estados de quien actúa, leídos en una sola transacción como el servidor. Nulo, el que no se supo. */
export interface NavStates {
  team: TeamNavState | null;
  teacher: TeacherNavState | null;
}

export interface NavAccessDeps {
  read(claims: VerifiedClaims): Promise<NavStates>;
  report(code: FailureCode): Promise<void>;
}

export function createNavAccess({ read, report }: NavAccessDeps) {
  return async function navAccess(claims: VerifiedClaims): Promise<NavAccess> {
    let states: NavStates;
    try {
      states = await read(claims);
    } catch {
      await report("nav_access_unavailable");
      return NO_NAV_ACCESS;
    }
    // Una mitad que no se supo no abre nada, y no le quita a la otra lo suyo.
    if (states.team === null || states.teacher === null) await report("nav_access_unavailable");
    return navAccessOf(states.team, states.teacher);
  };
}
