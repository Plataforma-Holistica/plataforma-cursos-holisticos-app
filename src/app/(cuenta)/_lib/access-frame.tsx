import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { ROUTES } from "@/services/account/navigation";
import acceso from "@/ui/photos/acceso-ondas.jpg";
import { Wordmark } from "@/ui/wordmark";

// El marco de las pantallas de acceso (diseño, sección 3.12; T-614, parte 3). En computadora, la foto de
// acceso (ondas sobre agua oscura) en media pantalla, con el velo del fondo y el logotipo, y al lado el
// formulario de siempre; en el teléfono, una franja corta arriba con la foto y el logotipo, y el formulario
// entero debajo (decisión de Sergio del 2026-11-05). El segundo factor (PA-12) y los consentimientos (PA-15)
// lo usan con el logotipo y sin foto: §3.12 no se la pone (también decisión de Sergio de ese día).
//
// Solo envuelve: cada pantalla sigue pintando su `<main>`, sus textos y sus estados. La foto es decorativa
// y carga después del formulario, que es lo que importa en estas pantallas.

function Brand() {
  return (
    <header>
      <Link href={ROUTES.landing} className="inline-flex min-h-touch items-center text-h3">
        <Wordmark />
      </Link>
    </header>
  );
}

export function AccessFrame({ photo = true, children }: { photo?: boolean; children: ReactNode }) {
  if (!photo) {
    return (
      <>
        <div className="mx-auto max-w-form px-4 pt-6">
          <Brand />
        </div>
        {children}
      </>
    );
  }
  return (
    <div className="lg:grid lg:min-h-svh lg:grid-cols-2">
      <div className="relative isolate h-32 overflow-hidden lg:h-auto">
        <Image src={acceso} alt="" fill sizes="(min-width: 1024px) 50vw, 100vw" className="object-cover" />
        {/* Al 65 %: el logotipo cae sobre las nubes, lo más claro de la foto (medido el 2026-11-05). */}
        <span aria-hidden="true" className="absolute inset-0 bg-bg/65" />
        <div className="relative px-4 py-4 sm:px-8 lg:p-10">
          <Brand />
        </div>
      </div>
      {/* Centrado en el alto. `*:w-full`: en una columna flexible, el `mx-auto` de cada `<main>` lo encogería a su contenido. */}
      <div className="lg:flex lg:flex-col lg:justify-center lg:*:w-full">{children}</div>
    </div>
  );
}
