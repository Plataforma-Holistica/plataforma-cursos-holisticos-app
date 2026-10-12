import "server-only";

import { z } from "zod";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asUser } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import { parseDisplayName, type DisplayNameResult } from "@/domain/access/display-name";

import type { SessionCheck } from "./admission";
import type { AccountDependencies } from "./deps";
import { saveName } from "./records";

// Administrar la cuenta (RF-109; flujo de la app FL-27; diseño PA-25): lo que una persona
// con sesión cambia de su propia cuenta. Por ahora, el nombre. Las sesiones abiertas y la
// contraseña llegan en sus propias solicitudes, y el cambio de correo espera a que haya
// correo propio (T-310).
//
// Una regla para todo el archivo: cada escritura vuelve a correr la guarda de sesión, y la
// cuenta sobre la que se escribe es la de esa sesión. Nada de lo que llega dice de quién es.

export type AccountProfile =
  /** `name` es nulo solo si la cuenta no tiene nombre guardado: la guarda no deja llegar así. */
  | { kind: "ready"; name: string | null }
  /** No se supo. */
  | { kind: "unavailable" };

export type NameChange =
  /** Quedó guardado, sin espacios en los extremos. */
  | { kind: "saved"; name: string }
  | { kind: "invalid"; reason: Extract<DisplayNameResult, { ok: false }>["reason"] }
  /** La sesión no llega hasta aquí: se obedece lo que dijo la guarda. */
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unavailable" };

/** Lo que estos servicios usan de los de entrada. */
export interface ManagementCore {
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
}

const nameRow = z.object({ display_name: z.string().nullable() });

export function createManagement(deps: Pick<AccountDependencies, "report">, core: ManagementCore) {
  /**
   * Lo que la pantalla de la cuenta pinta de la persona. Recibe las claims con las que la
   * guarda dejó pasar a su página, y lee como esa persona: la base filtra por ella.
   */
  async function accountProfile(claims: VerifiedClaims): Promise<AccountProfile> {
    try {
      const rows = await asUser(claims, (tx) =>
        tx.query(sql`select p.display_name from public.profiles p where p.id = ${claims.userId}::uuid`, nameRow),
      );
      const [row] = rows;
      // Sin perfil no hay cuenta que administrar: la guarda ya habría cerrado esa sesión.
      if (!row) throw new Error("Una sesión que pasó la guarda no tiene perfil.");
      return { kind: "ready", name: row.display_name };
    } catch {
      await deps.report("account_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Cambiar el nombre (FL-27, paso 1). Exige una sesión que pase la guarda: a una cuenta a
   * la que le falta algo se lo pide primero su pantalla (PA-15). El criterio de «nombre
   * válido» es el mismo de la guarda, así que lo guardado nunca deja a la cuenta sin nombre.
   */
  async function changeName(reader: CookieReader, input: { name: string }): Promise<NameChange> {
    const check = await core.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };

    const parsed = parseDisplayName(input.name);
    if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };

    try {
      await asServer({ claims: check.claims, reason: "change_name" }, async (tx) => {
        // Sin perfil no se guardó nada, y no se dice que sí: la cuenta se fue entre la guarda y aquí.
        if (!(await saveName(tx, check.claims.userId, parsed.name))) {
          throw new Error("Una sesión que pasó la guarda no tiene perfil.");
        }
      });
    } catch {
      await deps.report("account_unavailable");
      return { kind: "unavailable" };
    }
    return { kind: "saved", name: parsed.name };
  }

  return { accountProfile, changeName };
}
