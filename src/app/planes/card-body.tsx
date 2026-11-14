import { plans as text } from "@/messages/es/plans";

import type { PlanCard } from "./view";

// Lo que dice la tarjeta de un plan (T-616, 3b-4), igual en `/planes` y en la portada: sin estado ni acciones, para que la portada lo pinte
// sin traer la pantalla de pagar. Importa solo su bloque de textos: lo usa también la pantalla de los planes, que corre en el navegador.

/** Lo que dice una tarjeta, igual en `/planes` y en la portada. El antetítulo en el oro apagado, sobre el fondo liso de la tarjeta. */
export function PlanCardBody({ card }: { card: Pick<PlanCard, "name" | "price" | "repeat" | "equivalent" | "featured" | "saving"> }) {
  return (
    <>
      {card.featured && <p className="eyebrow text-accent-muted">{text.featured}</p>}
      <h3 className="text-h3">{card.name}</h3>
      <p className="text-h2">{card.price}</p>
      <p className="text-body-s text-text-2">{card.repeat}</p>
      {card.equivalent !== null && <p className="text-body-s text-text-2">{card.equivalent}</p>}
      {card.saving !== null && <p className="text-body-s font-semibold text-text">{card.saving}</p>}
    </>
  );
}
