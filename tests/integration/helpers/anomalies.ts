import type { Client } from "pg";

import type { asServer as runAsServer, Tx } from "@/adapters/supabase/db";
import type { AnomalyStore } from "@/services/anomalies/alerts";
import { createAnomalyStore } from "@/services/anomalies/store";

import { asOwner, asServer } from "./team";

/**
 * El almacén de las alertas sobre una transacción del dueño: el mismo `createAnomalyStore` que usa
 * la aplicación, con su reintento y su lectura estricta, pero cada transacción es esta, como
 * servidor y a nombre de las claims que se le pasen, sin confirmar. Revisar y excluir escriben en
 * tablas auditadas, que no admiten borrado: así se revierte.
 */
export function anomalyStoreOn(owner: Client): AnomalyStore {
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
  return createAnomalyStore(run);
}
