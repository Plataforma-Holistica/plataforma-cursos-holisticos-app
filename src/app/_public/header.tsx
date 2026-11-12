"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { landing } from "@/messages/es/landing";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { cx } from "@/ui/cx";
import { TextLink } from "@/ui/text-link";
import { Wordmark } from "@/ui/wordmark";

// La barra del sitio público (`PublicHeader`, diseño, sección 5; T-614, parte 2). Tiene dos variantes.
// Sobre una foto (`overPhoto`, la portada) va transparente arriba; al desplazar la página pasa a sólida y
// queda fija. Sin JavaScript se queda transparente arriba y se va con la página: nunca queda fija sobre el
// contenido sin su fondo. Sin foto debajo (las fichas del visitante, parte 4) es sólida desde el principio
// y se queda arriba al desplazar.
//
// Lleva la marca, «Planes» (T-616, solicitud 4; pedido de Sergio del 2026-11-11: los planes antes de crear
// cuenta), «Entrar» y «Crear cuenta». Para maestros y Ayuda entran cuando existan sus pantallas (decisión de
// Sergio del 2026-11-05). En el teléfono, la marca y «Crear cuenta», siempre a la mano; «Planes» y «Entrar»
// están en el pie, y «Entrar» también en el encabezado (decisiones mías sin confirmar: a 320 px no caben los
// cuatro, y un menú con dos cosas no hace falta). El de la barra es secundario: el principal de la pantalla
// es el del encabezado. En los planes, «Planes» va marcado (`onPlans`).

const text = landing.header;

export function PublicHeader({ overPhoto = false, onPlans = false }: { overPhoto?: boolean; onPlans?: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  const solid = !overPhoto || scrolled;

  useEffect(() => {
    if (!overPhoto) return;
    const measure = () => setScrolled(window.scrollY > 0);
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    return () => window.removeEventListener("scroll", measure);
  }, [overPhoto]);

  return (
    <header
      data-solid={solid}
      className={cx(
        "inset-x-0 top-0 z-(--z-sticky) border-b transition-colors duration-(--duration-fast) ease-standard",
        !overPhoto ? "sticky border-border bg-surface-1" : solid ? "fixed border-border bg-surface-1" : "absolute border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex max-w-page items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8">
        <Link href={ROUTES.landing} className="inline-flex min-h-touch items-center text-body-l sm:text-h3">
          {/* En el teléfono el nombre se parte en dos renglones: con la flor (T-616) no cabía junto a «Crear
              cuenta» a 320 px. */}
          <Wordmark className="max-sm:whitespace-normal max-sm:leading-tight" />
        </Link>
        <nav aria-label={text.label}>
          <ul className="flex items-center gap-4 sm:gap-6">
            <li className="hidden sm:block">
              <TextLink href={ROUTES.plans} current={onPlans} className="inline-flex min-h-touch items-center">
                {text.plans}
              </TextLink>
            </li>
            <li className="hidden sm:block">
              <TextLink href={ROUTES.signIn} className="inline-flex min-h-touch items-center">
                {text.signIn}
              </TextLink>
            </li>
            <li>
              <Button href={ROUTES.signUp} variant="secondary" size="md" className="min-h-touch whitespace-nowrap">
                {text.signUp}
              </Button>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
