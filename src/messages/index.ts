import "server-only";

import { meta } from "./es/meta";
import { states } from "./es/states";
import { terms } from "./es/terms";
import { ui } from "./es/ui";

// El catálogo de textos visibles (RNF-15). Ningún texto de la interfaz se escribe fuera de
// esta carpeta: lo hace cumplir el lint.
//
// Esta es la entrada para el servidor, con el catálogo entero. Un componente base importa
// solo su bloque (`@/messages/es/ui`), para que el catálogo no viaje al navegador.
//
// Convenciones:
//   - Un archivo por bloque en `es/`. Cada tarea agrega el suyo o amplía uno.
//   - Claves en inglés y en camelCase, como el resto de los identificadores.
//   - Las palabras que pueden cambiar por marca viven en `es/terms.ts` y se citan con un
//     marcador. Ver `format.ts`.
export const messages = { terms, ui, states, meta } as const;

export { plural, t } from "./format";
