import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { privateKeyOf, signPlayback } from "./sign";

// La firma de una dirección de Mux, contra una llave generada aquí: la cabecera, los claims
// exactos y que la firma se verifica con la llave pública.

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const KEY = { id: "LlaveDePrueba01", privateKey: Buffer.from(PEM).toString("base64") };

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

describe("signPlayback", () => {
  const tokens = signPlayback({ playbackId: "PlaybackDePrueba", expiresAt: 1_900_000_000, key: KEY });

  it("firma el video, la miniatura y la vista de avance", () => {
    expect(tokens).not.toBeNull();
    expect(Object.keys(tokens ?? {}).sort()).toEqual(["storyboard", "thumbnail", "video"]);
  });

  it.each([
    ["video", "v"],
    ["thumbnail", "t"],
    ["storyboard", "s"],
  ] as const)("%s: RS256, con la llave y los claims exactos, y verificable", (which, aud) => {
    const token = tokens?.[which] ?? "";
    // Tres partes en base64url, sin relleno: es lo que lee Mux.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [header = "", payload = "", signature = ""] = token.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT", kid: "LlaveDePrueba01" });
    // Ni un claim de más: lo que viaja al navegador es solo esto.
    expect(decode(payload)).toEqual({ sub: "PlaybackDePrueba", aud, exp: 1_900_000_000 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("acepta la llave en PEM o en base64, como la entrega Mux", () => {
    expect(signPlayback({ playbackId: "x", expiresAt: 1, key: { id: "k", privateKey: PEM } })).not.toBeNull();
  });

  it.each([
    ["un texto cualquiera", "no-es-una-llave"],
    ["una llave pública", publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["vacía", ""],
    ["una llave RSA de 1024 bits", generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString()],
    ["una llave RSA-PSS", generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()],
    ["una llave de curva elíptica", generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()],
  ])("con %s no firma, y no lanza", (_what, raw) => {
    expect(privateKeyOf(raw)).toBeNull();
    expect(signPlayback({ playbackId: "x", expiresAt: 1, key: { id: "k", privateKey: raw } })).toBeNull();
  });
});
