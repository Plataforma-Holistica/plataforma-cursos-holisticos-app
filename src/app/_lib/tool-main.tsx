import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cx } from "@/ui/cx";
import { Filigree } from "@/ui/flower";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// El armazón de una pantalla de trabajo (T-616): el de administración (solicitud 6) y el del portal del maestro
// (solicitud 5) son este mismo, para que las dos herramientas hablen igual. Trae el `<main>`, la cabecera y el
// cuerpo, con un solo ancho de contenido (`max-w-admin`) y los mismos márgenes. Cada superficie lo envuelve con lo
// suyo: `AdminMain` (`src/app/admin/_lib/shell.tsx`) y `PortalMain` (`src/app/portal/_lib/shell.tsx`). Una pantalla
// no lo usa directo.
//
// La cabecera es la de una herramienta: compacta, con la filigrana de la flor de la vida y el resplandor detrás (sin
// foto), un antetítulo y el título en `text-h1`, no en el tamaño de las cabeceras del alumno (`PageHeader`,
// `text-display-l`): aquí se viene a trabajar. El antetítulo va en oro pleno, como en `PageHeader`: el apagado no
// llega a 4.5 sobre el resplandor.
//
// El cuerpo es una columna. `measure="reading"` la limita al ancho de lectura, a la izquierda: los formularios y
// los textos no se estiran. Una pantalla con tabla va entera (`full`) y limita por su cuenta lo que no sea tabla
// (`max-w-reading`).
//
// Las piezas, con las mismas clases en todas las secciones (no cajas con borde):
//   · una pieza sobre el fondo (un formulario, una ficha): `surface-raised p-4 sm:p-5`;
//   · una lista de renglones, en una sola pieza con filetes: `surface-raised divide-y divide-border` y, en cada
//     renglón, `p-4 sm:px-5`.
// Los títulos: el `<h1>` de la cabecera, los `<h2>` en `text-h3` y los `<h3>` en `text-body-l font-semibold`. La
// escala nueva de `text-h2` (28 px) queda grande para una herramienta densa.
//
// No importa nada del servidor: lo pinta también una pantalla de cliente (el editor de curso, con su barra dentro
// de sus proveedores).

const GUTTER = "mx-auto w-full max-w-admin px-4 sm:px-8";

export interface ToolMainProps extends Omit<ComponentPropsWithoutRef<"main">, "title" | "id" | "tabIndex" | "className"> {
  /** El `<h1>` de la pantalla. */
  title: ReactNode;
  /** El `id` del `<h1>`, si un bloque de la pantalla se nombra con él (`aria-labelledby`). */
  titleId?: string;
  /** El `<h1>` recibe el foco por código (`tabIndex={-1}`): cuando lo pulsado se va con la respuesta. */
  titleFocusable?: boolean;
  /** El antetítulo, ya en palabras. */
  eyebrow?: ReactNode;
  /** Lo que acompaña al título, en el segundo tono. */
  lead?: ReactNode;
  /** Lo que va arriba del título: «Volver a…». */
  above?: ReactNode;
  /** Lo que va junto al título: el estado. */
  badge?: ReactNode;
  /** Lo demás de la cabecera, bajo el título (los pasos de un periodo, los botones de un curso). */
  header?: ReactNode;
  measure?: "full" | "reading";
  children: ReactNode;
}

export function ToolMain({ title, titleId, titleFocusable = false, eyebrow, lead, above, badge, header, measure = "full", children, ...rest }: ToolMainProps) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none" {...rest}>
      <div data-tool-header className="relative isolate overflow-hidden">
        <Filigree className="absolute -top-28 -right-24 size-80 sm:-top-40 sm:-right-16 sm:size-112" />
        <span aria-hidden="true" className="absolute inset-0 glow-header" />
        <div className={cx(GUTTER, "relative flex flex-col gap-2 pt-8 pb-6 sm:pt-12 sm:pb-8")}>
          {above}
          {eyebrow !== undefined && <p className="animate-enter eyebrow text-accent">{eyebrow}</p>}
          {/* El estado va junto al título, no en la otra orilla: allá quedaba suelto sobre la filigrana. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 id={titleId} tabIndex={titleFocusable ? -1 : undefined} className={cx("text-h1 break-words text-text", titleFocusable && "outline-none")}>
              {title}
            </h1>
            {badge}
          </div>
          {lead !== undefined && <div className="flex max-w-reading animate-enter flex-col gap-1 text-text-2">{lead}</div>}
          {header}
        </div>
      </div>
      <div className={cx(GUTTER, "pt-6 pb-16 sm:pt-8")}>
        <div className={cx("flex flex-col gap-10", measure === "reading" && "max-w-reading")}>{children}</div>
      </div>
    </main>
  );
}
