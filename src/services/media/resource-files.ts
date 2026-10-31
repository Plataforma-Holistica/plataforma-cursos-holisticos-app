import "server-only";

import { createResourceStorage, type ResourceStorage } from "@/adapters/supabase/storage";
import { contentMatches, RESOURCE_READ, resourceDownloadName } from "@/domain/catalog/resource-content";

// Los archivos de los recursos de un curso (T-404): el único camino al adaptador de Storage, para que firmar
// un archivo siga viviendo en el módulo de medios (ADR-27; una prueba de arquitectura lo exige). Quién puede
// pedir qué lo decide la base, antes: aquí nunca llega una ruta que no haya salido de ella.

/** Cuánto vive la dirección de una descarga (ADR-27): lo que tarda en empezar, no en terminar. */
const DOWNLOAD_SECONDS = 300;

export interface ResourceFiles {
  signUpload: (path: string) => Promise<string | null>;
  /** La dirección para bajarlo como adjunto, o nulo si no se pudo firmar. */
  signDownload: (file: { path: string; title: string; mime: string }) => Promise<string | null>;
  /**
   * Si el objeto es de ese tipo, por lo que trae adentro. `false` solo si se leyeron bytes y no corresponden,
   * porque eso destruye la fila; si no se pudo leer es `null`, que la base contesta como «no se supo».
   */
  contentOk: (path: string, mime: string) => Promise<boolean | null>;
  remove: (paths: readonly string[]) => Promise<void>;
}

export function createResourceFiles(storage: ResourceStorage = createResourceStorage()): ResourceFiles {
  return {
    signUpload: (path) => storage.signUpload(path),
    signDownload: (file) => storage.signDownload(file.path, resourceDownloadName(file.title, file.mime), DOWNLOAD_SECONDS),
    contentOk: async (path, mime) => {
      const head = await storage.readStart(path, RESOURCE_READ.head);
      if (head === null) return null;
      const tailBytes = RESOURCE_READ.tailOf(mime);
      if (tailBytes === 0) return contentMatches(mime, head, null);
      const tail = await storage.readEnd(path, tailBytes);
      return tail === null ? null : contentMatches(mime, head, tail);
    },
    remove: (paths) => storage.remove(paths),
  };
}
