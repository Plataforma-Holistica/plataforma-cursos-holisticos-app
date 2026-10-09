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
}

const CLASSES =
  "text-accent underline underline-offset-4 transition-colors duration-(--duration-fast) ease-standard hover:text-accent-strong";

export function TextLink({ href, external = false, children, className }: TextLinkProps) {
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
    <Link href={href} className={cx(CLASSES, className)}>
      {children}
    </Link>
  );
}
