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

export function createVideoProviders(mux: VideoProvider = createMuxAssets()): VideoProviders {
  return {
    active: () => getEnv().VIDEO_PROVIDER ?? null,
    of: (name) => {
      if (name === "test") return testProvider;
      return name === "mux" && getEnv().MUX_TOKEN_ID !== undefined ? mux : null;
    },
  };
}
