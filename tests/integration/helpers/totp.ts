import { createHmac } from "node:crypto";

// Los códigos de una aplicación de códigos (TOTP, RFC 6238), calculados aquí: SHA-1, seis
// dígitos y pasos de 30 segundos, que es lo que usa Supabase Auth. Con esto las pruebas
// tienen un segundo factor de verdad, sin una dependencia nueva.
//
// No carga código de la aplicación: lo usan también las pruebas de extremo a extremo.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

function fromBase32(secret: string): Buffer {
  let bits = "";
  for (const letter of secret.replace(/=+$/, "").toUpperCase()) {
    const value = ALPHABET.indexOf(letter);
    if (value < 0) throw new Error("El secreto del factor no está en base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let at = 0; at + 8 <= bits.length; at += 8) bytes.push(Number.parseInt(bits.slice(at, at + 8), 2));
  return Buffer.from(bytes);
}

/** El código que la aplicación de códigos mostraría en ese instante para ese secreto. */
export function totpCode(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / STEP_MS)));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const number = mac.readUInt32BE(offset) & 0x7fff_ffff;
  return String(number % 1_000_000).padStart(6, "0");
}

/**
 * Un código que no vale ahora para ese secreto. Auth acepta el del paso anterior y el del
 * siguiente: se evitan los tres.
 */
export function wrongCode(secret: string, at: number = Date.now()): string {
  const valid = new Set([totpCode(secret, at - STEP_MS), totpCode(secret, at), totpCode(secret, at + STEP_MS)]);
  for (let candidate = 0; ; candidate += 1) {
    const code = String(candidate).padStart(6, "0");
    if (!valid.has(code)) return code;
  }
}
