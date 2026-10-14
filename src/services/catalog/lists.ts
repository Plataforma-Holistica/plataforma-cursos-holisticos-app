import "server-only";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { CATALOG_NAME_MAX_LENGTH, parseCatalogName } from "@/domain/catalog/name";

import { holds, type CodeGiven, type TeamCheck } from "@/services/account/team";
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
/**
 * `changed`: la que se quería mover ya no estaba en la posición que se vio (un doble envío,
 * un formulario reenviado al recargar, otra pestaña). No se movió nada.
 */
export type ItemMoved = Refused | Unavailable | Unknown | Malformed | { kind: "changed" } | { kind: "answered"; answer: MoveAnswer };
/** Dar el código otra vez para que los cambios pasen su puerta (el bloque «Tu código»). */
export type CatalogCode =
  | Refused
  | Unavailable
  | { kind: "verified" }
  | { kind: "wrong_code" }
  /** El freno rechazó: Auth cerró todas sus sesiones. */
  | { kind: "throttled" }
  /** Su código fue el bueno, y aun así ningún cambio pasaría: es configuración. */
  | { kind: "not_available" };
export type ItemSetActive = Refused | Unavailable | Unknown | Malformed | { kind: "answered"; answer: SetActiveAnswer };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** El tope del nombre, el mismo que la tabla. */
export const CATALOG_NAME_MAX = CATALOG_NAME_MAX_LENGTH;

/** Un identificador con forma, o nulo. Solo minúsculas: así dos iguales se escriben igual. */
function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function listOf(value: unknown): CatalogList | null {
  return CATALOG_LISTS.find((list) => list === value) ?? null;
}

/**
 * Un nombre con la forma de la tabla, en NFC y ya sin espacios a los lados, o nulo. La regla
 * es la del dominio (`parseCatalogName`), la misma con que la pantalla lo revisa antes.
 */
export function catalogNameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseCatalogName(value);
  return parsed.ok ? parsed.name : null;
}

/** Una posición que se vio en la lista: un entero de 1 en adelante, o nulo. */
function positionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export interface CatalogCore {
  teamStanding: (reader: CookieReader) => Promise<TeamCheck>;
  /** Dar el código del segundo factor (`team.ts`): el factor es el que dice la base. */
  giveSecondFactorCode: (jar: CookieJar, code: string) => Promise<CodeGiven>;
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

  /**
   * Sube o baja una posición, si sigue en la que se vio (`position`). Mover no se repite sin
   * daño: sin esto, un doble envío o un formulario reenviado al recargar subiría dos lugares,
   * y una pestaña vieja intercambiaría con otra vecina. La comparación es una relectura, no un
   * candado: dos envíos que salgan a la vez pueden leer los dos la misma posición. La base
   * mueve dentro del candado de la lista, así que el orden nunca queda roto.
   */
  async function moveItem(
    reader: CookieReader,
    input: { list: unknown; id: unknown; direction: unknown; position: unknown },
  ): Promise<ItemMoved> {
    const admitted = await admit(reader);
    if (!admitted.ok) return admitted.result;
    const list = listOf(input.list);
    const id = idOf(input.id);
    const direction = input.direction === "up" || input.direction === "down" ? input.direction : null;
    const seen = positionOf(input.position);
    if (list === null || id === null || direction === null || seen === null) return { kind: "malformed" };
    const result = await change(async () => {
      const lists = await store.lists(admitted.claims);
      // Dejó de pasar la puerta entre la guarda y esta lectura: que decida la página.
      if (lists === null) return "refused" as const;
      const item = lists[list].find((each) => each.id === id);
      // Si ya no está, o ya no es esa su posición, no se mueve. Una que no existe la contesta
      // la base (`not_found`), como siempre.
      if (item !== undefined && item.position !== seen) return "changed" as const;
      return store.move(admitted.claims, list, id, direction);
    });
    if (!result.ok) return result.result;
    if (result.answer === "refused") return { kind: "refused" };
    if (result.answer === "changed") return { kind: "changed" };
    return { kind: "answered", answer: result.answer };
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

  /**
   * Dar el código otra vez (PA-67, «Tu código»). El de la pantalla del equipo no sirve aquí:
   * comprueba lo reciente leyendo la lista del equipo, que es nula sin configuración. Este
   * lo comprueba con las listas del catálogo, que solo piden Contenido.
   */
  async function giveCatalogCode(jar: CookieJar, code: string): Promise<CatalogCode> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    const given = await core.giveSecondFactorCode(jar, code);
    switch (given.kind) {
      case "verified":
        break;
      case "wrong_code":
      case "throttled":
      case "unavailable":
        return { kind: given.kind };
      default:
        // Dejó de ser del equipo, o su sesión ya no vale: decide la página.
        return { kind: "refused" };
    }
    return freshAfterCode(jar);
  }

  /** Después de verificar, con la sesión como quedó en ese tarro: verificar escribió su cookie. */
  async function freshAfterCode(jar: CookieJar): Promise<CatalogCode> {
    const admitted = await admit(jar);
    if (!admitted.ok) return admitted.result;
    let lists: CatalogLists | null;
    try {
      lists = await store.lists(admitted.claims);
    } catch {
      await deps.report("catalog_change_unavailable");
      return { kind: "not_available" };
    }
    // Perdió Contenido entre una cosa y otra: decide la página, que le dirá cuál le falta.
    if (lists === null) return { kind: "refused" };
    if (lists.freshCode) return { kind: "verified" };
    await deps.report("catalog_change_unavailable");
    return { kind: "not_available" };
  }

  return { catalogLists, addItem, renameItem, moveItem, setItemActive, giveCatalogCode };
}
