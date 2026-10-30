// Las reglas de los textos del borrador, para la pantalla (PA-43), que las revisa antes de llamar al
// servicio. Es la misma función pura del dominio que usa el servicio: así las dos revisiones no se
// pueden desfasar.
//
// Este archivo viaja al navegador: no importa la base, ni la configuración, ni nada que sea solo
// del servidor. La revisión que manda es la de la base.

export { DRAFT_TEXT_LIMITS, parseDraftText, type DraftTextKind, type DraftTextResult } from "@/domain/catalog/draft-text";
export { missingItems, type DraftReadiness } from "@/domain/catalog/draft-readiness";
