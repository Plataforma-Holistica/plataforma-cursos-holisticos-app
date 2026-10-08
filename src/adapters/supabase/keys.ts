import "server-only";

import { IdentityUnavailableError } from "./errors";

// Las claves públicas con las que se verifica el token de una sesión.
//
// El adaptador lleva su propia caché, en vez de dejar que el SDK las pida. El SDK no
// recuerda las claves que no existen: un token con un identificador de clave inventado le
// cuesta una petición al servidor de identidad cada vez, y otra más para preguntarle por
// el token. Aquí una clave desconocida sale a la red, como mucho, una vez por minuto.

/** Una clave pública, como la publica el servidor de identidad. */
export interface Jwk {
  kid?: string;
  alg?: string;
  kty?: string;
  [name: string]: unknown;
}

// Cada cuánto se vuelven a pedir aunque la clave se conozca: así sale una clave retirada.
const REFRESH_KNOWN_MS = 10 * 60_000;
// Cada cuánto se vuelven a pedir por una clave desconocida: así entra una recién rotada,
// sin que cada token inventado cueste una petición.
const REFRESH_UNKNOWN_MS = 60_000;

export interface KeyCache {
  /**
   * La clave con ese identificador, o `null` si el proyecto no la tiene. Lanza
   * `IdentityUnavailableError` si no se pudo saber.
   */
  find(kid: string): Promise<Jwk | null>;
}

export function createKeyCache(options: {
  fetchKeys: () => Promise<Jwk[]>;
  now?: () => number;
}): KeyCache {
  const now = options.now ?? Date.now;
  let keys: Jwk[] = [];
  let fetchedAt: number | undefined;
  let pending: Promise<void> | undefined;

  // Muchas peticiones a la vez comparten una sola salida a la red.
  function refresh(): Promise<void> {
    pending ??= options
      .fetchKeys()
      .then((fresh) => {
        keys = fresh.filter((key) => typeof key?.kid === "string" && key.kid !== "");
        fetchedAt = now();
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  return {
    async find(kid) {
      const lookup = () => keys.find((key) => key.kid === kid) ?? null;
      const known = lookup();
      const age = fetchedAt === undefined ? Number.POSITIVE_INFINITY : now() - fetchedAt;

      if (known && age < REFRESH_KNOWN_MS) return known;
      if (!known && age < REFRESH_UNKNOWN_MS) return null;

      try {
        await refresh();
      } catch {
        // Con una clave que ya se conocía se sigue adelante: una caída del servidor de
        // identidad no saca a nadie de su sesión. Sin ella, no se sabe.
        if (known) return known;
        throw new IdentityUnavailableError();
      }
      return lookup();
    },
  };
}
