import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { cookieReader } from "@/app/_lib/request-context";
import { teamRoster, type VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";

import { teamView } from "./rows";
import { TeamScreen } from "./screen";

// PA-86 · El equipo de administración (`/admin/equipo`; RF-712). No es una página: la sirve
// el comodín de administración, que corre la guarda antes y solo llega aquí con alguien del
// equipo que tiene la capacidad de configuración (`src/app/admin/_lib/sections.tsx`).
//
// La lista se lee con las claims con que la guarda dejó pasar, y la base solo se la contesta
// a quien pasa su puerta con configuración. Si entre la guarda y la lectura la sesión dejó
// de pasar, no se supo: «Reintentar» vuelve a correr la guarda, que decide.

export async function TeamSection({ claims }: { claims: VerifiedClaims }) {
  const read = await teamRoster(await cookieReader(), claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.team} withSession />;

  return <TeamScreen view={teamView(read.roster)} />;
}
