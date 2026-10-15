import { ChevronLeft } from "lucide";
import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "./icon";

// Regresar (`BackLink`, diseño, sección 5.2): volver al nivel anterior sin depender del botón
// del navegador. El texto dice a dónde («Volver a Explorar»): lo pasa la pantalla. La flecha es
// decorativa, porque el texto ya lo dice.

export interface BackLinkProps {
  href: string;
  children: ReactNode;
}

export function BackLink({ href, children }: BackLinkProps) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-touch items-center gap-1 text-body-s text-text-2 underline-offset-4 transition-colors duration-(--duration-fast) ease-standard hover:text-text hover:underline"
    >
      <Icon icon={ChevronLeft} size={16} />
      {children}
    </Link>
  );
}
