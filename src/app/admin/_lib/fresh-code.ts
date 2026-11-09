import type { FreshCode } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type { FinanceCode } from "@/services/anomalies/anomalies";
import type { BillingCode } from "@/services/billing/billing";
import type { CatalogCode } from "@/services/catalog/catalog";
import type { LegalCode } from "@/services/legal/legal-admin";
import type { PeriodsCode } from "@/services/periods/periods";
import type { TeacherCode } from "@/services/teachers/teacher-admin";

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

/**
 * Un campo que la pantalla manda una sola vez y como texto: lo que una acción necesita de ella (de qué periodo, de qué
 * maestro) viaja en un campo oculto del formulario, nunca atado a la acción con `bind`. Sin JavaScript, al volver de una
 * acción que contesta, React compara la acción de la pantalla con la enviada y espera la promesa de sus argumentos atados;
 * `bind` arma otra en cada pintada, y la página no termina de pintarse (medido el 2026-11-08 y el 2026-11-09 en el camino
 * del equipo). Lo que falta, se repite o no es texto es nulo, y quien lo lee lo revisa como cualquier otro campo.
 */
export function screenField(form: unknown, name: string): string | null {
  if (!(form instanceof FormData)) return null;
  const values = form.getAll(name);
  const [only] = values;
  return values.length === 1 && typeof only === "string" ? only : null;
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
export function givenCodeOutcome(
  result: FreshCode | CatalogCode | FinanceCode | PeriodsCode | LegalCode | TeacherCode | BillingCode,
  page: string,
): CodeOutcome {
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
