import { createHmac, timingSafeEqual } from "node:crypto";

// La firma de un aviso de Stripe (T-303; RF-208). `Stripe-Signature` trae `t=<segundos>` y una o más `v1=<hex>`: el HMAC-SHA256 de `<t>.<cuerpo crudo>` con el secreto
// `whsec_` del punto de conexión. Al rotar el secreto llegan dos `v1`, y basta con que una coincida; `v0` y lo que no se conoce se ignoran. La marca de tiempo vale
// 5 minutos hacia los dos lados: más vieja es un reenvío de alguien que guardó la petición. Se compara en tiempo constante, y sobre los bytes tal como llegaron.

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck = "valid" | "invalid" | "stale";

export function checkStripeSignature(header: string | null, body: Uint8Array, secret: string, now: Date): SignatureCheck {
  if (header === null || header.length > 2_048) return "invalid";
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^[0-9]{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(Buffer.from(value, "hex"));
  }
  if (timestamp === null || signatures.length === 0) return "invalid";
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
  if (!signatures.some((signature) => signature.length === expected.length && timingSafeEqual(signature, expected))) return "invalid";
  return Math.abs(now.getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS ? "stale" : "valid";
}
