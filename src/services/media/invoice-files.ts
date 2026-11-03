import "server-only";

import { createInvoiceStorage, type ResourceStorage } from "@/adapters/supabase/storage";

// El PDF de las facturas del maestro (T-604): el único camino del servicio de facturas al adaptador de Storage, como los recursos. Quién
// puede pedir qué lo decide la base, antes: aquí nunca llega una ruta que no haya salido de ella.

/** Cuánto vive la dirección de una descarga (ADR-27): lo que tarda en empezar, no en terminar. */
const DOWNLOAD_SECONDS = 300;
/** Así empieza todo PDF (ISO 32000): `%PDF-`. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

export interface InvoiceFiles {
  signUpload: (path: string) => Promise<string | null>;
  /** La dirección para bajarlo como adjunto con ese nombre, o nulo si no se pudo firmar. */
  signDownload: (path: string, name: string) => Promise<string | null>;
  /** Si empieza como PDF. `false` solo si se leyeron bytes y no corresponden; si no se pudo leer, `null`. */
  pdfOk: (path: string) => Promise<boolean | null>;
  remove: (paths: readonly string[]) => Promise<void>;
}

export function createInvoiceFiles(storage: ResourceStorage = createInvoiceStorage()): InvoiceFiles {
  return {
    signUpload: (path) => storage.signUpload(path),
    signDownload: (path, name) => storage.signDownload(path, name, DOWNLOAD_SECONDS),
    pdfOk: async (path) => {
      const head = await storage.readStart(path, PDF_MAGIC.length);
      if (head === null) return null;
      return head.length === PDF_MAGIC.length && PDF_MAGIC.every((byte, i) => head[i] === byte);
    },
    remove: (paths) => storage.remove(paths),
  };
}
