import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

// Si firmar falla con una llave que se leyó bien, la firma contesta nulo y no lanza: quien
// pregunta lo reporta como «no sirve». Aparte de sign.test.ts porque aquí se simula la falla.

vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  sign: () => {
    throw new Error("falla simulada");
  },
}));

const { signPlayback } = await import("./sign");

describe("signPlayback, cuando firmar falla", () => {
  it("contesta nulo, sin lanzar", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(signPlayback({ playbackId: "x", expiresAt: 1, key: { id: "k", privateKey: pem } })).toBeNull();
  });
});
