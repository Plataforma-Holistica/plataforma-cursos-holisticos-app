import type { IconNode } from "lucide";
import type { ReactNode } from "react";

import { FocusHeading } from "./focus-heading";
import { Icon } from "./icon";

// Estado de pantalla completa (diseño, sección 5.7): lo que se muestra en lugar de la
// pantalla pedida. No encontrado, error, correo sin verificar, consentimientos por
// aceptar. La dirección no cambia.
//
// Centrado y de 480 px como máximo: icono, título, dos frases, una acción principal y
// hasta dos secundarias. Siempre hay una salida a ayuda.
//
// No pone el `<main>`: lo pone la pantalla, con su `id` para el enlace de salto.

export interface FullScreenStateProps {
  icon: IconNode;
  /** El `<h1>` de la pantalla. La pestaña del navegador debe decir lo mismo. */
  title: ReactNode;
  /** Dos frases como máximo. */
  children: ReactNode;
  /** Una sola. */
  primaryAction: ReactNode;
  /** Hasta dos. */
  secondaryActions?: ReactNode;
  /** La salida a ayuda. */
  help?: ReactNode;
  /** Un código corto para dictarlo a soporte. Nunca un mensaje técnico. */
  reference?: ReactNode;
}

export function FullScreenState({
  icon,
  title,
  children,
  primaryAction,
  secondaryActions,
  help,
  reference,
}: FullScreenStateProps) {
  return (
    <div className="mx-auto flex max-w-form flex-col items-start gap-6 px-4 py-16">
      <Icon icon={icon} size={24} className="text-text-2" />
      <div className="flex flex-col gap-3">
        <FocusHeading className="text-h1 outline-none">{title}</FocusHeading>
        <div className="flex flex-col gap-2 text-body-l text-text-2">{children}</div>
      </div>
      <div className="flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center">
        {primaryAction}
        {secondaryActions}
      </div>
      {/* El enlace de ayuda va solo, no dentro de una frase: se agranda hasta los 44 px. */}
      {help && <div className="text-body-s [&_a]:inline-block [&_a]:py-3">{help}</div>}
      {reference && <p className="text-caption text-text-3">{reference}</p>}
    </div>
  );
}
