import { ToolMain, type ToolMainProps } from "@/app/_lib/tool-main";
import { account } from "@/messages/es/account";
import type { Capability } from "@/services/account/team";

// El armazón de una pantalla de administración (T-616, solicitud 6): su `<main>`, la cabecera y el cuerpo, con un
// solo ancho de contenido (`max-w-admin`) y los mismos márgenes en todas las secciones. Antes cada pantalla ponía
// los suyos, y unas iban centradas y angostas y otras pegadas a la izquierda hasta el borde.
//
// La cabecera es la de una herramienta: compacta, con la filigrana de la flor de la vida y el resplandor detrás (sin
// foto), el grupo del menú como antetítulo y el título en `text-h1`, no en el tamaño de las cabeceras del alumno
// (`PageHeader`, `text-display-l`): aquí se viene a trabajar. El antetítulo va en oro pleno, como en `PageHeader`: el
// apagado no llega a 4.5 sobre el resplandor.
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

// Desde la solicitud 5 el armazón mismo vive en `src/app/_lib/tool-main.tsx` (`ToolMain`), que comparte con el portal
// del maestro: aquí queda solo lo propio de administración, la capacidad de la sección como antetítulo.

export interface AdminMainProps extends Omit<ToolMainProps, "eyebrow" | "titleId" | "titleFocusable"> {
  /** La capacidad de la sección: su nombre va de antetítulo, como el grupo del menú (Contenido, Finanzas, Configuración). */
  area?: Capability;
}

export function AdminMain({ area, ...rest }: AdminMainProps) {
  return <ToolMain eyebrow={area !== undefined ? account.admin.capabilities[area] : undefined} {...rest} />;
}
