import type { CatalogCode, ItemAdded, ItemMoved, ItemRenamed, ItemSetActive } from "@/services/catalog/catalog";
import { parseCatalogName } from "@/services/catalog/field-rules";
import { ROUTES } from "@/services/account/navigation";

import { givenCodeOutcome, type CodeOutcome, type Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace la pantalla de las prácticas y los niveles (diseño, PA-67; FL-58).
// Todo aquí es puro: el servicio corre la guarda y le pregunta a la base, y esto traduce su
// respuesta a un destino o a lo que se pinta. Cada respuesta de la base tiene su caso: una
// nueva se agrega aquí, con su prueba.
//
// Las reglas de la pantalla del equipo valen aquí igual:
//
//   · A quien la guarda no dejó (`refused`), o a quien la base le dijo que no tiene Contenido
//     (`forbidden`), se le manda a esta misma página, donde decide su guarda.
//   · Lo que llega es qué botón se pulsó. Un envío sin intención, con más de una o con un id
//     sin forma cuenta como vacío. A qué fila se le hace algo sale del valor del botón; de qué
//     lista, de la acción que lo recibe.
//   · «No se supo» nunca se pinta como hecho.
//
// Viaja al navegador: no importa nada del servidor.

export type { CodeState } from "../_lib/fresh-code";

/** A esta misma página: decide su guarda. */
const TO_PAGE: Leave = { kind: "leave", to: ROUTES.catalog, notice: null };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POSITION = /^[1-9][0-9]{0,8}$/;
const MAX_INTENT = 120;
/** Lo que se acepta leer de un nombre. Más largo llega cortado, y la regla lo da por largo. */
const MAX_NAME_READ = 401;

/** Lo que contestó dar el código: la tabla compartida, con esta página. */
export function catalogCodeOutcome(result: CatalogCode): CodeOutcome {
  return givenCodeOutcome(result, ROUTES.catalog);
}

// ---------------------------------------------------------------------------------------
// Lo que llega.

export type NameProblem = "required" | "too_long" | "invalid" | "duplicate";

export type CatalogRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "add"; name: string }
  | { step: "rename"; id: string }
  | { step: "save"; id: string; name: string }
  | { step: "move"; id: string; direction: "up" | "down"; position: number }
  | { step: "active"; id: string; active: boolean };

/** Un campo de texto tal como llegó, cortado si viene desmedido. Lo que no es texto, vacío. */
function textOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, MAX_NAME_READ) : "";
}

/**
 * Qué se pidió. Nulo si lo que llegó no es un formulario, no trae `do`, lo trae más de una
 * vez, viene desmedido o no se entiende.
 */
export function readCatalogForm(form: unknown): CatalogRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, id, position, ...rest] = only.split(":");
  if (rest.length > 0) return { step: "none" };
  if (verb === "cancel" && id === undefined) return { step: "cancel" };
  if (verb === "add" && id === undefined) return { step: "add", name: textOf(form, "name") };
  if (id === undefined || !ID.test(id)) return { step: "none" };
  if ((verb === "up" || verb === "down") && position !== undefined && POSITION.test(position)) {
    return { step: "move", id, direction: verb, position: Number(position) };
  }
  if (position !== undefined) return { step: "none" };
  switch (verb) {
    case "rename":
      return { step: "rename", id };
    case "save":
      return { step: "save", id, name: textOf(form, "name") };
    case "deactivate":
      return { step: "active", id, active: false };
    case "reactivate":
      return { step: "active", id, active: true };
    default:
      return { step: "none" };
  }
}

/** Lo que tiene que decirse de un nombre antes de llamar a nadie, o nulo si tiene forma. */
export function checkName(name: string): NameProblem | null {
  const parsed = parseCatalogName(name);
  if (parsed.ok) return null;
  return parsed.reason === "empty" ? "required" : parsed.reason;
}

// ---------------------------------------------------------------------------------------
// Los valores de los botones. Los arma esta tabla y los lee `readCatalogForm`.

export const catalogButton = {
  add: () => "add",
  cancel: () => "cancel",
  up: (id: string, position: number) => `up:${id}:${position}`,
  down: (id: string, position: number) => `down:${id}:${position}`,
  rename: (id: string) => `rename:${id}`,
  save: (id: string) => `save:${id}`,
  deactivate: (id: string) => `deactivate:${id}`,
  reactivate: (id: string) => `reactivate:${id}`,
} as const;

// ---------------------------------------------------------------------------------------
// Lo que se pinta.

export type CatalogFailure = "list_changed" | "needs_code" | "unavailable" | "unknown";
export type CatalogDone = "added" | "renamed" | "moved" | "deactivated" | "reactivated";

/** Lo que la lista de un bloque pinta después de un envío. */
export type CatalogState =
  | { kind: "idle" }
  /** La fila `id` abierta para renombrar, con lo escrito y su error si lo hubo. */
  | { kind: "renaming"; id: string; name: string | null; problem: NameProblem | null; attempt: number }
  /** El campo de agregar, con lo escrito y su error. */
  | { kind: "add_invalid"; name: string; problem: NameProblem; attempt: number }
  /** El nombre que se quiso agregar es de una desactivada: se ofrece reactivarla. */
  | { kind: "inactive_duplicate"; id: string; name: string; attempt: number }
  | { kind: "done"; what: CatalogDone; id: string | null; name: string | null; direction: "up" | "down" | null; attempt: number }
  | { kind: "unchanged"; attempt: number }
  /** `name`: lo que se quiso agregar, para que no se pierda. */
  | { kind: "failed"; reason: CatalogFailure; name: string | null; attempt: number };

/** Lo que contestó un cambio, ya traducido. Sin el número de intento: lo pone la acción. */
export type CatalogOutcome = Leave | DistributiveOmit<Exclude<CatalogState, { kind: "idle" }>, "attempt"> | { kind: "idle" };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const failed = (reason: CatalogFailure, name: string | null = null): CatalogOutcome => ({ kind: "failed", reason, name });

export function addOutcome(result: ItemAdded, name: string): CatalogOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
    case "unknown":
      return failed(result.kind, name);
    case "malformed":
      return { kind: "add_invalid", name, problem: "invalid" };
    case "answered":
      switch (result.answer) {
        case "added": {
          // Se dice como quedó guardado: en NFC y sin espacios a los lados.
          const saved = parseCatalogName(name);
          return { kind: "done", what: "added", id: result.id, name: saved.ok ? saved.name : name, direction: null };
        }
        case "duplicate":
          return { kind: "add_invalid", name, problem: "duplicate" };
        case "inactive_duplicate":
          // El id siempre viene con esta respuesta: el almacén lanza si no.
          return result.id === null ? failed("unknown", name) : { kind: "inactive_duplicate", id: result.id, name };
        case "invalid":
          return { kind: "add_invalid", name, problem: "invalid" };
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return failed("needs_code", name);
      }
  }
}

export function renameOutcome(result: ItemRenamed, id: string, name: string): CatalogOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
    case "unknown":
      return failed(result.kind);
    case "malformed":
      return { kind: "renaming", id, name, problem: "invalid" };
    case "answered":
      switch (result.answer) {
        case "renamed":
          return { kind: "done", what: "renamed", id, name: null, direction: null };
        case "unchanged":
          return { kind: "unchanged" };
        case "duplicate":
          return { kind: "renaming", id, name, problem: "duplicate" };
        case "invalid":
          return { kind: "renaming", id, name, problem: "invalid" };
        case "not_found":
          return failed("list_changed");
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return failed("needs_code");
      }
  }
}

export function moveOutcome(result: ItemMoved, id: string, direction: "up" | "down"): CatalogOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
    case "unknown":
      return failed(result.kind);
    // Los botones de esta pantalla siempre tienen forma: uno sin ella no se contesta.
    case "malformed":
      return { kind: "idle" };
    case "changed":
      return failed("list_changed");
    case "answered":
      switch (result.answer) {
        case "moved":
          return { kind: "done", what: "moved", id, name: null, direction };
        case "edge":
        case "not_found":
        case "invalid":
          return failed("list_changed");
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return failed("needs_code");
      }
  }
}

export function activeOutcome(result: ItemSetActive, id: string): CatalogOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
    case "unknown":
      return failed(result.kind);
    case "malformed":
      return { kind: "idle" };
    case "answered":
      switch (result.answer) {
        case "deactivated":
        case "reactivated":
          return { kind: "done", what: result.answer, id, name: null, direction: null };
        case "unchanged":
          return { kind: "unchanged" };
        case "not_found":
        case "invalid":
          return failed("list_changed");
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return failed("needs_code");
      }
  }
}
