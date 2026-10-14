import { notFound } from "next/navigation";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireAdmin } from "@/app/_lib/guard";
import { ROUTES, teamDestination } from "@/services/account/navigation";

import { sectionAt } from "../_lib/sections";
import { ForbiddenScreen } from "../_lib/states";

// Todo lo que cuelga de `/admin`: sus secciones, y lo que no existe. Corre la misma guarda
// que administración, con la capacidad que la sección pida, y después pinta la sección o
// contesta que esa ruta no existe.
//
// Las secciones no tienen página propia, y es a propósito. A quien no es del equipo, toda
// ruta bajo `/admin` tiene que contestarle lo mismo, exista o no:
//
//   · «No se supo» se provoca a voluntad con una cookie inventada: si una sección tuviera su
//     página y lo demás no tuviera ninguna, la que existe pintaría su aviso con 200 mientras
//     la que no existe daría 404.
//   · Y aunque las dos contesten «no existe» con lo mismo a la vista, Next incrusta en el
//     documento el árbol de rutas y los fragmentos de la página que contestó (medido el
//     2026-10-13): una página propia se distinguía del comodín.
//
// Con todo servido desde aquí, de una ruta a otra solo cambia la ruta pedida. Una sección
// nueva entra a `_lib/sections.tsx`. No exporta `metadata`.

export default async function AdminRestPage({ params }: { params: Promise<{ resto: string[] }> }) {
  const { resto } = await params;
  const path = `${ROUTES.admin}/${resto.join("/")}`;
  const section = sectionAt(resto);

  const step = await requireAdmin(path, section?.capability);
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  // A dónde reintentar sale de la ruta ya validada: si no vale como destino, a administración.
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={teamDestination(path)} withSession />;
  // Es del equipo y le falta la capacidad de esa sección: se le dice cuál (PA-88).
  if (step.kind === "forbidden") return <ForbiddenScreen capability={step.capability} />;
  if (section !== null) return section.render(step.claims);

  notFound();
}
