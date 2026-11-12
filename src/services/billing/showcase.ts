import type { CheckoutPlan, Offer } from "./checkout";

// Los precios de la portada (T-616, solicitud 4b; RF-201): lo que la página más visitada necesita de la oferta, con una memoria corta en
// el proceso. Lo leído se recuerda un minuto, y el «no se supo», 15 s (decisión del carril A, sin confirmar por Sergio): una base caída no
// recibe una lectura por visita, ni un reporte por cada una, y cuando vuelve, la portada lo nota pronto. Muchas visitas a la vez esperan
// la misma lectura.
//
// Solo la portada: la cifra ahí es informativa y lleva a `/planes`. Lo que la persona acepta (PA-04, la salida a pagar) se lee fresco con
// `planOffer`, y tests/architecture/billing.test.ts lo exige. Cada instancia guarda su copia: al entrar un precio programado, una portada
// puede mostrar el anterior hasta un minuto, y el enlace de su tarjeta no lleva el monto.
//
// Contesta solo lo que la portada pinta: el plan, su total y la versión del texto del cobro recurrente (con ella aplica el mismo criterio
// de «a la venta» que `/planes`). Ni la clave de Stripe, ni el siguiente cobro (que depende de la hora), ni el texto.

export const SHOWCASE_MEMORY_MS = 60_000;
export const SHOWCASE_FAILURE_MEMORY_MS = 15_000;
/**
 * Lo más que espera la portada a la base. Las visitas comparten la lectura en curso: sin tope, un socket mudo colgaría la portada en
 * cada visita hasta reciclar la instancia, aunque la base ya hubiera vuelto. Pasado el tope se dice «no se supo» (sin cifras) y se
 * suelta la lectura; si la de la base llega después, se descarta.
 */
export const SHOWCASE_READ_TIMEOUT_MS = 3_000;

export type PlanShowcase =
  | { kind: "ready"; plans: { plan: CheckoutPlan; amountCents: number }[]; recurringVersion: number | null }
  | { kind: "unavailable" };

export interface PlanShowcaseDeps {
  offer: () => Promise<Offer>;
  report: (code: "plans_showcase_unavailable") => Promise<void>;
  now?: () => number;
}

export function createPlanShowcase(deps: PlanShowcaseDeps): { planShowcase: () => Promise<PlanShowcase> } {
  const now = deps.now ?? Date.now;
  let remembered: { value: PlanShowcase; at: number } | null = null;
  let reading: Promise<PlanShowcase> | null = null;

  const fresh = (memory: { value: PlanShowcase; at: number }) => {
    const age = now() - memory.at;
    // Un reloj que va hacia atrás no deja lo recordado vigente para siempre.
    return age >= 0 && age < (memory.value.kind === "ready" ? SHOWCASE_MEMORY_MS : SHOWCASE_FAILURE_MEMORY_MS);
  };

  async function read(): Promise<PlanShowcase> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("la base no contestó a tiempo")), SHOWCASE_READ_TIMEOUT_MS);
    });
    try {
      const offer = await Promise.race([deps.offer(), timeout]);
      return {
        kind: "ready",
        plans: offer.plans.map(({ plan, amountCents }) => ({ plan, amountCents })),
        recurringVersion: offer.recurring === null ? null : offer.recurring.version,
      };
    } catch {
      // Una vez por lectura fallida, no por visita. Si reportar falla, la portada sigue igual.
      await deps.report("plans_showcase_unavailable").catch(() => undefined);
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  function planShowcase(): Promise<PlanShowcase> {
    if (remembered !== null && fresh(remembered)) return Promise.resolve(remembered.value);
    if (reading !== null) return reading;
    const mine = read()
      .then((value) => {
        remembered = { value, at: now() };
        return value;
      })
      .finally(() => {
        if (reading === mine) reading = null;
      });
    reading = mine;
    return mine;
  }

  return { planShowcase };
}
