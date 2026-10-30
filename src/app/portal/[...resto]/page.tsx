import { notFound } from "next/navigation";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireTeacher } from "@/app/_lib/guard";
import { resolveDestination, ROUTES } from "@/services/account/navigation";

import { NoticeSection } from "../_aviso/section";
import { InvitationSection } from "../_invitacion/section";
import { screenAt } from "../_lib/screens";

// Todo lo que cuelga de `/portal`: las pantallas del maestro, y lo que no existe (T-402). Corre la guarda
// del maestro y después pinta la pantalla o contesta que esa ruta no existe. Las pantallas no tienen página
// propia, por lo mismo que las de administración: a quien no es maestro, toda ruta bajo `/portal` le
// contesta lo mismo, exista o no. Una pantalla nueva entra a `_lib/screens.tsx`. No exporta `metadata`.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const single = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

export default async function PortalRestPage({
  params,
  searchParams,
}: {
  params: Promise<{ resto: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { resto } = await params;
  const search = await searchParams;
  // La ruta, con lo elegido en el editor si tiene forma: es a donde se vuelve después de entrar.
  const lesson = single(search.leccion);
  const chosenModule = single(search.modulo);
  const query = lesson !== null && ID.test(lesson) ? `?leccion=${lesson}` : chosenModule !== null && ID.test(chosenModule) ? `?modulo=${chosenModule}` : "";
  const path = `${ROUTES.portal}/${resto.join("/")}${query}`;
  const screen = screenAt(resto);

  const step = await requireTeacher(path, screen?.kind ?? "work");
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  // A dónde reintentar sale de la ruta ya validada: si no vale como destino, a sus cursos.
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={resolveDestination(path) === path ? path : ROUTES.portalCourses} withSession />;
  if (step.screen === "invitation") return <InvitationSection proven={step.invitation.proven} name={step.invitation.name} claims={step.claims} />;
  if (step.screen === "notice") return <NoticeSection claims={step.claims} search={search} />;
  if (screen !== null) return screen.render({ claims: step.claims, readOnly: step.teacher.status === "suspended", search });

  notFound();
}
