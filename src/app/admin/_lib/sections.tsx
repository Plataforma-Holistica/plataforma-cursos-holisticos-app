import type { ReactNode } from "react";

import type { VerifiedClaims } from "@/services/account/account";
import type { Capability } from "@/services/account/team";

import { TeamSection } from "../_equipo/section";
import { CatalogSection } from "../_practicas/section";

// Las secciones de administración que cuelgan de `/admin`. Ninguna tiene su propia página:
// todas las sirve el comodín (`[...resto]/page.tsx`), después de correr la guarda.
//
// Es así por lo que se midió el 2026-10-13 con la primera sección: con una página propia,
// a quien no es del equipo el documento de «no existe» le llegaba distinto que el de una
// ruta que de verdad no existe. Lo visible era igual, pero Next incrusta en el documento el
// árbol de rutas y la lista de fragmentos de la página: nombraba el segmento, y hasta el
// comodín listaba las rutas hermanas que sí existen. Servidas todas desde un mismo módulo,
// de una ruta a otra solo cambia la ruta que se pidió.
//
// Una sección nueva entra a esta tabla, con la capacidad que pide, y vive en una carpeta
// privada (`_nombre/`), sin `page.tsx`. Una prueba de arquitectura exige las dos cosas.

export interface AdminSection {
  /** La capacidad que esa sección pide. Toda sección pide una (PA-88). */
  capability: Capability;
  /** Lo que se pinta, ya con alguien del equipo que la tiene y con sus claims verificadas. */
  render: (claims: VerifiedClaims) => ReactNode;
}

const SECTIONS: Record<string, AdminSection> = {
  // PA-86, el equipo de administración.
  equipo: { capability: "config", render: (claims) => <TeamSection claims={claims} /> },
  // PA-67, las prácticas y los niveles del catálogo.
  practicas: { capability: "content", render: (claims) => <CatalogSection claims={claims} /> },
};

/**
 * La sección que atiende lo que sigue a `/admin/`, o nulo si ahí no hay ninguna. Solo la
 * ruta exacta: lo que cuelgue de una sección sin estar aquí no existe.
 */
export function sectionAt(rest: readonly string[]): AdminSection | null {
  const [name, ...deeper] = rest;
  // Solo las propias de la tabla: «constructor» no es una sección.
  if (name === undefined || deeper.length > 0 || !Object.hasOwn(SECTIONS, name)) return null;
  return SECTIONS[name] ?? null;
}
