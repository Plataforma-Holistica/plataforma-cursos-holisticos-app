// Las reglas de una versión nueva de un texto legal, para la pantalla (PA-89), que las revisa antes
// de llamar al servicio. Son las mismas funciones puras del dominio que usa el servicio: así las dos
// revisiones no se pueden desfasar.
//
// Este archivo viaja al navegador: no importa la base, ni la configuración, ni nada que sea solo del
// servidor. La revisión que manda es la de la base.

export {
  LEGAL_BODY_MAX_LENGTH,
  LEGAL_DAYS_AHEAD_MAX,
  LEGAL_TITLE_MAX_LENGTH,
  parseLegalBody,
  parseLegalDay,
  parseLegalTitle,
} from "@/domain/legal/version";
