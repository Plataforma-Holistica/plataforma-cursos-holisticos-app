import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { checkStripeSignature, SIGNATURE_TOLERANCE_SECONDS } from "./signature";

const SECRET = "whsec_pruebaDeLaFirma0123456789";
const BODY = new TextEncoder().encode('{"id":"evt_1","type":"invoice.paid"}');
const NOW = new Date("2026-11-06T18:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);

const sign = (body: Uint8Array, secret: string, t: number) => createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex");

describe("la firma de un aviso de Stripe", () => {
  it("vale con la firma de su cuerpo y su hora", () => {
    expect(checkStripeSignature(`t=${T},v1=${sign(BODY, SECRET, T)}`, BODY, SECRET, NOW)).toBe("valid");
  });

  it("vale con cualquiera de dos v1 (al rotar el secreto) e ignora v0 y lo que no conoce", () => {
    const header = `t=${T},v1=${"0".repeat(64)},v0=${"1".repeat(64)},v2=x,v1=${sign(BODY, SECRET, T)}`;
    expect(checkStripeSignature(header, BODY, SECRET, NOW)).toBe("valid");
  });

  it.each([
    ["sin cabecera", null],
    ["vacía", ""],
    ["sin hora", `v1=${sign(BODY, SECRET, T)}`],
    ["sin v1", `t=${T},v0=${sign(BODY, SECRET, T)}`],
    ["con otro secreto", `t=${T},v1=${sign(BODY, "whsec_otro0123456789", T)}`],
    ["con otra hora en la firma", `t=${T},v1=${sign(BODY, SECRET, T + 1)}`],
    ["una v1 corta", `t=${T},v1=${sign(BODY, SECRET, T).slice(0, 63)}`],
    ["una v1 en mayúsculas", `t=${T},v1=${sign(BODY, SECRET, T).toUpperCase()}`],
    ["enorme", `t=${T},v1=${"a".repeat(3000)}`],
  ])("no vale %s", (_, header) => {
    expect(checkStripeSignature(header, BODY, SECRET, NOW)).toBe("invalid");
  });

  it("no vale con el cuerpo cambiado, aunque sea un espacio", () => {
    const changed = new TextEncoder().encode('{"id":"evt_1", "type":"invoice.paid"}');
    expect(checkStripeSignature(`t=${T},v1=${sign(BODY, SECRET, T)}`, changed, SECRET, NOW)).toBe("invalid");
  });

  it("se compara sobre los bytes: un carácter fuera de ASCII firmado como llegó vale", () => {
    const body = new TextEncoder().encode('{"name":"Ana Peña"}');
    expect(checkStripeSignature(`t=${T},v1=${sign(body, SECRET, T)}`, body, SECRET, NOW)).toBe("valid");
  });

  it("la hora vale cinco minutos hacia los dos lados", () => {
    for (const t of [T - SIGNATURE_TOLERANCE_SECONDS, T + SIGNATURE_TOLERANCE_SECONDS]) {
      expect(checkStripeSignature(`t=${t},v1=${sign(BODY, SECRET, t)}`, BODY, SECRET, NOW)).toBe("valid");
    }
    for (const t of [T - SIGNATURE_TOLERANCE_SECONDS - 1, T + SIGNATURE_TOLERANCE_SECONDS + 1]) {
      expect(checkStripeSignature(`t=${t},v1=${sign(BODY, SECRET, t)}`, BODY, SECRET, NOW)).toBe("stale");
    }
  });
});
