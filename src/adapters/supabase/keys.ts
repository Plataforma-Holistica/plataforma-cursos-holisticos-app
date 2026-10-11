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

export type KeyLookup =
  | { kind: "found"; key: Jwk }
  /** Se acaba de preguntar y el proyecto no tiene esa clave. */
  | { kind: "absent" }
  /**
   * No está entre las conocidas, y no se volvió a preguntar porque se preguntó hace menos
   * de un minuto. Puede ser un identificador inventado o una clave recién rotada: no se
   * sabe.
   */
  | { kind: "unchecked" };

export interface KeyCache {
  /**
   * La clave con ese identificador, o `null` si no está entre las conocidas. Lanza
   * `IdentityUnavailableError` si no se pudo saber.
   */
  find(kid: string): Promise<Jwk | null>;
  /** Como `find`, distinguiendo «no existe» de «no se ha vuelto a preguntar». */
  lookup(kid: string): Promise<KeyLookup>;
  /**
   * Deja las claves a la mano. Lanza `IdentityUnavailableError` si nunca se han podido
   * bajar: sirve para saberlo antes de gastar algo que no se recupera.
   */
  ready(): Promise<void>;
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

  async function find(kid: string): Promise<Jwk | null> {
    const lookup = () => keys.find((key) => key.kid === kid) ?? null;
    const known = lookup();
    const age = fetchedAt === undefined ? Number.POSITIVE_INFINITY : now() - fetchedAt;

    if (known && age < REFRESH_KNOWN_MS) return known;
    if (known) {
      // Con una clave que ya se conocía no se espera: se contesta con ella y se refresca
      // detrás. Un servidor de identidad lento o caído no detiene cada petición, ni saca
      // a nadie de su sesión. Una clave retirada sale en cuanto el refresco contesta.
      void refresh().catch(() => undefined);
      return known;
    }
    if (age < REFRESH_UNKNOWN_MS) return null;

    try {
      await refresh();
    } catch {
      throw new IdentityUnavailableError();
    }
    return lookup();
  }

  return {
    find,
    async lookup(kid) {
      const before = fetchedAt;
      const key = await find(kid);
      if (key) return { kind: "found", key };
      // Solo es «no existe» si esta búsqueda, u otra a la vez, acaba de preguntar.
      return fetchedAt !== before ? { kind: "absent" } : { kind: "unchecked" };
    },
    async ready() {
      if (fetchedAt !== undefined) return;
      try {
        await refresh();
      } catch {
        throw new IdentityUnavailableError();
      }
    },
  };
}
