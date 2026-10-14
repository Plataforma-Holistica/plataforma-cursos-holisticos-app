import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { Added, CatalogList, CatalogLists } from "./lists";

// Lo que el servicio de las listas le pregunta a la base (esquema §5.2 y §6.2): las dos
// listas para la pantalla, y los cuatro cambios. Cada función recibe la transacción ya
// abierta como servidor; ninguna recibe quién actúa.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = z.string().regex(ID);

// Estrictos: un campo que este código no conoce no pasa.
const item = {
  id,
  slug: z.string(),
  name: z.string(),
  position: z.number().int(),
  is_active: z.boolean(),
  in_use: z.number().int().min(0),
};
const listsSchema = z.strictObject({
  fresh_code: z.boolean(),
  practices: z.array(z.strictObject({ ...item, cover_tone: z.number().int().min(1).max(8) })),
  levels: z.array(z.strictObject(item)),
});

/** Lo que contestó `private.catalog_lists()`, o nulo si contestó nulo. Otra forma lanza. */
export function listsOf(raw: unknown): CatalogLists | null {
  if (raw === null) return null;
  const lists = listsSchema.parse(raw);
  const itemOf = (row: z.infer<typeof listsSchema>["levels"][number]) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    position: row.position,
    isActive: row.is_active,
    inUse: row.in_use,
  });
  return {
    freshCode: lists.fresh_code,
    practices: lists.practices.map((row) => ({ ...itemOf(row), coverTone: row.cover_tone })),
    levels: lists.levels.map(itemOf),
  };
}

const listsRow = z.object({ lists: z.unknown() });
const answerRow = z.object({ answer: z.string() });
const addedRow = z.object({ added: z.unknown() });
const addedSchema = z.strictObject({ answer: z.string(), id: id.optional() });

export async function readCatalogLists(tx: Tx): Promise<CatalogLists | null> {
  const [row] = await tx.query(sql`select private.catalog_lists() as lists`, listsRow);
  if (!row) throw new Error("La base no contestó las listas del catálogo.");
  return listsOf(row.lists);
}

/** Agrega a una lista (`private.catalog_add()`). Devuelve lo que contestó, sin juzgarlo. */
export async function askAdd(tx: Tx, list: CatalogList, name: string): Promise<{ answer: string; id: string | null }> {
  const [row] = await tx.query(sql`select private.catalog_add(${list}::text::public.catalog_list, ${name}::text) as added`, addedRow);
  const added = addedSchema.parse(row?.added ?? null);
  return { answer: added.answer, id: added.id ?? null };
}

/** Renombra (`private.catalog_rename()`). El slug no cambia. */
export async function askRename(tx: Tx, list: CatalogList, itemId: string, name: string): Promise<string> {
  const [row] = await tx.query(
    sql`select private.catalog_rename(${list}::text::public.catalog_list, ${itemId}::uuid, ${name}::text) as answer`,
    answerRow,
  );
  return row?.answer ?? "";
}

/** Sube o baja una posición (`private.catalog_move()`). */
export async function askMove(tx: Tx, list: CatalogList, itemId: string, direction: "up" | "down"): Promise<string> {
  const [row] = await tx.query(
    sql`select private.catalog_move(${list}::text::public.catalog_list, ${itemId}::uuid, ${direction}::text) as answer`,
    answerRow,
  );
  return row?.answer ?? "";
}

/** Desactiva o reactiva (`private.catalog_set_active()`). */
export async function askSetActive(tx: Tx, list: CatalogList, itemId: string, active: boolean): Promise<string> {
  const [row] = await tx.query(
    sql`select private.catalog_set_active(${list}::text::public.catalog_list, ${itemId}::uuid, ${active}::boolean) as answer`,
    answerRow,
  );
  return row?.answer ?? "";
}

/** Lo que contestó un cambio, como una de las respuestas de su lista. Otra cosa lanza. */
export function answerOf<Answer extends string>(known: readonly Answer[], answer: string): Answer {
  const found = known.find((each) => each === answer);
  if (found === undefined) throw new Error("La base contestó algo que este servicio no conoce.");
  return found;
}

/**
 * Lo que contestó agregar, con su id. Agregar, el duplicado y el duplicado inactivo siempre
 * lo traen: sin él no se pintaría nada hecho, y lanza.
 */
export function addedOf(known: readonly Added["answer"][], raw: { answer: string; id: string | null }): Added {
  const answer = answerOf(known, raw.answer);
  if ((answer === "added" || answer === "duplicate" || answer === "inactive_duplicate") && raw.id === null) {
    throw new Error("La base contestó sin el id que esa respuesta trae.");
  }
  return { answer, id: raw.id };
}
