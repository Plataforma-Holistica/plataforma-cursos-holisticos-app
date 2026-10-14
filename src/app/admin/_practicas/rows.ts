import { admin } from "@/messages/es/admin";
import { plural, t } from "@/messages/format";
import type { CatalogItem, CatalogLists, Practice } from "@/services/catalog/catalog";

import { catalogButton } from "./outcomes";

// Lo que la pantalla de las prácticas y los niveles pinta (PA-67), ya en palabras y con los
// valores de sus botones. Lo arma la página con lo que leyó: el navegador no decide qué se
// ofrece.

const text = admin.catalog;

export interface RowButtons {
  /** Nulo donde la base contestaría `edge`: la primera activa no sube, la última no baja. */
  up: string | null;
  down: string | null;
  rename: string | null;
  deactivate: string | null;
  reactivate: string | null;
}

export interface CatalogRow {
  id: string;
  name: string;
  active: boolean;
  /** Su lugar entre las activas, de 1 en adelante. Nulo si está desactivada. */
  place: number | null;
  /** «En uso en N cursos», o nulo si ninguno la usa. Con alguno, no se ofrece desactivar. */
  inUse: string | null;
  /** El tono de portada, solo en las prácticas: su número (1 a 8) y su nombre. */
  tone: { number: number; name: string } | null;
  /** Lo que va oculto después de cada botón, para quien no ve la fila. */
  detail: string;
  buttons: RowButtons;
}

export interface ListView {
  rows: CatalogRow[];
  /** Cuántas están activas: el «de cuántos» al decir a dónde quedó una que se movió. */
  activeCount: number;
}

export interface CatalogView {
  /** El código de quien mira es reciente: se ofrecen los cambios. */
  canChange: boolean;
  practices: ListView;
  levels: ListView;
}

function toneOf(item: CatalogItem | Practice): CatalogRow["tone"] {
  if (!("coverTone" in item)) return null;
  const number = item.coverTone;
  const name = text.tones[number as keyof typeof text.tones];
  return name === undefined ? null : { number, name };
}

function listView(items: readonly (CatalogItem | Practice)[]): ListView {
  // La base ya las da en orden; se ordena de nuevo para no depender de eso.
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const active = sorted.filter((item) => item.isActive);
  const rows = sorted.map((item): CatalogRow => {
    const index = active.indexOf(item);
    const place = index < 0 ? null : index + 1;
    return {
      id: item.id,
      name: item.name,
      active: item.isActive,
      place,
      inUse: item.inUse > 0 ? t(plural(item.inUse, text.inUse), { count: String(item.inUse) }) : null,
      tone: toneOf(item),
      detail: t(text.of, { name: item.name }),
      buttons: {
        up: place !== null && place > 1 ? catalogButton.up(item.id, item.position) : null,
        down: place !== null && place < active.length ? catalogButton.down(item.id, item.position) : null,
        rename: item.isActive ? catalogButton.rename(item.id) : null,
        // Lo que usa un curso no se desactiva (FL-58 E1): la base contestaría `in_use`.
        deactivate: item.isActive && item.inUse === 0 ? catalogButton.deactivate(item.id) : null,
        reactivate: item.isActive ? null : catalogButton.reactivate(item.id),
      },
    };
  });
  return { rows, activeCount: active.length };
}

export function catalogView(lists: CatalogLists): CatalogView {
  return { canChange: lists.freshCode, practices: listView(lists.practices), levels: listView(lists.levels) };
}
