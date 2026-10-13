import { requireFactorSetup } from "@/app/_lib/guard";
import { ROUTES } from "@/services/account/navigation";

import { SuspendedScreen, UnavailableScreen } from "../../../_lib/states";

import { FactorSetupScreen } from "./screen";

// PA-12 · Segundo factor, configurar (`/entrar/segundo-factor/configurar`). Aquí se acepta
// una invitación de administración: dando de alta un factor y verificando su código. Quién
// tiene una invitación lo dice la base, por la guarda; a quien no la tiene se le contesta lo
// mismo que en una ruta que no existe.
//
// La página no da de alta nada: una lectura no escribe cookies, y dar de alta borra los
// factores a medias, así que recargar rompería la otra pestaña. Por eso hay un paso
// «Empezar», que es una acción.
//
// No exporta `metadata`: el título de una página no debe poder asomarse en la respuesta de
// «no existe» que recibe quien no es del equipo.

export default async function FactorSetupPage() {
  const step = await requireFactorSetup();
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.factorSetup} withSession />;

  return <FactorSetupScreen view={step} />;
}
