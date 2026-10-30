import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { TeacherStanding } from "./standing";

// Lo que el servicio del maestro le pregunta a la base. Recibe la transacción abierta como la persona:
// su política le deja leer su propia fila, y `current_teacher_id()` solo da un maestro activo o
// suspendido.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const standingRow = z.object({ id: z.string().regex(ID), status: z.enum(["active", "suspended"]) });

export async function readTeacherStanding(tx: Tx): Promise<TeacherStanding> {
  const rows = await tx.query(
    sql`select t.id, t.status from public.teachers t where t.id = (select private.current_teacher_id())`,
    standingRow,
  );
  const found = rows[0];
  return found ? { state: found.status, teacher: { id: found.id } } : { state: "none" };
}
