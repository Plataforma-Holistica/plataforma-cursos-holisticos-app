"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { landing } from "@/messages/es/landing";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { cx } from "@/ui/cx";
import { TextLink } from "@/ui/text-link";
import { Wordmark } from "@/ui/wordmark";

// La barra del sitio público (`PublicHeader`, diseño, sección 5; T-614, parte 2). Arriba de la
// portada va transparente, sobre la foto y su velo; al desplazar la página pasa a sólida y queda
// fija. Sin JavaScript se queda transparente arriba y se va con la página: nunca queda fija sobre
// el contenido sin su fondo.
//
// Lleva la marca, «Entrar» y «Crear cuenta». Planes, Para maestros y Ayuda entran cuando existan sus
// pantallas (decisión de Sergio del 2026-11-05). En el teléfono, la marca y «Crear cuenta», siempre a
// la mano; «Entrar» está en el encabezado y en el pie (decisión mía sin confirmar: a 320 px no caben
// los tres, y un menú con una sola cosa no hace falta). El de la barra es secundario: el principal
// de la pantalla es el del encabezado.

const text = landing.header;

export function PublicHeader() {
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const measure = () => setSolid(window.scrollY > 0);
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    return () => window.removeEventListener("scroll", measure);
  }, []);

  return (
    <header
      data-solid={solid}
      className={cx(
        "inset-x-0 top-0 z-(--z-sticky) border-b transition-colors duration-(--duration-fast) ease-standard",
        solid ? "fixed border-border bg-surface-1" : "absolute border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex max-w-page items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8">
        <Link href={ROUTES.landing} className="inline-flex min-h-touch items-center text-body-l sm:text-h3">
          <Wordmark />
        </Link>
        <nav aria-label={text.label}>
          <ul className="flex items-center gap-4 sm:gap-6">
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
