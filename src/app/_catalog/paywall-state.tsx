import { plansPath } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { FlowerState } from "@/ui/flower-state";

import { paywallAction, paywallCopy, type Denial } from "./paywall";

// PA-33 con el lenguaje del sistema visual (T-616, solicitud 3): por qué no hay acceso, como un estado con la flor, y la acción
// a los planes con la lección como destino (T-302). Va en el lugar del reproductor, así que es el estado chico: cabe en un
// 16:9 del teléfono. El título y la frase los da `paywallCopy`, y la acción `paywallAction`, los mismos de siempre.
//
// La lección (`cursos/*/lecciones/`, con dueño) todavía pinta su propio `Paywall`: cambiarlo por este es de la solicitud 3b.

export function PaywallState({ denial, back }: { denial: Denial; back: string | null }) {
  const [title, sentence] = paywallCopy(denial);
  return (
    // El título es un `h2`, como el del `Paywall` que reemplaza en la lección (lo buscan sus pruebas).
    <FlowerState
      size="compact"
      titleLevel={2}
      title={title}
      className="h-full justify-center"
      action={
        <Button href={plansPath(back)} size="md">
          {paywallAction(denial)}
        </Button>
      }
    >
      {sentence}
    </FlowerState>
  );
}
