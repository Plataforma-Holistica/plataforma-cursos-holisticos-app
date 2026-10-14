import "server-only";

import { teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createCatalogLists } from "./lists";
import { databaseCatalogStore } from "./store";

// Las prácticas y los niveles, ya armados con la guarda del equipo, la base y el registro de
// errores. Lo que importan las pantallas.

export type { CatalogItem, CatalogList, CatalogLists, ItemAdded, ItemMoved, ItemRenamed, ItemSetActive, ListsRead, Practice } from "./lists";
export { CATALOG_LISTS, CATALOG_NAME_MAX } from "./lists";

export const { catalogLists, addItem, renameItem, moveItem, setItemActive } = createCatalogLists(
  { report: reportFailure },
  { teamStanding, store: databaseCatalogStore },
);
