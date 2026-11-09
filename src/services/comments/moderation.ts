import "server-only";

import { getEnv } from "@/config/env";

// El modelo de moderación (ADR-30; RF-802; T-502): lo que la lista de términos de la base no marcó se le pregunta aquí, fuera
// de la transacción, con el texto y nada más (sin autor, sin lección, sin identificador). Sergio decidió el 2026-11-09 construir
// con el proveedor de prueba y elegir el real cuando conteste el abogado (07, punto 8). Sin `MODERATION_PROVIDER` no hay
// proveedor: lo que la lista no marcó queda en revisión.

export type ModerationVerdict = "pass" | "flagged" | "risk";

export interface Moderation {
  /** Como lo anota la base en `filter_provider`. */
  provider: string;
  /** El veredicto, o nulo si no contestó a tiempo: entonces el comentario queda en revisión. Nunca lanza. */
  classify(text: string): Promise<ModerationVerdict | null>;
}

/** El tope para contestar: lo que tarde más queda en revisión. */
export const MODERATION_TIMEOUT_MS = 5_000;

/**
 * El proveedor de prueba, sin red: decide por marcas en el texto, para que las pruebas lleguen a cada camino. La base solo
 * acepta su aprobado con la marca local `comments_test_filter`, y `env.ts` no lo deja fuera de local.
 */
export const testModeration: Moderation = {
  provider: "test",
  classify: async (text) => {
    if (text.includes("[sin-filtro]")) return null;
    if (text.includes("[riesgo]")) return "risk";
    if (text.includes("[revisar]")) return "flagged";
    return "pass";
  },
};

/** El proveedor que pide `MODERATION_PROVIDER`, o nulo. */
export function activeModeration(): Moderation | null {
  return getEnv().MODERATION_PROVIDER === "test" ? testModeration : null;
}
