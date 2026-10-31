import type { ReactNode } from "react";

import type { VerifiedClaims } from "@/services/account/account";
import type { Capability } from "@/services/account/team";

import { AlertsSection } from "../_alertas/section";
import { TeamSection } from "../_equipo/section";
import { TeacherSection, TeachersSection } from "../_maestros/section";
import { CloseSection, PayoutsSection, PeriodSection, PeriodsSection } from "../_periodos/section";
import { CatalogSection } from "../_practicas/section";
import { ReviewSection } from "../_revision/section";
import { LegalSection, LegalVersionSection } from "../_textos/section";

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
// privada (`_nombre/`), sin `page.tsx`. Una prueba de arquitectura exige las dos cosas. Lo que
// cuelga de una sección (el panel de un periodo y su cierre) entra a `DEEPER`, con la forma exacta
// de cada segmento y la misma capacidad que la sección.

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
  // PA-65, los maestros (T-401). La ficha de uno, abajo.
  maestros: { capability: "content", render: (claims) => <TeachersSection claims={claims} /> },
  // PA-61 y PA-62 mínimas, los cursos por revisar: verlos, reproducirlos y aprobarlos.
  revision: { capability: "content", render: (claims) => <ReviewSection claims={claims} /> },
  // PA-68 mínima, las alertas de anomalía: revisarlas, decidir fraude, excluir y revertir.
  alertas: { capability: "finance", render: (claims) => <AlertsSection claims={claims} /> },
  // PA-78, los periodos (T-605). El panel de uno y su cierre, abajo.
  periodos: { capability: "finance", render: (claims) => <PeriodsSection claims={claims} /> },
  // PA-89, los textos legales (T-110). El texto de una versión, abajo.
  "textos-legales": { capability: "config", render: (claims) => <LegalSection claims={claims} /> },
};

/** Un identificador de la base en la dirección: solo minúsculas, para que dos iguales se escriban igual. */
const ID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Un periodo en la dirección: `AAAA-MM`, de 2000 a 2999, mes de 01 a 12. Lo demás no es un periodo. */
const PERIOD_SEGMENT = /^(2\d{3})-(0[1-9]|1[0-2])$/;

/** El periodo de un segmento de la dirección (`2027-10` es 202710), o nulo si no tiene forma. */
export function periodAt(segment: string | undefined): number | null {
  const match = PERIOD_SEGMENT.exec(segment ?? "");
  return match ? Number(match[1]) * 100 + Number(match[2]) : null;
}

/**
 * Lo que cuelga de una sección, por la ruta que sigue a su nombre: PA-79 (`/admin/periodos/2027-10`),
 * PA-80 (`/admin/periodos/2027-10/cierre`) y PA-81 (`/admin/periodos/2027-10/liquidaciones`). Si el periodo existe lo dice su sección, después de
 * la guarda: aquí solo la forma.
 */
const DEEPER: Record<string, (deeper: readonly string[]) => AdminSection | null> = {
  // PA-66, la ficha de un maestro.
  maestros: (deeper) => {
    const [segment, ...more] = deeper;
    if (segment === undefined || !ID_SEGMENT.test(segment) || more.length > 0) return null;
    return { capability: "content", render: (claims) => <TeacherSection claims={claims} id={segment} /> };
  },
  periodos: (deeper) => {
    const [segment, page, ...more] = deeper;
    const period = periodAt(segment);
    if (period === null || more.length > 0) return null;
    if (page === undefined) return { capability: "finance", render: (claims) => <PeriodSection claims={claims} period={period} /> };
    if (page === "cierre") return { capability: "finance", render: (claims) => <CloseSection claims={claims} period={period} /> };
    if (page === "liquidaciones") return { capability: "finance", render: (claims) => <PayoutsSection claims={claims} period={period} /> };
    return null;
  },
  // El texto de una versión de PA-89 (`/admin/textos-legales/<identificador>`).
  "textos-legales": (deeper) => {
    const [id, ...more] = deeper;
    if (id === undefined || !ID_SEGMENT.test(id) || more.length > 0) return null;
    return { capability: "config", render: (claims) => <LegalVersionSection claims={claims} id={id} /> };
  },
};

/**
 * La sección que atiende lo que sigue a `/admin/`, o nulo si ahí no hay ninguna. Solo la
 * ruta exacta: lo que cuelgue de una sección sin estar aquí no existe.
 */
export function sectionAt(rest: readonly string[]): AdminSection | null {
  const [name, ...deeper] = rest;
  // Solo las propias de la tabla: «constructor» no es una sección.
  if (name === undefined || !Object.hasOwn(SECTIONS, name)) return null;
  if (deeper.length === 0) return SECTIONS[name] ?? null;
  return Object.hasOwn(DEEPER, name) ? (DEEPER[name]?.(deeper) ?? null) : null;
}
