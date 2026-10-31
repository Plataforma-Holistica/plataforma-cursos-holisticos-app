// Los recursos de un curso (RF-605; T-404): qué se admite y si un archivo es lo que dice ser. Decisión de
// Sergio del 2026-10-30: PDF, Word moderno (`.docx`), MP3 y M4A, comprobados por su contenido. La cubeta
// solo mira el tipo que declara quien sube, así que esto es lo que de verdad lo revisa.
//
// La clase y el tipo salen de la extensión, no de lo que diga el navegador: reporta M4A de varias maneras,
// y a veces nada para un Word. El servidor manda subir con este tipo, y la base lo compara con el guardado.
//
// Comprobar el contenido no revisa lo que el archivo trae adentro (el JavaScript de un PDF, un objeto de un
// Word): Sergio aceptó ese riesgo para esta versión, y el escaneo queda para después. Lo que se rechaza es
// lo que no es lo que dice: un ejecutable renombrado, un video con extensión de audio, un Word con macros.

export type ResourceKind = "pdf" | "doc" | "audio";

export interface ResourceType {
  kind: ResourceKind;
  mime: string;
  extension: string;
}

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MP3 = "audio/mpeg";
const M4A = "audio/mp4";

const BY_EXTENSION: Readonly<Record<string, ResourceType>> = {
  pdf: { kind: "pdf", mime: PDF, extension: "pdf" },
  docx: { kind: "doc", mime: DOCX, extension: "docx" },
  mp3: { kind: "audio", mime: MP3, extension: "mp3" },
  m4a: { kind: "audio", mime: M4A, extension: "m4a" },
};

/** Lo que se admite, para el `accept` del selector de archivos. */
export const RESOURCE_EXTENSIONS: readonly string[] = Object.keys(BY_EXTENSION).map((extension) => `.${extension}`);

/** La clase y el tipo de un archivo por su nombre, o nulo si no se admite. Un nombre sin base (`.pdf`) no vale. */
export function resourceTypeOf(fileName: string): ResourceType | null {
  const match = /^.+\.([A-Za-z0-9]+)$/.exec(fileName);
  const extension = match?.[1]?.toLowerCase();
  if (extension === undefined || !Object.hasOwn(BY_EXTENSION, extension)) return null;
  return BY_EXTENSION[extension] ?? null;
}

/** Lo que el servidor le pide leer a Storage: el principio de todo archivo, y el final solo de un Word. */
export const RESOURCE_READ = {
  head: 16,
  // El final de un ZIP: su marca de fin (22 bytes) más el comentario más largo que admite.
  tailOf: (mime: string): number => (mime === DOCX ? 65_557 : 0),
} as const;

function startsWith(data: Uint8Array, text: string, at = 0): boolean {
  if (data.length < at + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (data[at + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function includes(data: Uint8Array, text: string): boolean {
  for (let at = 0; at + text.length <= data.length; at += 1) {
    if (startsWith(data, text, at)) return true;
  }
  return false;
}

// Una cabecera MPEG de audio, capa III: sincronía de 11 bits, versión que no sea la reservada, capa III,
// un bitrate que no sea el libre ni el inválido, y una frecuencia que no sea la reservada. La sincronía sola
// la cumple cualquier cosa, y AAC la comparte con otra capa.
function isMpegLayer3(head: Uint8Array): boolean {
  const [first, second, third] = head;
  if (first === undefined || second === undefined || third === undefined) return false;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return false;
  if (((second >> 3) & 0b11) === 0b01) return false;
  if (((second >> 1) & 0b11) !== 0b01) return false;
  const bitrate = third >> 4;
  if (bitrate === 0 || bitrate === 0b1111) return false;
  return ((third >> 2) & 0b11) !== 0b11;
}

// Solo las marcas de audio. `mp42` e `isom` también las usa un video, y un video aquí quedaría fuera del
// proveedor y sin marca de agua.
function isAudioMp4(head: Uint8Array): boolean {
  return startsWith(head, "ftyp", 4) && (startsWith(head, "M4A ", 8) || startsWith(head, "M4B ", 8));
}

// Un Word es un ZIP: se lee su directorio, al final del archivo, sin abrir nada. Debe traer las piezas de un
// documento y no las macros. Los nombres de un ZIP de Office no distinguen mayúsculas, y Word en la web guarda a
// veces `word/document2.xml`. Un Word con cientos de partes puede tener su directorio más atrás de lo que se lee, y
// se rechaza: es raro, y dice que lo vuelva a intentar en otro formato.
function isWord(head: Uint8Array, tail: Uint8Array | null): boolean {
  if (tail === null || !startsWith(head, "PK\x03\x04")) return false;
  if (!includes(tail, "PK\x05\x06")) return false;
  const names = String.fromCharCode(...tail).toLowerCase();
  return names.includes("[content_types].xml") && /word\/document[0-9]*\.xml/.test(names) && !names.includes("vbaproject.bin");
}

// La etiqueta ID3v2: su versión es de la 2 a la 4, y los cuatro bytes de su tamaño tienen el bit alto apagado. Sin
// esto, cualquier archivo que empezara con esas tres letras pasaría por un MP3.
function isId3(head: Uint8Array): boolean {
  if (!startsWith(head, "ID3") || head.length < 10) return false;
  const major = head[3] ?? 0;
  const minor = head[4] ?? 0xff;
  if (major < 2 || major > 4 || minor === 0xff) return false;
  return head.subarray(6, 10).every((byte) => byte < 0x80);
}

/** Si lo leído es de ese tipo. `tail` es el final del archivo, y solo lo pide un Word (`RESOURCE_READ`). */
export function contentMatches(mime: string, head: Uint8Array, tail: Uint8Array | null): boolean {
  switch (mime) {
    case PDF:
      return startsWith(head, "%PDF-");
    case MP3:
      return isId3(head) || isMpegLayer3(head);
    case M4A:
      return isAudioMp4(head);
    case DOCX:
      return isWord(head, tail);
    default:
      return false;
  }
}
