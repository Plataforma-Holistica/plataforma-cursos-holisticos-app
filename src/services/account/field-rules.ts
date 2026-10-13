// Las reglas de los campos de la cuenta, para quien valida al salir del campo (diseño,
// sección 5.5). Son las mismas funciones puras del dominio que usa el servidor al enviar:
// así las dos validaciones no se pueden desfasar.
//
// Este archivo viaja al navegador: no importa la base, ni la configuración, ni nada que
// sea solo del servidor. Una prueba de arquitectura sigue sus importaciones y lo exige.
// Lo que valide el navegador es una cortesía; la validación que manda es la del servidor.

export { parseDisplayName, DISPLAY_NAME_MAX_LENGTH } from "@/domain/access/display-name";
export { parseEmail, EMAIL_MAX_LENGTH } from "@/domain/access/email";
export { checkPassword, checkPasswordChange, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "@/domain/access/password-policy";
export { parseSecondFactorCode, SECOND_FACTOR_CODE_LENGTH } from "@/domain/access/second-factor-code";
