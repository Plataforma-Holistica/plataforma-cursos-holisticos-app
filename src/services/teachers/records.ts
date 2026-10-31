import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import type { ConsentEvidence } from "@/services/account/records";

import { ACCEPT_ANSWERS, type AcceptAnswer, type TeacherStanding, type TeacherText, type TeacherTexts } from "./standing";

// Lo que el servicio del maestro le pregunta a la base, como el servidor y a nombre de la persona: el estado
// y aceptar los decide la base por el correo de la cuenta. `private.teacher_standing()` se nombra solo aquí.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const standingRow = z.object({
  state: z.enum(["none", "invited", "invited_unproven", "needs_notice", "active", "suspended"]),
  teacher_id: z.string().regex(ID).nullable(),
  name: z.string().nullable(),
  notice: z.string().nullable(),
});

/**
 * El estado de quien actúa, en una sola consulta: de la invitación, el nombre para el saludo; de la
 * suspensión, el texto escrito para el maestro. Nunca el motivo interno. Un estado que no conoce lanza: quien
 * llama lo trata como «no se supo».
 */
export async function readTeacherStanding(tx: Tx, ticketPrint: string | null): Promise<TeacherStanding> {
  const rows = await tx.query(
    sql`select s.state, s.teacher_id::text as teacher_id,
               case when s.state in ('invited', 'invited_unproven') then p.display_name end as name,
               case when s.state = 'suspended' then t.suspension_notice end as notice
        from private.teacher_standing(${ticketPrint}) s
        left join public.teachers t on t.id = s.teacher_id
        left join public.published_teachers p on p.teacher_id = s.teacher_id`,
    standingRow,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("private.teacher_standing() no contestó ninguna fila.");
  switch (row.state) {
    case "none":
      return { state: "none" };
    case "invited":
    case "invited_unproven":
      return { state: row.state, name: row.name };
    case "active":
    case "needs_notice":
    case "suspended": {
      if (row.teacher_id === null) throw new Error("private.teacher_standing() contestó un maestro sin identificador.");
      const teacher = { id: row.teacher_id };
      return row.state === "suspended" ? { state: "suspended", teacher, notice: row.notice } : { state: row.state, teacher };
    }
  }
}

const textRow = z.object({
  doc_type: z.string(),
  id: z.string().nullable(),
  version: z.number().int().nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  effective_from: z.string().nullable(),
});

/** Los dos textos vigentes del maestro. Un borrador (versión 0) solo cuenta si `draftsAllowed`. */
export async function readTeacherTexts(tx: Tx, draftsAllowed: boolean): Promise<TeacherTexts> {
  const rows = await tx.query(
    sql`select t.doc_type::text as doc_type, d.id::text as id, d.version, d.title, d.body,
               to_char(d.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_from
        from unnest(array['teacher_agreement', 'teacher_privacy_notice']::public.legal_doc_type[]) as t (doc_type)
        left join public.legal_documents d on d.id = private.current_legal_document(t.doc_type)`,
    textRow,
  );
  const textOf = (docType: string): TeacherText | null => {
    const row = rows.find((each) => each.doc_type === docType);
    if (!row || row.id === null || row.version === null || row.title === null || row.body === null || row.effective_from === null) return null;
    if (row.version === 0 && !draftsAllowed) return null;
    return { documentId: row.id, version: row.version, title: row.title, body: row.body, effectiveFrom: row.effective_from };
  };
  return { agreement: textOf("teacher_agreement"), notice: textOf("teacher_privacy_notice") };
}

const answerRow = z.object({ answer: z.string() });

/**
 * Aceptar la invitación. Devuelve lo que contestó sin juzgarlo: dos de sus rechazos escriben (revocan), y
 * lanzar dentro de la transacción los revertiría. Se valida ya confirmada, con `acceptAnswerOf`.
 */
export async function askAcceptInvitation(
  tx: Tx,
  ticketPrint: string,
  agreement: string,
  notice: string,
  evidence: ConsentEvidence,
): Promise<string> {
  const [row] = await tx.query(
    sql`select private.accept_teacher_invitation(${ticketPrint}, ${agreement}::uuid, ${notice}::uuid, ${evidence.address}::inet, ${evidence.userAgent}) as answer`,
    answerRow,
  );
  if (!row) throw new Error("private.accept_teacher_invitation() no contestó.");
  return row.answer;
}

/** Lo que contestó aceptar, contra su lista cerrada. Lanza con otra cosa: quien llama lo trata como «no se supo». */
export function acceptAnswerOf(answer: string): AcceptAnswer {
  const found = ACCEPT_ANSWERS.find((each) => each === answer);
  if (found === undefined) throw new Error(`private.accept_teacher_invitation() contestó algo desconocido: ${answer}`);
  return found;
}

const insertedRow = z.object({ id: z.string() });

/**
 * Anota el aviso vuelto a pedir, solo si ese texto sigue siendo el vigente: el guardián de `consents` lanzaría
 * con otro, y aquí basta con no anotar. Verdadero si lo anotó. El origen es el de PA-15.
 */
export async function recordTeacherNotice(tx: Tx, profileId: string, notice: string, evidence: ConsentEvidence, draftsAllowed: boolean): Promise<boolean> {
  const rows = await tx.query(
    sql`insert into public.consents (profile_id, legal_document_id, origin, ip, user_agent)
        select ${profileId}::uuid, d.id, 'login_prompt', ${evidence.address}::inet, ${evidence.userAgent}
        from public.legal_documents d
        where d.id = ${notice}::uuid and d.doc_type = 'teacher_privacy_notice'
          and private.current_legal_document(d.doc_type) = d.id
          and (d.version > 0 or ${draftsAllowed}::boolean)
        returning id::text as id`,
    insertedRow,
  );
  return rows.length > 0;
}
