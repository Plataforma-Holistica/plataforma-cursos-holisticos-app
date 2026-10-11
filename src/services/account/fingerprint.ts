import "server-only";

import { createHmac } from "node:crypto";

import { getEnv } from "@/config/env";

// Las huellas con secreto del freno y de los topes (TRD §9.9, esquema §5.9).
//
// La base no guarda el correo ni la dirección de quien pide: guarda su huella, un
// HMAC-SHA256 con `RATE_LIMIT_HMAC_SECRET`. Así se frena igual un correo que no tiene
// cuenta, y las tablas no sirven para saber quién intentó entrar.
//
// Cada uso lleva su prefijo dentro de lo que se resume: el mismo texto como cuenta, como
// buzón o como dirección da tres huellas que no tienen nada que ver.

export type FingerprintUse = "account" | "ip" | "mailbox";

export interface Fingerprint {
  /** Los 32 bytes, como los guarda `private.login_throttles`. */
  readonly bytes: Uint8Array;
  /** Los mismos, en hexadecimal: lo que va en el nombre de un cubo. */
  readonly hex: string;
  /**
   * La clave del candado consultivo de esta huella: sus primeros ocho bytes como entero de
   * 64 bits con signo, que es lo que recibe Postgres. Dos huellas distintas pueden dar la
   * misma clave; lo único que pasa entonces es que una espera a la otra.
   */
  readonly lockKey: bigint;
}

export function fingerprint(use: FingerprintUse, value: string): Fingerprint {
  const digest = createHmac("sha256", getEnv().RATE_LIMIT_HMAC_SECRET).update(`${use}|${value}`).digest();
  return { bytes: digest, hex: digest.toString("hex"), lockKey: digest.readBigInt64BE(0) };
}

const bucket = (prefix: string) => (print: Fingerprint) => `${prefix}${print.hex}`;

/** Los nombres de los cubos de `private.rate_limit_counters`. Uno por uso. */
export const buckets = {
  /** Entradas fallidas de la hora, por dirección. */
  signInIp: bucket("signin:ip:"),
  /** Entradas fallidas de la hora, por cuenta. */
  signInAccount: bucket("signin:account:"),
  /** Registros pedidos en la hora, por dirección. */
  signUpIp: bucket("signup:ip:"),
  /** Recuperaciones pedidas en la hora, por dirección. */
  recoverIp: bucket("recover:ip:"),
  /** Correos de registro de la hora, por buzón. */
  signUpMail: bucket("mail:signup:"),
  /** Cuándo salió el último correo de registro a un buzón: una sola fila, con esa hora. */
  signUpMailLast: bucket("mail:signup:last:"),
  /** Correos de recuperación de la hora, por correo exacto. */
  recoverMail: bucket("mail:recover:"),
  /** Cuándo salió el último correo de recuperación a un correo: una sola fila, con esa hora. */
  recoverMailLast: bucket("mail:recover:last:"),
  /** La marca de que el enlace de verificación de una cuenta ya se canjeó. Lleva su identificador, no una huella. */
  signUpRedeemed: (profileId: string) => `signup:redeemed:${profileId}`,
} as const;
