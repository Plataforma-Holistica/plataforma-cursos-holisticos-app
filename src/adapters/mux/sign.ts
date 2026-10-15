import "server-only";

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

// Firmar una dirección de reproducción de Mux (TRD §7.2 y §9.4): un JWT RS256 con el
// identificador de reproducción (`sub`), qué se ve (`aud`: video, miniatura o vista de
// avance), cuándo caduca (`exp`) y con qué llave (`kid`). Sin dependencias: `node:crypto`.
//
// Lo llama solo la función única de medios (`src/services/media/`): una prueba de
// arquitectura lo exige. La llave privada no sale de aquí, ni a un registro ni a un error.

/** Lo que se firma: el video, su miniatura y su vista de avance (TRD §6.1). */
export const PLAYBACK_AUDIENCES = { video: "v", thumbnail: "t", storyboard: "s" } as const;
export type PlaybackAudience = keyof typeof PLAYBACK_AUDIENCES;

export interface SigningKey {
  id: string;
  /** El PEM de la llave privada, o el mismo PEM en base64, como lo entrega Mux. */
  privateKey: string;
}

export type PlaybackTokens = Record<PlaybackAudience, string>;

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** Las llaves de firma de Mux son RSA de 2048 bits; una más corta no se acepta. */
const MIN_MODULUS_BITS = 2048;

/**
 * La llave privada lista para firmar, o nulo si lo que llegó no es una llave privada RSA de
 * al menos 2048 bits. Nunca lanza con el texto de la llave adentro.
 */
export function privateKeyOf(raw: string): KeyObject | null {
  const pem = raw.includes("-----BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8");
  try {
    const key = createPrivateKey(pem);
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    return key.asymmetricKeyType === "rsa" && bits >= MIN_MODULUS_BITS ? key : null;
  } catch {
    return null;
  }
}

/**
 * Las tres direcciones firmadas de un video, que caducan en `expiresAt` (segundos desde la
 * época). Nulo si la llave no sirve: quien pregunta lo trata como «no se supo».
 */
export function signPlayback(input: { playbackId: string; expiresAt: number; key: SigningKey }): PlaybackTokens | null {
  const key = privateKeyOf(input.key.privateKey);
  if (key === null) return null;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: input.key.id }));
  const tokenFor = (aud: string) => {
    const payload = base64url(JSON.stringify({ sub: input.playbackId, aud, exp: input.expiresAt }));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
    return `${header}.${payload}.${base64url(signature)}`;
  };
  // Si firmar falla con una llave que se leyó bien, es «no sirve», no una excepción: quien
  // pregunta lo reporta. El error no se relanza, porque podría nombrar la llave.
  try {
    return {
      video: tokenFor(PLAYBACK_AUDIENCES.video),
      thumbnail: tokenFor(PLAYBACK_AUDIENCES.thumbnail),
      storyboard: tokenFor(PLAYBACK_AUDIENCES.storyboard),
    };
  } catch {
    return null;
  }
}
