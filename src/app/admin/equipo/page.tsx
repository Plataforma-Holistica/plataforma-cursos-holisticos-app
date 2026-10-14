import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireAdmin } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { teamRoster } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";

import { ForbiddenScreen } from "../_lib/states";

import { teamView } from "./rows";
import { TeamScreen } from "./screen";

// PA-86 · El equipo de administración (`/admin/equipo`; RF-712). Pide ser del equipo con la
// capacidad de configuración. Quién lo es lo dice la base, por la guarda: a quien no es del
// equipo se le contesta lo mismo que en una ruta que no existe, y a quien lo es sin esa
// capacidad se le dice cuál falta (PA-88).
//
// La lista se lee con las claims con que la guarda dejó pasar, y la base solo se la contesta
// a quien pasa su puerta con configuración. Si entre la guarda y la lectura la sesión dejó
// de pasar, no se supo: «Reintentar» vuelve a correr la guarda, que decide.
//
// No exporta `metadata`: el título de una página no debe poder asomarse en la respuesta de
// «no existe» que recibe quien no es del equipo.

export default async function TeamPage() {
  const step = await requireAdmin(ROUTES.team, "config");
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.team} withSession />;
  if (step.kind === "forbidden") return <ForbiddenScreen capability={step.capability} />;

  const read = await teamRoster(await cookieReader(), step.claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.team} withSession />;

  return <TeamScreen view={teamView(read.roster)} />;
}
