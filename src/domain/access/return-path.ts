// A dónde se vuelve después de entrar: el parámetro `volver` (flujo de la app §6.4).
//
// «Solo se aceptan rutas de la propia Plataforma». Lo que se cuida es que nadie arme un
// enlace a la Plataforma que, tras entrar, termine en otro sitio. La regla va por lo que sí
// se permite, no por lo que se prohíbe: una lista de caracteres y una lista de destinos.
// Con una lista de prohibidos, cada forma nueva de escribir `//otro-sitio` sería un hueco
// (`/.//sitio`, `/x/..//sitio` y `/%2e//sitio` pasan por una ruta «que empieza con una sola
// barra», y el navegador las resuelve a otro sitio).
//
// Todo lo que lea `volver` pasa por aquí. La consulta puede traer cualquier cosa, también
// otra dirección: es inofensiva mientras nadie la use como destino sin pasar por esta función.

export const RETURN_PATH_MAX_LENGTH = 1024;

// Uno o más segmentos. Cada segmento: letras, dígitos, `_`, `~` y `-`, con puntos solo en
// medio. Así no existen los segmentos vacíos (`//`), ni `.`, ni `..`, ni el `%` con el que
// se escribiría cualquiera de ellos codificado, ni la barra invertida, ni los espacios y
// caracteres de control que el navegador quita antes de resolver.
const PATHNAME = /^(?:\/[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*)+$/;
// En la consulta sí se admite el `%`, siempre con sus dos cifras: ahí no cambia el destino.
const QUERY = /^(?:[A-Za-z0-9_.~=&+-]|%[0-9A-Fa-f]{2})*$/;

export type ReturnPath =
  | { kind: "path"; /** Ruta propia, con su consulta y sin fragmento. */ path: string }
  // El inicio del rol lo pone el servicio: aquí no se sabe quién entró.
  | { kind: "default"; reason: "absent" | "malformed" | "not_allowed" };

/**
 * @param allowedPrefixes Los destinos a los que se puede volver (`/cursos`, `/planes`…). Vale
 *   el destino exacto y lo que cuelga de él. Con la lista vacía no se acepta nada: una ruta
 *   nueva no es destino hasta que alguien la agrega.
 */
export function resolveReturnPath(input: string | null | undefined, allowedPrefixes: readonly string[]): ReturnPath {
  if (input === null || input === undefined || input === "") return { kind: "default", reason: "absent" };
  if (input.length > RETURN_PATH_MAX_LENGTH) return { kind: "default", reason: "malformed" };

  const hash = input.indexOf("#");
  const withoutFragment = hash === -1 ? input : input.slice(0, hash);
  const mark = withoutFragment.indexOf("?");
  const pathname = mark === -1 ? withoutFragment : withoutFragment.slice(0, mark);
  const query = mark === -1 ? "" : withoutFragment.slice(mark + 1);
  if (!PATHNAME.test(pathname) || !QUERY.test(query)) return { kind: "default", reason: "malformed" };

  const allowed = allowedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!allowed) return { kind: "default", reason: "not_allowed" };

  return { kind: "path", path: query === "" ? pathname : `${pathname}?${query}` };
}
