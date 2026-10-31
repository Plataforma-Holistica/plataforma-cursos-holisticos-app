import "server-only";

import { createResourceStorage, type ResourceStorage } from "@/adapters/supabase/storage";
import { contentMatches, RESOURCE_READ } from "@/domain/catalog/resource-content";

// Los archivos de los recursos de un curso (T-404): el único camino al adaptador de Storage, para que firmar
// un archivo siga viviendo en el módulo de medios (ADR-27; una prueba de arquitectura lo exige). Quién puede
// pedir qué lo decide la base, antes: aquí nunca llega una ruta que no haya salido de ella.

export interface ResourceFiles {
  signUpload: (path: string) => Promise<string | null>;
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
