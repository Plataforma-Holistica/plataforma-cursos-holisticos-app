import "server-only";

import { getEnv } from "@/config/env";

// El adaptador de Storage para los recursos de un curso (T-404). Habla con la API de Storage con la llave
// secreta, que salta las políticas (`storage.objects` no tiene ninguna): por eso no sale de aquí, y solo lo
// llama `src/services/media/resource-files.ts`.
//
//   · La dirección de subida se firma SIN `upsert`: un segundo envío con la misma dirección no reemplaza el
//     objeto, y lo que se leyó al confirmar sigue siendo lo que se sirve. Lo manda la firma, no el navegador.
//   · Dura lo que Storage diga (2 h fijas); no se puede pedir menos, y la base lo cuenta (un pendiente vive 3 h).
//   · Leer es por rango: nunca se bajan los 50 MB para mirar el principio de un archivo.
//   · La dirección de descarga caduca, y lleva el nombre con que baja como adjunto (`download=`), que arma el servidor.
//
// Nada de lo que contesta Storage sale de aquí en un error: puede traer la ruta.

const BUCKET = "course-resources";
const TIMEOUT_MS = 10_000;

export interface ResourceStorage {
  /** La dirección para subir a esa ruta, o nulo si no se pudo firmar. */
  signUpload: (path: string) => Promise<string | null>;
  /** La dirección para bajar esa ruta como adjunto con ese nombre, que vive `seconds`, o nulo si no se pudo firmar. */
  signDownload: (path: string, name: string, seconds: number) => Promise<string | null>;
  /** Los primeros `bytes`, o nulo si no se pudieron leer (no está, o Storage falló). */
  readStart: (path: string, bytes: number) => Promise<Uint8Array | null>;
  /** Los últimos `bytes`, o nulo si no se pudieron leer. */
  readEnd: (path: string, bytes: number) => Promise<Uint8Array | null>;
  /** Borra esos objetos. Que no estén no es una falla. Lanza si Storage no contestó bien. */
  remove: (paths: readonly string[]) => Promise<void>;
}

type Fetch = typeof fetch;

// Los videos del borrador (T-403). La misma llave, con lo que cambia un archivo de hasta 5 GB:
//
//   · Sube por TUS, del navegador a `/upload/resumable/sign`, con el token de la firma en `x-signature` y sin ninguna llave (medido
//     contra el Storage local). La firma es sin `upsert`: lo confirmado no se reemplaza (409). Dura 2 h y se valida en cada petición,
//     así que una subida larga pide otra.
//   · Se lee por rangos, y cada lectura dice cuánto mide el archivo.

const VIDEO_BUCKET = "video-originals";
const CONTENT_RANGE_TOTAL = /^bytes [0-9]+-[0-9]+\/([0-9]+)$/;

export interface VideoStorage {
  /** A dónde subir y con qué firma, o nulo si no se pudo firmar. */
  signUpload: (path: string) => Promise<{ endpoint: string; token: string } | null>;
  /** Esos bytes y cuánto mide el archivo, o nulo si no se pudieron leer (no está, o Storage falló). */
  readRange: (path: string, start: number, length: number) => Promise<{ bytes: Uint8Array; total: number } | null>;
  /** Borra esos objetos. Que no estén no es una falla. Lanza si Storage no contestó bien. */
  remove: (paths: readonly string[]) => Promise<void>;
  /** La dirección para bajar esa ruta, que vive `seconds`, o nulo si no se pudo firmar. */
  signRead: (path: string, seconds: number) => Promise<string | null>;
}

export function createVideoStorage(base: Fetch = fetch): VideoStorage {
  const root = () => `${getEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "")}/storage/v1`;
  const authorized = (extra: Record<string, string> = {}) => {
    const key = getEnv().SUPABASE_SECRET_KEY;
    return { apikey: key, authorization: `Bearer ${key}`, ...extra };
  };
  const call = (url: string, init: RequestInit) => base(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return {
    signUpload: async (path) => {
      try {
        const response = await call(`${root()}/object/upload/sign/${VIDEO_BUCKET}/${path}`, {
          method: "POST",
          headers: authorized({ "content-type": "application/json" }),
          body: "{}",
        });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const url = typeof body === "object" && body !== null && "url" in body ? body.url : null;
        if (typeof url !== "string") return null;
        const token = new URL(url, "http://storage.invalid").searchParams.get("token");
        return token === null || token === "" ? null : { endpoint: `${root()}/upload/resumable/sign`, token };
      } catch {
        return null;
      }
    },
    readRange: async (path, start, length) => {
      try {
        const response = await call(`${root()}/object/${VIDEO_BUCKET}/${path}`, { method: "GET", headers: authorized({ range: `bytes=${start}-${start + length - 1}` }) });
        if (response.status === 200) {
          // Sin rango viene el archivo entero. Solo se lee si dice que cabe: no se bajan 5 GB a la memoria para mirar 16 bytes.
          const declared = Number(response.headers.get("content-length") ?? "NaN");
          if (start !== 0 || !Number.isSafeInteger(declared) || declared > length) {
            await response.body?.cancel();
            return null;
          }
          const whole = new Uint8Array(await response.arrayBuffer());
          return { bytes: whole, total: whole.length };
        }
        if (response.status !== 206) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const total = CONTENT_RANGE_TOTAL.exec(response.headers.get("content-range") ?? "")?.[1];
        return total === undefined ? null : { bytes, total: Number(total) };
      } catch {
        return null;
      }
    },
    remove: async (paths) => {
      if (paths.length === 0) return;
      const response = await call(`${root()}/object/${VIDEO_BUCKET}`, {
        method: "DELETE",
        headers: authorized({ "content-type": "application/json" }),
        body: JSON.stringify({ prefixes: paths }),
      });
      if (!response.ok) throw new Error(`storage remove: ${response.status}`);
    },
    signRead: async (path, seconds) => {
      try {
        const response = await call(`${root()}/object/sign/${VIDEO_BUCKET}/${path}`, {
          method: "POST",
          headers: authorized({ "content-type": "application/json" }),
          body: JSON.stringify({ expiresIn: seconds }),
        });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const url = typeof body === "object" && body !== null && "signedURL" in body ? body.signedURL : null;
        return typeof url === "string" && url.startsWith("/") && url.includes("?token=") ? `${root()}${url}` : null;
      } catch {
        return null;
      }
    },
  };
}

export function createResourceStorage(base: Fetch = fetch): ResourceStorage {
  const root = () => `${getEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "")}/storage/v1`;
  const authorized = (extra: Record<string, string> = {}) => {
    const key = getEnv().SUPABASE_SECRET_KEY;
    return { apikey: key, authorization: `Bearer ${key}`, ...extra };
  };
  const call = (url: string, init: RequestInit) => base(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  // Las rutas las pone la base, y son uuid separados por `/`: cada tramo se manda tal cual.
  const objectUrl = (path: string) => `${root()}/object/${BUCKET}/${path}`;

  async function readRange(path: string, range: string): Promise<Uint8Array | null> {
    try {
      const response = await call(objectUrl(path), { method: "GET", headers: authorized({ range }) });
      if (response.status !== 200 && response.status !== 206) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  return {
    signUpload: async (path) => {
      try {
        const response = await call(`${root()}/object/upload/sign/${BUCKET}/${path}`, {
          method: "POST",
          headers: authorized({ "content-type": "application/json" }),
          body: "{}",
        });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const url = typeof body === "object" && body !== null && "url" in body ? body.url : null;
        return typeof url === "string" && url.startsWith("/") ? `${root()}${url}` : null;
      } catch {
        return null;
      }
    },
    signDownload: async (path, name, seconds) => {
      try {
        const response = await call(`${root()}/object/sign/${BUCKET}/${path}`, {
          method: "POST",
          headers: authorized({ "content-type": "application/json" }),
          body: JSON.stringify({ expiresIn: seconds }),
        });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const url = typeof body === "object" && body !== null && "signedURL" in body ? body.signedURL : null;
        if (typeof url !== "string" || !url.startsWith("/") || !url.includes("?token=")) return null;
        return `${root()}${url}&download=${encodeURIComponent(name)}`;
      } catch {
        return null;
      }
    },
    readStart: (path, bytes) => readRange(path, `bytes=0-${bytes - 1}`),
    readEnd: (path, bytes) => readRange(path, `bytes=-${bytes}`),
    remove: async (paths) => {
      if (paths.length === 0) return;
      const response = await call(`${root()}/object/${BUCKET}`, {
        method: "DELETE",
        headers: authorized({ "content-type": "application/json" }),
        body: JSON.stringify({ prefixes: paths }),
      });
      if (!response.ok) throw new Error(`storage remove: ${response.status}`);
    },
  };
}
