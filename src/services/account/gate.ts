import "server-only";

import { z } from "zod";

import type { Tx } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import { resolveSessionGate, type DocumentFacts, type GateFacts } from "@/domain/access/session-gate";

import { gateViewOf, type GateView } from "./admission";

// Los hechos que la guarda de sesión necesita, leídos de la base (TRD §9.2, fila «Lo que
// entra sin pasar por el formulario»; esquema §5.1 y §5.8). Quién decide es el dominio
// (`resolveSessionGate`): aquí solo se le traen los hechos, sin interpretar nada.

/** Los textos sin los que no se tiene cuenta completa (RF-108). */
export const REQUIRED_DOC_TYPES = ["terms", "student_privacy_notice", "course_history_consent"] as const;

const profileRow = z.object({
  status: z.string(),
  pending: z.boolean(),
  name: z.string().nullable(),
  adult: z.date().nullable(),
});

const documentRow = z.object({
  doc_type: z.string(),
  current_version: z.number().int().nullable(),
  reconsent_floor: z.number().int().nullable(),
  latest_version: z.number().int().nullable(),
  latest_action: z.string().nullable(),
});

/**
 * La guarda de una cuenta, dentro de una transacción ya abierta como servidor.
 *
 * `draftsAllowed` dice si un borrador (versión 0) vale como texto vigente. Solo en local:
 * fuera de ahí, un tipo que no tiene más que su borrador no tiene texto, y sin texto no hay
 * consentimiento válido.
 *
 * «Vigente» tiene una sola definición, `private.current_legal_document()`, la misma que usa
 * el guardián de `consents`. El piso es la versión más alta, entre las que ya rigen, que
 * pide volver a aceptar.
 */
export async function evaluateGate(tx: Tx, profileId: string, draftsAllowed: boolean): Promise<GateView> {
  const [profile] = await tx.query(
    sql`select p.status::text as status, p.password_reset_required as pending,
               p.display_name as name, p.adult_declared_at as adult
        from public.profiles p where p.id = ${profileId}::uuid`,
    profileRow,
  );

  const rows = await tx.query(
    sql`select t.doc_type::text as doc_type,
               (select d.version from public.legal_documents d
                where d.id = private.current_legal_document(t.doc_type)) as current_version,
               (select max(d.version) from public.legal_documents d
                where d.doc_type = t.doc_type and d.requires_reconsent and d.effective_from <= now()) as reconsent_floor,
               latest.version as latest_version,
               latest.action::text as latest_action
        from unnest(${[...REQUIRED_DOC_TYPES]}::public.legal_doc_type[]) as t (doc_type)
        left join lateral (
          select d.version, c.action
          from public.consents c
          join public.legal_documents d on d.id = c.legal_document_id
          where c.profile_id = ${profileId}::uuid and d.doc_type = t.doc_type
          order by c.occurred_at desc, d.version desc
          limit 1
        ) as latest on true`,
    documentRow,
  );

  const documents: DocumentFacts[] = rows.map((row) => ({
    docType: row.doc_type,
    currentVersion: row.current_version === 0 && !draftsAllowed ? null : row.current_version,
    reconsentFloor: row.reconsent_floor,
    latest:
      row.latest_version === null
        ? null
        : { version: row.latest_version, action: row.latest_action as "granted" | "withdrawn" },
  }));

  const facts: GateFacts = {
    profile: profile
      ? {
          // El dominio trata como «sin perfil» un estado que no conoce.
          status: profile.status as "active" | "suspended" | "deleted",
          passwordResetRequired: profile.pending,
          displayName: profile.name,
          adultDeclaredAt: profile.adult,
        }
      : null,
    documents,
  };
  return gateViewOf(resolveSessionGate(facts, REQUIRED_DOC_TYPES));
}
