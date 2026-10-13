import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import type { CurrentText } from "./forms";
import { REQUIRED_DOC_TYPES } from "./gate";

// Lo que los servicios de cuenta leen y escriben de la persona: los textos vigentes, su
// perfil, sus consentimientos y el reclamo de la cuenta (esquema §5.1, §5.8 y §6.2). Cada
// función recibe la transacción ya abierta como servidor: por quién se actúa lo declaró
// quien la abrió, con las claims que verificó.

const textRow = z.object({
  doc_type: z.string(),
  id: z.string().nullable(),
  version: z.number().int().nullable(),
  title: z.string().nullable(),
});

/**
 * El texto vigente de cada tipo obligatorio, en el orden de `REQUIRED_DOC_TYPES`. «Vigente»
 * es lo que dice `private.current_legal_document()`, la misma definición que usa el
 * guardián de `consents`. Un borrador (versión 0) solo cuenta si `draftsAllowed`.
 */
export async function currentTexts(tx: Tx, draftsAllowed: boolean): Promise<CurrentText[]> {
  const rows = await tx.query(
    sql`select t.doc_type::text as doc_type, d.id::text as id, d.version, d.title
        from unnest(${[...REQUIRED_DOC_TYPES]}::public.legal_doc_type[]) with ordinality as t (doc_type, position)
        left join public.legal_documents d on d.id = private.current_legal_document(t.doc_type)
        order by t.position`,
    textRow,
  );
  return rows.map((row) => {
    const absent = row.id === null || row.version === null || (row.version === 0 && !draftsAllowed);
    return absent
      ? { docType: row.doc_type, documentId: null, version: null, title: null }
      : { docType: row.doc_type, documentId: row.id, version: row.version, title: row.title };
  });
}

/** Un texto vigente, completo: lo que una pantalla necesita para mostrarlo. */
export interface ReadableText {
  docType: string;
  documentId: string;
  version: number;
  title: string;
  body: string;
  /** Desde cuándo rige, en UTC y en formato ISO. */
  effectiveFrom: string;
}

const readableRow = textRow.extend({ body: z.string().nullable(), effective_from: z.string().nullable() });

/**
 * Los textos vigentes de los tipos obligatorios, completos y en su orden, o `null` en el
 * lugar del que no tiene texto vigente. La misma definición de «vigente» que `currentTexts`.
 */
export async function readableTexts(tx: Tx, draftsAllowed: boolean): Promise<(ReadableText | null)[]> {
  const rows = await tx.query(
    sql`select t.doc_type::text as doc_type, d.id::text as id, d.version, d.title, d.body,
               to_char(d.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_from
        from unnest(${[...REQUIRED_DOC_TYPES]}::public.legal_doc_type[]) with ordinality as t (doc_type, position)
        left join public.legal_documents d on d.id = private.current_legal_document(t.doc_type)
        order by t.position`,
    readableRow,
  );
  return rows.map((row) => {
    if (row.id === null || row.version === null || row.title === null || row.body === null || row.effective_from === null) {
      return null;
    }
    if (row.version === 0 && !draftsAllowed) return null;
    return {
      docType: row.doc_type,
      documentId: row.id,
      version: row.version,
      title: row.title,
      body: row.body,
      effectiveFrom: row.effective_from,
    };
  });
}

const profileStateRow = z.object({ status: z.string(), pending: z.boolean() });

/** El estado de la cuenta y su marca de contraseña, o nulo si no tiene perfil. */
export async function profileState(tx: Tx, profileId: string): Promise<{ status: string; pending: boolean } | null> {
  const [row] = await tx.query(
    sql`select p.status::text as status, p.password_reset_required as pending
        from public.profiles p where p.id = ${profileId}::uuid`,
    profileStateRow,
  );
  return row ?? null;
}

/** Guarda el nombre. Dice si había un perfil donde guardarlo. */
export async function saveName(tx: Tx, profileId: string, name: string): Promise<boolean> {
  const saved = await tx.execute(sql`update public.profiles set display_name = ${name} where id = ${profileId}::uuid`);
  return saved === 1;
}

/**
 * Guarda el nombre, si viene, y la declaración de edad, si se pide. La declaración lleva
 * la hora de la base y no se pisa: la primera es la que vale.
 */
export async function saveIdentity(tx: Tx, profileId: string, identity: { name: string | null; adult: boolean }): Promise<void> {
  if (identity.name !== null) await saveName(tx, profileId, identity.name);
  if (identity.adult) {
    await tx.execute(
      sql`update public.profiles set adult_declared_at = now()
          where id = ${profileId}::uuid and adult_declared_at is null`,
    );
  }
}

export interface ConsentEvidence {
  /** La dirección canónica de quien pide, o nula si no se conoce. */
  address: string | null;
  userAgent: string | null;
}

const insertedRow = z.object({ id: z.string() });

/**
 * Anota el consentimiento sobre cada uno de esos textos. Sin lanzar: se salta el que ya no
 * es el vigente (lo rechazaría el guardián de la tabla, y abortaría todo lo demás), el que
 * no es de un tipo obligatorio, y el que la persona ya tiene dado y no ha retirado.
 * Devuelve cuántos anotó.
 */
export async function grantConsents(
  tx: Tx,
  profileId: string,
  documentIds: readonly string[],
  origin: "signup" | "login_prompt",
  evidence: ConsentEvidence,
  draftsAllowed: boolean,
): Promise<number> {
  const rows = await tx.query(
    sql`insert into public.consents (profile_id, legal_document_id, origin, ip, user_agent)
        select ${profileId}::uuid, d.id, ${origin}, ${evidence.address}::inet, ${evidence.userAgent}
        from public.legal_documents d
        where d.id = any(${[...documentIds]}::uuid[])
          and d.doc_type = any(${[...REQUIRED_DOC_TYPES]}::public.legal_doc_type[])
          and private.current_legal_document(d.doc_type) = d.id
          and (d.version > 0 or ${draftsAllowed}::boolean)
          and not exists (
            select 1
            from (
              select c.legal_document_id, c.action
              from public.consents c
              join public.legal_documents x on x.id = c.legal_document_id
              where c.profile_id = ${profileId}::uuid and x.doc_type = d.doc_type
              order by c.occurred_at desc, x.version desc, (c.action = 'withdrawn') desc
              limit 1
            ) as latest
            where latest.legal_document_id = d.id and latest.action = 'granted')
        returning id::text as id`,
    insertedRow,
  );
  return rows.length;
}

const markRow = z.object({ bucket: z.string() });

/**
 * Deja la marca de que el enlace de verificación de esta cuenta ya se está usando, y dice
 * si quien llama fue el primero. Auth deja pasar dos canjes simultáneos del mismo enlace:
 * sin esto, dos envíos del mismo formulario fijarían cada uno su contraseña y la que queda
 * sería la del último. Con esto, uno solo sigue.
 *
 * La marca no se quita: una cuenta que ya canjeó su enlace no recibe otro (Auth ya no la
 * invita), así que cualquier canje posterior solo puede ser el duplicado.
 */
export async function markRegistrationStarted(tx: Tx, bucket: string): Promise<boolean> {
  const rows = await tx.query(
    sql`insert into private.rate_limit_counters (bucket, window_start, hits)
        values (${bucket}, 'epoch'::timestamptz, 1)
        on conflict (bucket, window_start) do nothing
        returning bucket`,
    markRow,
  );
  return rows.length === 1;
}

const claimRow = z.object({ state: z.string() });

/**
 * Reclama la cuenta de quien actúa (`private.claim_account()`): apaga la marca de
 * contraseña, fecha el cambio y borra las sesiones anotadas. Va después de fijar la
 * contraseña, nunca antes. Devuelve lo que contestó la base.
 *
 * `ticketPrint` es la huella del resguardo del buzón que el servidor acaba de generar
 * (`mailbox-ticket.ts`), o nulo: un reclamo sin resguardo anula el que la cuenta tuviera.
 * Solo se reclama al terminar un enlace del correo, y una prueba de arquitectura lo exige.
 */
export async function claimAccount(tx: Tx, ticketPrint: string | null): Promise<string> {
  const [row] = await tx.query(sql`select private.claim_account(${ticketPrint}) as state`, claimRow);
  return row?.state ?? "";
}

const proofRow = z.object({ seconds: z.number().int().nullable() });

/**
 * Cuántos segundos vive el resguardo del buzón (`VIGENCIA_PRUEBA_BUZON_MINUTOS`), con el
 * tope que se le pase. Nulo si el parámetro falta o no vale: no lanza, porque de esto no
 * puede depender que alguien termine su registro o recupere su contraseña.
 */
export async function mailboxProofSeconds(tx: Tx, limit: number): Promise<number | null> {
  const [row] = await tx.query(
    sql`select (select least(v.seconds, ${limit}::bigint)::integer
                from (select private.mailbox_proof_seconds() as seconds) as v
                where v.seconds is not null) as seconds`,
    proofRow,
  );
  return row?.seconds ?? null;
}

const formParamsRow = z.object({
  minimum_age: z.number().int(),
  link_minutes: z.number().int(),
  resend_wait: z.number().int(),
});

/** Los valores de negocio que las pantallas de la cuenta citan. */
export async function loadFormParams(
  tx: Tx,
): Promise<{ minimumAge: number; linkLifetimeMinutes: number; resendWaitSeconds: number }> {
  const [row] = await tx.query(
    sql`select
          private.parameter_value('EDAD_MINIMA') as minimum_age,
          private.parameter_value('VIGENCIA_ENLACE_CONTRASENA') as link_minutes,
          private.parameter_value('ESPERA_REENVIO') as resend_wait`,
    formParamsRow,
  );
  if (!row) throw new Error("La base no devolvió los parámetros del formulario.");
  return { minimumAge: row.minimum_age, linkLifetimeMinutes: row.link_minutes, resendWaitSeconds: row.resend_wait };
}
