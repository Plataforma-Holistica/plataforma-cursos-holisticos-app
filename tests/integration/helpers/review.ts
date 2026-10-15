import type { Client } from "pg";

import type { asServer as runAsServer, Tx } from "@/adapters/supabase/db";
import type { ReviewStore } from "@/services/review/queue";
import { createReviewStore } from "@/services/review/store";

import { asOwner, asServer } from "./team";

/**
 * El almacén de la revisión sobre una transacción del dueño: el mismo `createReviewStore` que
 * usa la aplicación, con su reintento y su lectura estricta, pero cada transacción es esta,
 * como servidor y a nombre de las claims que se le pasen, sin confirmar. Aprobar escribe en
 * tablas auditadas, que no admiten borrado: así se revierte.
 */
export function reviewStoreOn(owner: Client): ReviewStore {
  const tx: Tx = {
    query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
  };
  const run = (async (actor: { claims: { userId: string; sessionId?: string | null } }, work: (tx: Tx) => Promise<unknown>) => {
    await asServer(owner, actor.claims.userId, actor.claims.sessionId ?? "");
    try {
      return await work(tx);
    } finally {
      await asOwner(owner);
    }
  }) as unknown as typeof runAsServer;
  return createReviewStore(run);
}
