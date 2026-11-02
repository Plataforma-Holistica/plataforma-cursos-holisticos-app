import "server-only";

import { createVideoStorage, type VideoStorage } from "@/adapters/supabase/storage";
import { readVideoFacts, type VideoFacts } from "@/domain/catalog/video-content";

// Los archivos de los videos de un borrador (T-403): el único camino del servicio a la cubeta `video-originals`, para que firmar un
// archivo siga viviendo en el módulo de medios (ADR-27; una prueba de arquitectura lo exige). Quién puede pedir qué lo decide la
// base, antes: aquí nunca llega una ruta que no haya salido de ella.

export const VIDEO_BUCKET = "video-originals";

export interface VideoFiles {
  /** A dónde subir por TUS y con qué firma, o nulo si no se pudo firmar. */
  signUpload: (path: string) => Promise<{ endpoint: string; token: string } | null>;
  /** Lo que el archivo dice de sí, leído por rangos. */
  facts: (path: string, mime: string) => Promise<VideoFacts>;
  remove: (paths: readonly string[]) => Promise<void>;
}

export function createVideoFiles(storage: VideoStorage = createVideoStorage()): VideoFiles {
  return {
    signUpload: (path) => storage.signUpload(path),
    facts: (path, mime) => readVideoFacts((start, length) => storage.readRange(path, start, length), mime),
    remove: (paths) => storage.remove(paths),
  };
}
