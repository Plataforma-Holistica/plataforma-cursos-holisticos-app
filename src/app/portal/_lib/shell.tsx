import { ToolMain, type ToolMainProps } from "@/app/_lib/tool-main";
import { portal } from "@/messages/es/portal";

// El armazón de una pantalla del portal del maestro (T-616, solicitud 5): el mismo de administración (`ToolMain`,
// `src/app/_lib/tool-main.tsx`), con su `<main>`, la cabecera con la filigrana y el cuerpo en el ancho único. Toda
// pantalla del portal lo pinta dentro de `PortalFrame`, que ya no trae el `<main>`: una pantalla nueva no pone el
// suyo ni su `max-w-*`.
//
// El antetítulo dice dónde se está: en las pantallas del menú, «Portal» (`section`); en las que cuelgan de una,
// nada, porque arriba llevan su «Volver a…» (`above`), o lo suyo (`eyebrow`, como «Avance de alumnos»).
//
// No importa nada del servidor: lo pintan también las pantallas de cliente (el editor, crear, borrar, enviar).

export interface PortalMainProps extends ToolMainProps {
  /** Una pantalla del menú: lleva «Portal» de antetítulo. */
  section?: boolean;
}

export function PortalMain({ section = false, eyebrow, ...rest }: PortalMainProps) {
  return <ToolMain eyebrow={eyebrow ?? (section ? portal.nav.label : undefined)} {...rest} />;
}
