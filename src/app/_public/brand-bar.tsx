import Link from "next/link";

import { ROUTES } from "@/services/account/navigation";
import { Wordmark } from "@/ui/wordmark";

// Solo el logotipo, arriba (T-616, solicitud 4; pedido de Sergio del 2026-11-11: «el logo debe ser importante que
// esté en toda página»). Para las pantallas sueltas que no llevan otra barra: los textos legales, la de no
// encontrado y la de error. Lleva a la portada, que manda al inicio a quien tiene sesión (`visitorOnly`): no hace
// falta preguntar aquí quién mira, y la de no encontrado sigue siendo la misma para todos. Sin «Crear cuenta»:
// quien lee un texto legal puede tener sesión. No usa nada del navegador: la pinta también la de error.

export function BrandBar() {
  return (
    <header className="border-b border-border bg-surface-1">
      <div className="mx-auto flex max-w-page items-center px-4 py-3 sm:px-8">
        <Link href={ROUTES.landing} className="inline-flex min-h-touch items-center text-body-l sm:text-h3">
          <Wordmark />
        </Link>
      </div>
    </header>
  );
}
