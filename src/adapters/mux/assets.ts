import "server-only";

import { getEnv } from "@/config/env";

// Los videos en Mux: crear, leer, buscar y borrar (T-403, tercera solicitud; RF-604, FL-33). Con `fetch`, sin `@mux/mux-node`: son cuatro
// llamadas, y no se suma una dependencia para eso. Solo lo importa `src/services/media/video-provider.ts`.
//
//   · Mux descarga el archivo de una dirección firmada de Storage, de un solo `GET` sin rangos (medido el 2026-11-01 con 39 MB). Esa
//     dirección abre el original durante horas: no sale de aquí, ni a un registro ni a un error. Por eso de lo que Mux escribe en
//     un error solo se lee su tipo, y solo si tiene forma de tipo.
//   · Nada lanza. Quien llama decide qué hacer con «no se supo», que nunca se confunde con «no está»: buscar que no pudo terminar da nulo,
//     porque con «no está» se crearía otro y se pagaría dos veces.
//   · Crear distingue un rechazo de lo que no se sabe. Un 4xx dice que no lo creó. Un 5xx o un corte no dicen nada, y abortar no cancela allá: quien
//     llama espera antes de buscar, porque un asset recién creado puede tardar en aparecer en la lista.
//   · `GET /assets` no filtra por `passthrough`, trae los más nuevos primero (medido) y por eso buscar se detiene al pasar de cuando
//     nació la fila, con una hora de margen por los relojes. Va por cursor (medido): con páginas, borrar uno a media búsqueda se saltaría otro.
//     Un 404 es que ya no está; un id que no reconoce contesta 400 (medido), y eso no dice que se haya ido.

const ROOT = "https://api.mux.com/video/v1/assets";
const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
/** Buscar corre mientras la pantalla espera, y las demás acciones del editor esperan detrás. */
const SEARCH_BUDGET_MS = 20_000;
const CLOCK_MARGIN_SECONDS = 3600;
const ERROR_TYPE = /^[a-z_]{1,60}$/;

export type ProviderAssetState = "preparing" | "ready" | "errored";

export interface ProviderAsset {
  state: ProviderAssetState;
  /** La reproducción firmada. Una pública no cuenta, aunque exista. */
  playback: string | null;
  seconds: number | null;
  captions: boolean;
  error: string | null;
}

export interface VideoProvider {
  /** El id del asset creado, `rejected` si dijo que no, o nulo si no se supo: un corte no dice que no lo haya creado. */
  create: (input: { url: string; passthrough: string }) => Promise<string | "rejected" | null>;
  /** Lo que dice del asset, `gone` si ya no está, o nulo si no se supo. `declared` son los segundos que leyó el servidor: Mux no los usa. */
  read: (asset: string, declared?: number | null) => Promise<ProviderAsset | "gone" | null>;
  /** Los assets con ese `passthrough`, del más nuevo al más viejo, o nulo si no se pudo terminar de buscar. */
  findByPassthrough: (passthrough: string, since: number) => Promise<string[] | null>;
  /** Verdadero si ya no está. */
  remove: (asset: string) => Promise<boolean>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const dataOf = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json();
  return isRecord(body) ? body.data : undefined;
};

function assetOf(data: unknown): ProviderAsset | null {
  if (!isRecord(data) || (data.status !== "preparing" && data.status !== "ready" && data.status !== "errored")) return null;
  const playback = Array.isArray(data.playback_ids) ? data.playback_ids.find((each) => isRecord(each) && each.policy === "signed" && typeof each.id === "string") : undefined;
  const tracks: unknown[] = Array.isArray(data.tracks) ? data.tracks : [];
  const errorType = isRecord(data.errors) ? data.errors.type : undefined;
  return {
    state: data.status,
    playback: isRecord(playback) ? (playback.id as string) : null,
    seconds: typeof data.duration === "number" && data.duration > 0 ? Math.ceil(data.duration) : null,
    captions: tracks.some((track) => isRecord(track) && track.type === "text" && track.status === "ready"),
    error: data.status !== "errored" ? null : typeof errorType === "string" && ERROR_TYPE.test(errorType) ? errorType : "unknown",
  };
}

export function createMuxAssets(base: typeof fetch = fetch, now: () => number = Date.now): VideoProvider {
  const call = (url: string, init: RequestInit = {}) => {
    const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = getEnv();
    const authorization = `Basic ${Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString("base64")}`;
    return base(url, { ...init, headers: { ...init.headers, authorization }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  };
  const one = (asset: string) => `${ROOT}/${encodeURIComponent(asset)}`;

  return {
    create: async ({ url, passthrough }) => {
      try {
        const response = await call(ROOT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            inputs: [{ url, generated_subtitles: [{ language_code: "es", name: "Español (automático)" }] }],
            playback_policies: ["signed"],
            video_quality: "basic",
            max_resolution_tier: "1080p",
            passthrough,
          }),
        });
        if (response.status >= 400 && response.status < 500) return "rejected";
        if (!response.ok) return null;
        const data = await dataOf(response);
        return isRecord(data) && typeof data.id === "string" ? data.id : null;
      } catch {
        return null;
      }
    },
    read: async (asset) => {
      try {
        const response = await call(one(asset));
        if (response.status === 404) return "gone";
        return response.ok ? assetOf(await dataOf(response)) : null;
      } catch {
        return null;
      }
    },
    findByPassthrough: async (passthrough, since) => {
      const found: string[] = [];
      const started = now();
      let cursor: unknown = null;
      try {
        for (let page = 1; page <= MAX_PAGES && now() - started < SEARCH_BUDGET_MS; page += 1) {
          const response = await call(`${ROOT}?limit=${PAGE_SIZE}${typeof cursor === "string" ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          if (!response.ok) return null;
          const body: unknown = await response.json();
          const data: unknown = isRecord(body) ? body.data : undefined;
          if (!isRecord(body) || !Array.isArray(data)) return null;
          for (const each of data as unknown[]) {
            if (!isRecord(each) || typeof each.id !== "string") return null;
            if (each.passthrough === passthrough) found.push(each.id);
          }
          const last: unknown = (data as unknown[]).at(-1);
          const reachedBirth = isRecord(last) && Number(last.created_at) < since - CLOCK_MARGIN_SECONDS;
          cursor = body.next_cursor;
          if (typeof cursor !== "string" || reachedBirth) return found;
        }
        return null;
      } catch {
        return null;
      }
    },
    remove: async (asset) => {
      try {
        const response = await call(one(asset), { method: "DELETE" });
        return response.ok || response.status === 404;
      } catch {
        return false;
      }
    },
  };
}
