import { resources as text } from "@/messages/es/resources";
import { t } from "@/messages/format";

// Cómo se dice un recurso (T-404): su tipo y su tamaño, ya en palabras. Lo comparten el catálogo, la lección y el portal.

const GIGA = 1024 * 1024 * 1024;
const MEGA = 1024 * 1024;
const KILO = 1024;

const KIND_WORDS = { pdf: text.kindPdf, doc: text.kindDoc, audio: text.kindAudio } as const;

/** El tamaño en palabras: en GB desde 1 GB (un video), en MB desde 1 MB, con un decimal si hace falta, y en KB lo demás. */
export function sizeText(bytes: number): string {
  if (bytes >= GIGA) return t(text.sizeGb, { size: String(Math.round((bytes / GIGA) * 10) / 10) });
  if (bytes >= MEGA) return t(text.sizeMb, { size: String(Math.round((bytes / MEGA) * 10) / 10) });
  return t(text.sizeKb, { size: String(Math.max(1, Math.round(bytes / KILO))) });
}

export const resourceDetail = (kind: keyof typeof KIND_WORDS, bytes: number): string => t(text.detail, { kind: KIND_WORDS[kind], size: sizeText(bytes) });

/** Las filas de lo publicado, como las pinta la lista. Nada de esto trae la ruta: esa nunca sale de la puerta de medios. */
export const resourceItems = (rows: readonly { id: string; title: string; kind: keyof typeof KIND_WORDS; sizeBytes: number }[]) =>
  rows.map((row) => ({ id: row.id, title: row.title, detail: resourceDetail(row.kind, row.sizeBytes) }));
