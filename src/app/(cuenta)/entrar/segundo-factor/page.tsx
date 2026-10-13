import { requireSecondFactor } from "@/app/_lib/guard";
import { RETURN_PARAM, secondFactorPath } from "@/services/account/navigation";

import { SuspendedScreen, UnavailableScreen } from "../../_lib/states";

import { SecondFactorScreen, SecondFactorUnboundScreen } from "./screen";

// PA-12 · Segundo factor, pedir el código (`/entrar/segundo-factor`). Es de quien es del
// equipo y entró con su contraseña: está a un código de administración. Quién es del equipo
// lo dice la base, por la guarda; a quien no lo es se le contesta lo mismo que en una ruta
// que no existe.
//
// No exporta `metadata`: el título de una página no debe poder asomarse en la respuesta de
// «no existe» que recibe quien no es del equipo.

type Params = Record<string, string | string[] | undefined>;

export default async function SecondFactorPage({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = (await searchParams)[RETURN_PARAM];
  // Tal como llegó: la guarda y la acción lo validan. Repetido en la dirección no es un destino.
  const returnTo = typeof raw === "string" ? raw : "";

  const step = await requireSecondFactor(returnTo);
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={secondFactorPath(returnTo)} withSession />;

  if (step.view === "unbound") return <SecondFactorUnboundScreen />;
  return <SecondFactorScreen returnTo={returnTo} />;
}
