import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { ACCEPT_ANSWERS, type AcceptAnswer, type TeamStanding } from "./team";

// Lo que los servicios del equipo le preguntan a la base (esquema §6.2): en qué estado está
// quien actúa, y aceptar su invitación. Cada función recibe la transacción ya abierta como
// servidor: por quién se actúa y con qué sesión lo declaró quien la abrió, con las claims
// que verificó. Ninguna recibe de quién es la cuenta.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const standingRow = z.object({
  state: z.string(),
  factor: z.string().nullable(),
  kind: z.string().nullable(),
  capabilities: z.array(z.string()),
});

export type StandingRow = z.infer<typeof standingRow>;

/**
 * Lo que contestó la base, como uno de los seis estados. Lo que no encaje lanza: un estado
 * que no se conoce, un `member` sin su factor o una invitación sin su tipo no se adivinan,
 * y quien llama lo trata como «no se supo».
 */
export function standingOf(row: StandingRow): TeamStanding {
  const factor = row.factor !== null && ID.test(row.factor) ? row.factor : null;
  const kind = row.kind === "grant" || row.kind === "rebind" ? row.kind : null;
  switch (row.state) {
    case "none":
    case "unbound":
      return { state: row.state };
    case "member":
      if (factor !== null && row.capabilities.length > 0) return { state: "member", factor, capabilities: row.capabilities };
      break;
    case "needs_code":
      if (factor !== null) return { state: "needs_code", factor };
      break;
    case "invited":
      if (kind !== null) return { state: "invited", kind, capabilities: row.capabilities };
      break;
    case "invited_unproven":
      if (kind !== null) return { state: "invited_unproven", kind };
      break;
  }
  throw new Error("La base contestó un estado del equipo que no se entiende.");
}

/**
 * En qué estado está quien actúa respecto al equipo (`private.team_standing()`).
 * `ticketPrint` es la huella del resguardo del buzón que trae su navegador, o nulo. No
 * escribe nada.
 */
export async function readTeamStanding(tx: Tx, ticketPrint: string | null): Promise<TeamStanding> {
  const [row] = await tx.query(
    sql`select state, factor::text as factor, kind, capabilities
        from private.team_standing(${ticketPrint}::text)`,
    standingRow,
  );
  if (!row) throw new Error("La base no contestó el estado del equipo.");
  return standingOf(row);
}

const acceptRow = z.object({ answer: z.string() });

/**
 * Acepta la invitación de quien actúa (`private.accept_admin_invitation()`), con la huella
 * del resguardo, el factor que el servidor dio de alta en ese navegador y, en un
 * restablecimiento, la huella del código dictado. Devuelve lo que contestó la base, tal
 * cual: se entiende con `acceptAnswerOf`, ya confirmada la transacción.
 *
 * Tres de sus rechazos escriben antes de contestar (cuentan el fallo o revocan la
 * invitación): la transacción se confirma con cualquier respuesta. Por eso aquí no se
 * valida qué contestó: lanzar dentro revertiría lo que el rechazo escribió, y el límite de
 * códigos dictados no contaría nada.
 */
export async function acceptInvitation(
  tx: Tx,
  ticketPrint: string,
  factorId: string,
  handoffPrint: string | null,
): Promise<string> {
  const [row] = await tx.query(
    sql`select private.accept_admin_invitation(${ticketPrint}::text, ${factorId}::uuid, ${handoffPrint}::text) as answer`,
    acceptRow,
  );
  return row?.answer ?? "";
}

/** Lo que contestó aceptar, como una de sus nueve respuestas. Otra cosa lanza: no se adivina. */
export function acceptAnswerOf(answer: string): AcceptAnswer {
  const known = ACCEPT_ANSWERS.find((candidate) => candidate === answer);
  if (known === undefined) throw new Error("La base contestó algo que aceptar una invitación no contesta.");
  return known;
}
