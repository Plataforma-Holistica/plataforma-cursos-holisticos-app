import type { Client } from "pg";

import type { asServer as runAsServer, Tx } from "@/adapters/supabase/db";
import type { PeriodStore } from "@/services/periods/panel";
import { createPeriodStore } from "@/services/periods/store";

import { asOwner, asServer } from "./team";

/**
 * El almacén de los periodos sobre una transacción del dueño: el mismo `createPeriodStore` que usa la
 * aplicación, con su reintento, su lectura estricta y su traducción de errores, pero cada transacción es
 * esta, como servidor y a nombre de las claims que se le pasen, sin confirmar. Ensayar, cerrar y descargar
 * escriben en tablas que no admiten borrado: así se revierte. Lo que solo se ve al confirmar (la
 * comprobación diferida del cierre) lo prueba `54-panel-del-periodo.test.ts`.
 */
export function periodStoreOn(owner: Client): PeriodStore {
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
  return createPeriodStore(run);
}
