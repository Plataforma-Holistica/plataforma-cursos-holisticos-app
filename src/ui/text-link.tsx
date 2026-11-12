import Link from "next/link";
import type { ReactNode } from "react";

import { ui } from "@/messages/es/ui";

import { cx, SPACE } from "./cx";

// Un enlace dentro de un texto. El color no es su única señal: va subrayado.

export interface TextLinkProps {
  href: string;
  /** Abre en otra pestaña, como el documento de un consentimiento: no borra lo escrito. */
  external?: boolean;
  children: ReactNode;
  className?: string;
  /** Es la página en que se está (`aria-current="page"`), como «Planes» de la barra pública en los planes. */
  current?: boolean;
}

const CLASSES =
  "text-accent underline underline-offset-4 transition-colors duration-(--duration-fast) ease-standard hover:text-accent-strong";
// La página en que se está: en el color del texto, con peso y el subrayado grueso. Va en lugar de las de siempre, no encima: dos
// clases de color en el mismo elemento las decide el orden del CSS.
const CURRENT = "font-semibold text-text underline decoration-2 underline-offset-4";

export function TextLink({ href, external = false, children, className, current = false }: TextLinkProps) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cx(CLASSES, className)}>
        {children}
        {SPACE}
        <span className="sr-only">{ui.link.newTab}</span>
      </a>
    );
  }
  return (
    <Link href={href} aria-current={current ? "page" : undefined} className={cx(current ? CURRENT : CLASSES, className)}>
      {children}
    </Link>
  );
}
