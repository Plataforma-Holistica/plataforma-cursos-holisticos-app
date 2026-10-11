// Qué textos legales se pueden leer sin sesión y en qué dirección vive cada uno (RF-903;
// diseño PA-07). Es puro: lo usan el servicio que los lee y las pantallas que los enlazan.

/**
 * Los tipos de texto que cualquiera puede leer sin sesión. Son los mismos que deja la
 * política de la base (`legal_documents_public_select`), y una prueba de integración los
 * compara: un tipo que no esté aquí no llega a la base.
 */
export const PUBLIC_DOC_TYPES = [
  "terms",
  "student_privacy_notice",
  "community_policy",
  "refund_policy",
  "course_history_consent",
  "recurring_charge_consent",
] as const;

const publicTypes: ReadonlySet<string> = new Set(PUBLIC_DOC_TYPES);

export function isPublicDocType(docType: string): boolean {
  return publicTypes.has(docType);
}

/**
 * La dirección de cada texto que ya tiene página (`/legal/[documento]`). Los tres que una
 * cuenta tiene que aceptar la tienen, y una prueba lo exige: no se le pide a nadie aceptar
 * un texto que no puede leer. Los demás tipos públicos reciben la suya cuando existan sus
 * textos (T-606).
 */
export const LEGAL_SLUGS = {
  terminos: "terms",
  privacidad: "student_privacy_notice",
  "historial-de-cursos": "course_history_consent",
} as const;

const slugs = new Map<string, string>(Object.entries(LEGAL_SLUGS));

/** El tipo de texto de una dirección, o nulo si esa dirección no es de ningún texto. */
export function docTypeOfSlug(slug: string): string | null {
  return slugs.get(slug) ?? null;
}

/** La dirección de un tipo de texto, o nulo si todavía no tiene página. */
export function slugOfDocType(docType: string): string | null {
  for (const [slug, type] of slugs) if (type === docType) return slug;
  return null;
}
