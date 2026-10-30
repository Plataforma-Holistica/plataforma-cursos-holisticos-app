import { notFound } from "next/navigation";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireTeacher } from "@/app/_lib/guard";
import { resolveDestination, ROUTES } from "@/services/account/navigation";

import { screenAt } from "../_lib/screens";

// Todo lo que cuelga de `/portal`: las pantallas del maestro, y lo que no existe (T-402). Corre la guarda
// del maestro y después pinta la pantalla o contesta que esa ruta no existe. Las pantallas no tienen página
// propia, por lo mismo que las de administración: a quien no es maestro, toda ruta bajo `/portal` le
// contesta lo mismo, exista o no. Una pantalla nueva entra a `_lib/screens.tsx`. No exporta `metadata`.

export default async function PortalRestPage({
  params,
  searchParams,
}: {
  params: Promise<{ resto: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { resto } = await params;
  const search = await searchParams;
  const path = `${ROUTES.portal}/${resto.join("/")}`;
  const screen = screenAt(resto);

  const step = await requireTeacher(path);
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  // A dónde reintentar sale de la ruta ya validada: si no vale como destino, a sus cursos.
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={resolveDestination(path) === path ? path : ROUTES.portalCourses} withSession />;
  if (screen !== null) return screen.render({ claims: step.claims, readOnly: step.teacher.status === "suspended", search });

  notFound();
}
