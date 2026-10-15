import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

// Lo que la función única de medios le pregunta a la base: la lección con su video, y la
// velocidad mínima. Cada función recibe la transacción ya abierta.

/** La lección y su video, como los necesita la regla. El playback id sale de aquí, nunca de quien pide. */
export interface LessonVideo {
  isCurrent: boolean;
  durationSeconds: number;
  provider: string;
  ready: boolean;
  playbackId: string | null;
}

const lessonRow = z.object({
  is_current: z.boolean(),
  duration_seconds: z.number().int(),
  provider: z.string(),
  status: z.string(),
  playback_id: z.string().nullable(),
});

/**
 * La lección `id` con su video, o nulo si no existe o quien lee no la ve. Se lee como la
 * persona (`asUser`): la política de Contenido sobre lo publicado y los videos es una
 * segunda barrera, además de la guarda del servicio.
 */
export async function readLessonVideo(tx: Tx, id: string): Promise<LessonVideo | null> {
  const [row] = await tx.query(
    sql`select l.is_current, l.duration_seconds, v.provider, v.status::text as status, v.provider_playback_id as playback_id
        from public.published_lessons l
        join public.video_assets v on v.id = l.video_asset_id
        where l.id = ${id}::uuid`,
    lessonRow,
  );
  if (!row) return null;
  return {
    isCurrent: row.is_current,
    durationSeconds: row.duration_seconds,
    provider: row.provider,
    ready: row.status === "ready",
    playbackId: row.playback_id,
  };
}

const speedRow = z.object({ value: z.unknown() });

/** `VELOCIDAD_MIN`, o nulo si falta o no es un número positivo. */
export async function readMinimumSpeed(tx: Tx): Promise<number | null> {
  const [row] = await tx.query(sql`select private.parameter_value('VELOCIDAD_MIN') as value`, speedRow);
  const value = typeof row?.value === "string" ? Number(row.value) : typeof row?.value === "number" ? row.value : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}
