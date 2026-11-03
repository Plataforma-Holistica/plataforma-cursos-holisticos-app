import "server-only";

import { createMuxAssets, type ProviderAsset, type VideoProvider } from "@/adapters/mux/assets";
import { getEnv } from "@/config/env";

// Quién procesa los videos de un borrador (T-403, tercera solicitud): el único camino del servicio al adaptador de Mux. Una prueba de
// arquitectura lo exige. Cada video en Mux cuesta dinero, así que crear uno pide que `VIDEO_PROVIDER` lo diga por nombre (`env.ts`);
// leer y borrar van por el proveedor de cada fila, que puede ser otro que el de hoy.
//
// `test` no llama a nadie: en local Mux no alcanza el Storage de la máquina. Lo que crea queda listo al momento, con los segundos que leyó
// el servidor, y la base solo lo acepta con la marca de `private.local_flags`, que en producción nadie pone.

export type { ProviderAsset, VideoProvider };
export type VideoProviderName = "mux" | "test";

export interface VideoProviders {
  /** Con cuál se crea hoy, o nulo si con ninguno: el video se queda en «Recibido», sin gastar. */
  active: () => VideoProviderName | null;
  /** El de una fila, o nulo si esta instalación no tiene con qué hablarle. */
  of: (name: string | null) => VideoProvider | null;
}

const testProvider: VideoProvider = {
  create: ({ passthrough }) => Promise.resolve(`test-${passthrough}`),
  read: (asset, declared) => Promise.resolve({ state: "ready", playback: asset, seconds: declared ?? null, captions: true, error: null }),
  findByPassthrough: () => Promise.resolve([]),
  remove: () => Promise.resolve(true),
};

/** Cuántos videos se le preguntan a la vez a su proveedor: una ráfaga por curso grande chocaría con el límite de peticiones de Mux, y el adaptador corta cada pregunta a los 10 s. */
const PROVIDER_BATCH = 4;

/** Un video que se va a firmar o a publicar, con la reproducción que se firma o se publica. `key` es lo que se devuelve de él. */
export interface AssetToCheck {
  key: string;
  provider: string;
  asset: string | null;
  playback: string | null;
}

/**
 * Lo que su proveedor dice de cada video (T-405): los que ya no tiene listos con esa reproducción, y los que ya tienen subtítulos. Nulo si alguno no se supo: un proveedor con el
 * que esta instalación no habla, un video sin asset, una respuesta que no llegó o una excepción. Lo del proveedor de prueba contesta listo y con subtítulos.
 */
export async function checkAssets(providers: VideoProviders, assets: AssetToCheck[]): Promise<{ notReady: string[]; captioned: string[] } | null> {
  const notReady: string[] = [];
  const captioned: string[] = [];
  try {
    for (let start = 0; start < assets.length; start += PROVIDER_BATCH) {
      const answers = await Promise.all(
        assets.slice(start, start + PROVIDER_BATCH).map(async (each) => {
          const provider = providers.of(each.provider);
          if (provider === null || each.asset === null) return null;
          return { each, read: await provider.read(each.asset) };
        }),
      );
      for (const answer of answers) {
        if (answer === null || answer.read === null) return null;
        const { each, read } = answer;
        if (read === "gone" || read.state !== "ready" || read.playback === null || read.playback !== each.playback) notReady.push(each.key);
        else if (read.captions) captioned.push(each.key);
      }
    }
  } catch {
    return null;
  }
  return { notReady, captioned };
}

export function createVideoProviders(mux: VideoProvider = createMuxAssets()): VideoProviders {
  return {
    active: () => getEnv().VIDEO_PROVIDER ?? null,
    of: (name) => {
      if (name === "test") return testProvider;
      return name === "mux" && getEnv().MUX_TOKEN_ID !== undefined ? mux : null;
    },
  };
}
