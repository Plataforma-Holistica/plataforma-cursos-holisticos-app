import type { ReactNode } from "react";

import type { VerifiedClaims } from "@/services/account/account";

import { CoursesSection } from "../_cursos/list";
import { NewCourseSection } from "../_cursos/new";
import { DeleteCourseSection } from "../_cursos/remove";
import { EditorSection } from "../_editor/section";
import { TaxDataSection } from "../_fiscal/section";

// Las pantallas del portal del maestro (T-402). Ninguna tiene su propia página: todas las sirve el
// comodín (`[...resto]/page.tsx`), después de correr la guarda, por lo mismo que en administración: con
// una página propia, a quien no es maestro el «no existe» le llegaría distinto que el de una ruta que no
// existe. Una pantalla nueva entra aquí, con la forma exacta de cada segmento, y vive en una carpeta
// privada. El inicio (`/portal`, T-401) es otra página.

export interface PortalContext {
  claims: VerifiedClaims;
  /** El maestro suspendido ve el portal en solo lectura (RF-702). */
  readOnly: boolean;
  /** La consulta de la dirección, tal como llegó: cada pantalla valida lo suyo. */
  search: Readonly<Record<string, string | string[] | undefined>>;
}

export interface PortalScreen {
  /** Qué tipo de pantalla pide a la guarda. Sin decirlo, de trabajo. */
  kind?: "invitation" | "notice";
  render: (context: PortalContext) => ReactNode;
}

/** Un identificador de la base en la dirección: solo minúsculas, para que dos iguales se escriban igual. */
const ID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** La pantalla que atiende lo que sigue a `/portal/`, o nulo si ahí no hay ninguna. */
export function screenAt(rest: readonly string[]): PortalScreen | null {
  const [section, id, page, ...more] = rest;
  // Las dos las pinta el comodín con lo que dijo la guarda: aquí solo se dice qué tipo de pantalla son.
  if (section === "invitacion" && id === undefined) return { kind: "invitation", render: () => null };
  if (section === "aviso" && id === undefined) return { kind: "notice", render: () => null };
  if (section === "datos-fiscales") {
    return id === undefined ? { render: ({ claims, readOnly, search }) => <TaxDataSection claims={claims} readOnly={readOnly} search={search} /> } : null;
  }
  if (section !== "cursos" || more.length > 0) return null;
  if (id === undefined) return { render: ({ claims, readOnly }) => <CoursesSection claims={claims} readOnly={readOnly} /> };
  if (id === "nuevo") return page === undefined ? { render: ({ readOnly }) => <NewCourseSection readOnly={readOnly} /> } : null;
  if (!ID_SEGMENT.test(id)) return null;
  if (page === undefined) return { render: ({ claims, readOnly, search }) => <EditorSection claims={claims} course={id} readOnly={readOnly} search={search} /> };
  if (page === "borrar") return { render: ({ claims, readOnly }) => <DeleteCourseSection claims={claims} course={id} readOnly={readOnly} /> };
  return null;
}
