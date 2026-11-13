import { slugOfDocType } from "@/services/legal/slugs";

/**
 * La página del texto del cobro recurrente (con su versión) o de la política de reembolsos, o nulo si no tiene página. Sin la del cobro
 * recurrente no se vende: lo usan `/planes` y la portada (T-616, solicitud 4b), con el mismo criterio.
 */
export function plansLegalHref(doc: "recurring" | "refund", version: number | null): string | null {
  const slug = slugOfDocType(doc === "recurring" ? "recurring_charge_consent" : "refund_policy");
  if (slug === null) return null;
  return version === null ? `/legal/${slug}` : `/legal/${slug}?v=${version}`;
}
