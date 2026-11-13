import "server-only";

import { asSystem } from "@/adapters/supabase/db";
import { reportFailure } from "@/services/error-reporting/server";

import { askOffer } from "./checkout-records";
import { createPlanShowcase } from "./showcase";

// Los precios de la portada ya armados (T-616, solicitud 4b): la misma consulta de la oferta que `/planes`, como sistema, con su memoria
// corta. Solo la importa la portada.

export type { PlanShowcase } from "./showcase";

export const { planShowcase } = createPlanShowcase({
  offer: () => asSystem({ reason: "plans_showcase" }, askOffer),
  report: reportFailure,
});
