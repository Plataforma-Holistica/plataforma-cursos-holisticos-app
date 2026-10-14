import type { Client } from "pg";

import type { Tx } from "@/adapters/supabase/db";
import type { VerifiedClaims } from "@/services/account/account";
import { ADD_ANSWERS, MOVE_ANSWERS, RENAME_ANSWERS, SET_ACTIVE_ANSWERS, type CatalogStore } from "@/services/catalog/lists";
import { addedOf, answerOf, askAdd, askMove, askRename, askSetActive, readCatalogLists } from "@/services/catalog/records";

import { asOwner, asServer } from "./team";

/**
 * El almacén de las listas sobre una transacción del dueño: las mismas consultas que usa la
 * aplicación, como servidor y a nombre de las claims que se le pasen, pero sin confirmar. Lo
 * que cambian queda en la auditoría, que no admite borrado, y así se revierte.
 */
export function catalogStoreOn(owner: Client): CatalogStore {
  const tx: Tx = {
    query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
  };
  async function acting<T>(claims: VerifiedClaims, work: () => Promise<T>): Promise<T> {
    await asServer(owner, claims.userId, claims.sessionId ?? "");
    try {
      return await work();
    } finally {
      await asOwner(owner);
    }
  }
  return {
    lists: (claims) => acting(claims, () => readCatalogLists(tx)),
    add: (claims, list, name) => acting(claims, async () => addedOf(ADD_ANSWERS, await askAdd(tx, list, name))),
    rename: (claims, list, id, name) => acting(claims, async () => answerOf(RENAME_ANSWERS, await askRename(tx, list, id, name))),
    move: (claims, list, id, direction) => acting(claims, async () => answerOf(MOVE_ANSWERS, await askMove(tx, list, id, direction))),
    setActive: (claims, list, id, active) =>
      acting(claims, async () => answerOf(SET_ACTIVE_ANSWERS, await askSetActive(tx, list, id, active))),
  };
}
