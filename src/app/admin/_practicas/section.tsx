import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import type { VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { catalogLists } from "@/services/catalog/catalog";

import { catalogView } from "./rows";
import { CatalogScreen } from "./screen";

// PA-67 · Las prácticas y los niveles (`/admin/practicas`; RF-709, FL-58). No es una página:
// la sirve el comodín de administración, que corre la guarda antes y solo llega aquí con
// alguien del equipo que tiene Contenido (`src/app/admin/_lib/sections.tsx`).
//
// Las listas se leen con las claims con que la guarda dejó pasar, y la base solo se las
// contesta a quien pasa su puerta con Contenido. Si entre la guarda y la lectura la sesión
// dejó de pasar, no se supo: «Reintentar» vuelve a correr la guarda, que decide.

export async function CatalogSection({ claims }: { claims: VerifiedClaims }) {
  const read = await catalogLists(claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.catalog} withSession />;

  return <CatalogScreen view={catalogView(read.lists)} />;
}
