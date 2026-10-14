import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { holds, type TeamCheck } from "@/services/account/team";
import type { FailureCode } from "@/services/error-reporting/server";

// Las prácticas y los niveles del catálogo (RF-709; PA-67, FL-58; T-106). Las cambia solo
// alguien del equipo con la capacidad Contenido y un código del segundo factor reciente: lo
// decide la base, con su propia puerta (`private.content_change_gate()`). Aquí se decide a
// quién se le pregunta qué y en qué orden, como en `team-admin.ts`:
//
//   · La guarda va primero, siempre: `teamStanding`, y solo sigue quien es del equipo con
//     Contenido. Los demás reciben `refused`, sin distinguir por qué ni preguntarle nada más
//     a la base. Si no se supo quién pide, `unavailable`.
//   · Lo que llega se revisa antes de tocar la base: una lista que existe, un identificador
//     con forma, un nombre con la forma de la tabla. Lo que no la tiene no llega (`malformed`).
//   · Nada de lo que llega dice quién actúa: sale de la sesión que pasó la guarda.
//   · Lo que contesta la base se entiende ya confirmada la transacción, contra la lista
//     cerrada de su función. Otra cosa, o una excepción, es `unknown`: se reporta y nunca se
//     pinta como hecho.

export const CATALOG_LISTS = ["practices", "levels"] as const;
export type CatalogList = (typeof CATALOG_LISTS)[number];

export interface CatalogItem {
  id: string;
  /** Fijo desde que se creó: va en las direcciones de explorar. */
  slug: string;
  name: string;
  position: number;
  isActive: boolean;
}
export interface Practice extends CatalogItem {
  /** Del 1 al 8: el tono de su portada (03 §4.1). */
  coverTone: number;
}
export interface CatalogLists {
  /** Un cambio pasaría hoy la puerta sin pedir el código otra vez. */
  freshCode: boolean;
  practices: Practice[];
  levels: CatalogItem[];
}

/** Lo que contesta cada función de la base. */
export const ADD_ANSWERS = ["forbidden", "needs_fresh_code", "invalid", "duplicate", "inactive_duplicate", "added"] as const;
export const RENAME_ANSWERS = ["forbidden", "needs_fresh_code", "invalid", "not_found", "duplicate", "unchanged", "renamed"] as const;
export const MOVE_ANSWERS = ["forbidden", "needs_fresh_code", "invalid", "not_found", "edge", "moved"] as const;
export const SET_ACTIVE_ANSWERS = ["forbidden", "needs_fresh_code", "invalid", "not_found", "unchanged", "deactivated", "reactivated"] as const;
export type AddAnswer = (typeof ADD_ANSWERS)[number];
export type RenameAnswer = (typeof RENAME_ANSWERS)[number];
export type MoveAnswer = (typeof MOVE_ANSWERS)[number];
export type SetActiveAnswer = (typeof SET_ACTIVE_ANSWERS)[number];

/** Lo que contestó agregar: el id, salvo en los rechazos sin fila. */
export interface Added {
  answer: AddAnswer;
  id: string | null;
}

/**
 * Lo que estos servicios le preguntan a la base, a nombre de las claims que se les pasan. Las
 * listas son nulas cuando quien actúa no pasa la puerta del equipo con Contenido. Cada cambio
 * lanza si la base no contestó algo de su lista: quien llama lo trata como «no se supo».
 */
export interface CatalogStore {
  lists(claims: VerifiedClaims): Promise<CatalogLists | null>;
  add(claims: VerifiedClaims, list: CatalogList, name: string): Promise<Added>;
  rename(claims: VerifiedClaims, list: CatalogList, id: string, name: string): Promise<RenameAnswer>;
  move(claims: VerifiedClaims, list: CatalogList, id: string, direction: "up" | "down"): Promise<MoveAnswer>;
  setActive(claims: VerifiedClaims, list: CatalogList, id: string, active: boolean): Promise<SetActiveAnswer>;
}

interface Refused {
  kind: "refused";
}
interface Unavailable {
  kind: "unavailable";
}
interface Unknown {
  kind: "unknown";
}
interface Malformed {
  kind: "malformed";
}

export type ListsRead = { kind: "lists"; lists: CatalogLists } | Unavailable;
export type ItemAdded = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: AddAnswer; id: string | null };
export type ItemRenamed = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: RenameAnswer };
export type ItemMoved = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: MoveAnswer };
export type ItemSetActive = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: SetActiveAnswer };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** El tope del nombre, el mismo que la tabla. */
export const CATALOG_NAME_MAX = 40;

/** Un identificador con forma, o nulo. Solo minúsculas: así dos iguales se escriben igual. */
function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function listOf(value: unknown): CatalogList | null {
  return CATALOG_LISTS.find((list) => list === value) ?? null;
}

/**
 * Un nombre con la forma de la tabla, en NFC y ya sin espacios a los lados, o nulo: de 1 a 40
 * caracteres, sin caracteres de control ni de formato (el guion suave, los de ancho cero, los
 * que invierten la dirección del texto), que no se ven. La base revisa además que dé un slug.
 */
export function catalogNameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  if (name.length < 1 || [...name].length > CATALOG_NAME_MAX) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
}

export interface CatalogCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  store: CatalogStore;
}

export function createCatalogLists(deps: { report: (code: FailureCode) => Promise<void> }, core: CatalogCore) {
  const { store } = core;

  /** Quien pide, si es del equipo con Contenido y su sesión pasa la puerta. */
  async function admit(reader: CookieReader): Promise<{ ok: true; claims: VerifiedClaims } | { ok: false; result: Refused | Unavailable }> {
    const team = await core.teamStanding(reader);
    // La guarda ya reportó lo suyo.
    if (team.kind === "unavailable") return { ok: false, result: { kind: "unavailable" } };
    if (team.kind !== "team" || !holds(team.standing, "content")) return { ok: false, result: { kind: "refused" } };
    return { ok: true, claims: team.claims };
  }

  /** Un cambio: lo que la base contestó, o «no se supo» si no contestó algo de su lista. */
  async function change<Answer>(work: () => Promise<Answer>): Promise<{ ok: true; answer: Answer } | { ok: false; result: Unknown }> {
    try {
      return { ok: true, answer: await work() };
    } catch {
      await deps.report("catalog_change_unavailable");
      return { ok: false, result: { kind: "unknown" } };
    }
  }

  /**
   * Las dos listas, para la sección que ya pasó su guarda, con las claims que esa guarda dio.
   * Leer no pide el código reciente. Una lectura nula (la sesión dejó de pasar entre la guarda
   * y esta lectura) o que no se pudo hacer es «no se supo»; solo la segunda se reporta.
   */
  async function catalogLists(claims: VerifiedClaims): Promise<ListsRead> {
    try {
      const lists = await store.lists(claims);
      if (lists !== null) return { kind: "lists", lists };
      return { kind: "unavailable" };
    } catch {
      await deps.report("catalog_lists_unavailable");
      return { kind: "unavailable" };
    }
  }

  async function addItem(reader: CookieReader, input: { list: unknown; name: unknown }): Promise<ItemAdded> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const list = listOf(input.list);
    const name = catalogNameOf(input.name);
    if (list === null || name === null) return { kind: "malformed" };
    const result = await change(() => store.add(admitted.claims, list, name));
    if (!result.ok) return result.result;
    return { kind: "answered", answer: result.answer.answer, id: result.answer.id };
  }

  async function renameItem(reader: CookieReader, input: { list: unknown; id: unknown; name: unknown }): Promise<ItemRenamed> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const list = listOf(input.list);
    const id = idOf(input.id);
    const name = catalogNameOf(input.name);
    if (list === null || id === null || name === null) return { kind: "malformed" };
    const result = await change(() => store.rename(admitted.claims, list, id, name));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  async function moveItem(reader: CookieReader, input: { list: unknown; id: unknown; direction: unknown }): Promise<ItemMoved> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const list = listOf(input.list);
    const id = idOf(input.id);
    const direction = input.direction === "up" || input.direction === "down" ? input.direction : null;
    if (list === null || id === null || direction === null) return { kind: "malformed" };
    const result = await change(() => store.move(admitted.claims, list, id, direction));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  async function setItemActive(reader: CookieReader, input: { list: unknown; id: unknown; active: unknown }): Promise<ItemSetActive> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const list = listOf(input.list);
    const id = idOf(input.id);
    const active = typeof input.active === "boolean" ? input.active : null;
    if (list === null || id === null || active === null) return { kind: "malformed" };
    const result = await change(() => store.setActive(admitted.claims, list, id, active));
    return result.ok ? { kind: "answered", answer: result.answer } : result.result;
  }

  return { catalogLists, addItem, renameItem, moveItem, setItemActive };
}
