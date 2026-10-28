import type { FreshCode } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type { FinanceCode } from "@/services/anomalies/anomalies";
import type { CatalogCode } from "@/services/catalog/catalog";
import type { PeriodsCode } from "@/services/periods/periods";

// «Tu código» en las secciones de administración que cambian algo con un código reciente:
// el equipo (PA-86) y las prácticas y los niveles (PA-67). Cada sección tiene su propio
// servicio para darlo (el que comprueba lo reciente con su propia lectura), y las dos
// traducen la respuesta con esta tabla, a la que le dicen cuál es su página.
//
// Viaja al navegador: no importa nada del servidor.

/** A dónde manda una acción cuando no pinta nada. */
export interface Leave {
  kind: "leave";
  to: string;
  notice: Notice | null;
}

/** Lo que el bloque del código pinta después de un envío. Nunca trae el código. */
export type CodeState =
  | { kind: "idle" }
  | { kind: "invalid"; problem: "required" | "invalid"; attempt: number }
  | { kind: "failed"; reason: "wrong_code" | "unavailable" | "not_available"; attempt: number };

export type CodeOutcome = Leave | { kind: "failed"; reason: "wrong_code" | "unavailable" | "not_available" };

/**
 * Lo que contestó dar el código, en la sección cuya página es `page`. Dado el código, y a
 * quien la guarda no dejó, se va a esa misma página: decide su guarda, y recargar no reenvía
 * un código.
 */
export function givenCodeOutcome(result: FreshCode | CatalogCode | FinanceCode | PeriodsCode, page: string): CodeOutcome {
  const toPage: Leave = { kind: "leave", to: page, notice: null };
  switch (result.kind) {
    case "verified":
      // Una redirección, y no volver a pintar: así recargar no reenvía un código de seis
      // dígitos, que pasada su ventana contaría en el freno.
      return toPage;
    case "wrong_code":
      return { kind: "failed", reason: "wrong_code" };
    case "throttled":
      // El freno rechazó: Auth ya cerró todas las sesiones de la cuenta y el adaptador borró
      // la cookie. No queda nada que cerrar: solo decirle qué pasó.
      return { kind: "leave", to: ROUTES.signIn, notice: "second_factor_throttled" };
    case "not_available":
      return { kind: "failed", reason: "not_available" };
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "refused":
      return toPage;
  }
}
