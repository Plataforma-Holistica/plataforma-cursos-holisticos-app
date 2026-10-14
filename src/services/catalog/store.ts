import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, type Tx } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import { ADD_ANSWERS, MOVE_ANSWERS, RENAME_ANSWERS, SET_ACTIVE_ANSWERS, type CatalogStore } from "./lists";
import { addedOf, answerOf, askAdd, askMove, askRename, askSetActive, readCatalogLists } from "./records";

// Lo que el servicio de las listas le pregunta a la base, a nombre de las claims que
// verificó: cada pregunta abre su transacción como servidor, con quién actúa y con qué sesión
// tomados de esas claims.

/** `run` es `asServer`. Solo las pruebas de este archivo pasan otro, para ver qué se reintenta. */
export function createCatalogStore(run: typeof asServer = asServer): CatalogStore {
  /**
   * Un cambio a una lista. Toman el candado de la lista y ninguno escribe antes de rechazar:
   * un choque de candados revierte la transacción entera, y se intenta una vez más. Lo que
   * contestó se entiende ya confirmada.
   */
  function change<Result>(claims: VerifiedClaims, reason: string, work: (tx: Tx) => Promise<Result>): Promise<Result> {
    return withLockRetry(() => run({ claims, reason }, work), isLockConflict);
  }

  return {
    // Solo lee y no toma candados: no hay choque que reintentar.
    lists: (claims) => run({ claims, reason: "catalog_lists" }, (tx) => readCatalogLists(tx)),
    add: async (claims, list, name) => addedOf(ADD_ANSWERS, await change(claims, "catalog_add", (tx) => askAdd(tx, list, name))),
    rename: async (claims, list, id, name) =>
      answerOf(RENAME_ANSWERS, await change(claims, "catalog_rename", (tx) => askRename(tx, list, id, name))),
    move: async (claims, list, id, direction) =>
      answerOf(MOVE_ANSWERS, await change(claims, "catalog_move", (tx) => askMove(tx, list, id, direction))),
    setActive: async (claims, list, id, active) =>
      answerOf(SET_ACTIVE_ANSWERS, await change(claims, "catalog_set_active", (tx) => askSetActive(tx, list, id, active))),
  };
}

export const databaseCatalogStore = createCatalogStore();
