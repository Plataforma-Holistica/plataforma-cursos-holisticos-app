// La regla del nombre de una práctica o un nivel, para la pantalla (PA-67), que la revisa
// antes de llamar al servicio. Es la misma función pura del dominio que usa el servicio: así
// las dos revisiones no se pueden desfasar.
//
// Este archivo viaja al navegador: no importa la base, ni la configuración, ni nada que sea
// solo del servidor. La revisión que manda es la de la base.

export { CATALOG_NAME_MAX_LENGTH, parseCatalogName } from "@/domain/catalog/name";
