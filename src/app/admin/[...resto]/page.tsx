import { notFound } from "next/navigation";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireAdmin } from "@/app/_lib/guard";
import { ROUTES, teamDestination } from "@/services/account/navigation";

// Todo lo que cuelga de `/admin` y todavía no tiene su página. Corre la misma guarda que
// administración y, a quien sí es del equipo, le contesta que esa ruta no existe.
//
// Sin esto, una ruta de administración que existe y una que no existe se distinguirían
// desde fuera: «no se supo» se provoca a voluntad con una cookie inventada, y entonces la
// que existe pintaría su aviso con 200 mientras la que no existe daría 404. Con el comodín,
// toda ruta bajo `/admin` le contesta lo mismo a quien no es del equipo, exista o no.
//
// Una página nueva de administración toma su ruta antes que este comodín, y llama a la
// misma guarda. No exporta `metadata`.

export default async function AdminRestPage({ params }: { params: Promise<{ resto: string[] }> }) {
  const { resto } = await params;
  const path = `${ROUTES.admin}/${resto.join("/")}`;

  const step = await requireAdmin(path);
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  // A dónde reintentar sale de la ruta ya validada: si no vale como destino, a administración.
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={teamDestination(path)} withSession />;

  notFound();
}
