// Lo que se le lee a un video de lección (RF-604; T-403): decisión de Sergio del 2026-10-31, MP4 y MOV, y un archivo sin duración
// legible se rechaza, porque sin ella el tope de minutos no sirve.
//
// El tipo sale de la extensión, como en los recursos. Un MP4 y un MOV son una lista de átomos (tamaño, tipo, contenido), y la
// duración vive en `moov/mvhd`, que puede estar al final, detrás de gigas de video: se camina saltando por rangos y nunca se baja
// lo de en medio. La cuenta de lecturas tiene tope: un archivo con miles de átomos diminutos no hace miles de peticiones.
//
// Lo que se contesta decide si la fila vive (`video_confirm`):
//   · `contentOk: null`: una lectura falló. No se sabe, y la fila se queda para reintentar.
//   · `contentOk: false`: se leyeron bytes y no son un video. Destruye la fila.
//   · `contentOk: true, seconds: null`: es un video y no se le pudo leer la duración, también si está roto. Destruye la fila.
//
// La duración de aquí sirve para frenar antes de gastar, y puede mentir: al asentar manda lo que mide Mux.

const BY_EXTENSION: Readonly<Record<string, string>> = { mp4: "video/mp4", mov: "video/quicktime" };

/** Lo que se admite, para el selector de archivos. */
export const VIDEO_EXTENSIONS: readonly string[] = Object.keys(BY_EXTENSION).map((extension) => `.${extension}`);

export function videoMimeOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 1) return null;
  return BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

/** Lee `length` bytes desde `start`, y dice cuánto mide el archivo. Nulo si la lectura falló. */
export type RangeReader = (start: number, length: number) => Promise<{ bytes: Uint8Array; total: number } | null>;

export interface VideoFacts {
  contentOk: boolean | null;
  seconds: number | null;
}

const HEADER_BYTES = 16;
const MVHD_BYTES = 32;
/** Las lecturas que se le dedican a un archivo. El índice de un archivo normal se encuentra en menos de diez. */
const MAX_READS = 64;
const INT_MAX = 2_147_483_647;

const FIRST_ATOMS: Readonly<Record<string, readonly string[]>> = {
  "video/mp4": ["ftyp"],
  // Un MOV viejo puede empezar por cualquiera de estos, sin `ftyp`.
  "video/quicktime": ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"],
};

interface Atom {
  type: string;
  /** Donde empieza su contenido. */
  content: number;
  /** Donde termina. */
  end: number;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const typeAt = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

/** La cabecera de un átomo que empieza en `start`, o nulo si no tiene forma: no cabe, o su tamaño es imposible. */
function atomAt(bytes: Uint8Array, start: number, limit: number): Atom | null {
  if (bytes.length < 8) return null;
  const data = view(bytes);
  const declared = data.getUint32(0);
  const type = typeAt(bytes, 4);
  let header = 8;
  let size: number;
  if (declared === 1) {
    if (bytes.length < HEADER_BYTES) return null;
    const large = data.getBigUint64(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    header = HEADER_BYTES;
    size = Number(large);
  } else if (declared === 0) {
    // Llega hasta el final.
    size = limit - start;
  } else {
    size = declared;
  }
  if (size < header || start + size > limit) return null;
  return { type, content: start + header, end: start + size };
}

/** Los segundos de un `mvhd`, hacia arriba para no quedarse corto en el tope. Nulo si no los dice. */
function secondsOf(bytes: Uint8Array): number | null {
  const data = view(bytes);
  if (bytes.length < 1) return null;
  const wide = data.getUint8(0) === 1;
  if (bytes.length < (wide ? 32 : 20)) return null;
  const scale = data.getUint32(wide ? 20 : 12);
  const duration = wide ? data.getBigUint64(24) : BigInt(data.getUint32(16));
  // En la versión 0, todos los bits prendidos dice «no se sabe».
  if (scale === 0 || duration === 0n || (!wide && duration === 0xffffffffn)) return null;
  const seconds = (duration + BigInt(scale) - 1n) / BigInt(scale);
  return seconds > BigInt(INT_MAX) ? null : Number(seconds);
}

export async function readVideoFacts(read: RangeReader, mime: string): Promise<VideoFacts> {
  let reads = 1;
  const first = await read(0, HEADER_BYTES);
  if (first === null) return { contentOk: null, seconds: null };
  const total = first.total;
  const opening = atomAt(first.bytes, 0, total);
  if (opening === null || !(FIRST_ATOMS[mime] ?? []).includes(opening.type)) return { contentOk: false, seconds: null };

  const isVideo = (seconds: number | null): VideoFacts => ({ contentOk: true, seconds });
  const unknown: VideoFacts = { contentOk: null, seconds: null };

  /** Camina los átomos de `[from, limit)` hasta uno de ese tipo. Nulo: no está o está roto; `undefined`: una lectura falló. */
  async function find(type: string, from: number, limit: number, known?: Atom): Promise<Atom | null | undefined> {
    let at = from;
    let current = known;
    while (at < limit) {
      if (current === undefined) {
        if (reads >= MAX_READS) return null;
        reads += 1;
        const chunk = await read(at, HEADER_BYTES);
        if (chunk === null) return undefined;
        const parsed = atomAt(chunk.bytes, at, limit);
        if (parsed === null) return null;
        current = parsed;
      }
      if (current.type === type) return current;
      at = current.end;
      current = undefined;
    }
    return null;
  }

  const moov = await find("moov", 0, total, opening);
  if (moov === undefined) return unknown;
  if (moov === null) return isVideo(null);
  const mvhd = await find("mvhd", moov.content, moov.end);
  if (mvhd === undefined) return unknown;
  if (mvhd === null) return isVideo(null);
  const body = await read(mvhd.content, Math.min(MVHD_BYTES, mvhd.end - mvhd.content));
  if (body === null) return unknown;
  return isVideo(secondsOf(body.bytes));
}
