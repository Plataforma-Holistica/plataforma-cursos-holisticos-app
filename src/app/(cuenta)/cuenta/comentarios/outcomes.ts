import { commentCursor } from "@/app/_comments/view";
import { commentSessionExit, type SessionExit } from "@/app/_comments/session-exit";
import type { SessionCheck } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import type { CommentDelete } from "@/services/comments/comments";

// «Mis comentarios» (PA-24; T-501; decisiones de Sergio del 2026-11-08): qué pide cada botón y qué pinta la lista después de
// borrar. Desde aquí solo se borra. El botón dice qué se pidió con lo que se vio (`delete:<id>:<revisión>`), y el formulario
// lleva la página en que se estaba (`desde`), para volver a ella sin JavaScript.

export interface MineNotice {
  kind: "deleted" | "gone" | "changed" | "unavailable";
  /** El comentario del que habla, o nulo si ya no está en la lista. */
  id: string | null;
}

export interface MineState {
  attempt: number;
  /** El comentario cuyo borrado se está preguntando. */
  asking: string | null;
  notice: MineNotice | null;
}

export const IDLE_MINE: MineState = { attempt: 0, asking: null, notice: null };

export const MINE_FIELDS = { from: "desde" } as const;

export type MineRequest =
  | { kind: "ask"; id: string; back: string }
  | { kind: "delete"; id: string; revision: number; back: string }
  | { kind: "cancel"; back: string }
  | { kind: "none" };

export type MineOutcome = SessionExit | { kind: "state"; state: Omit<MineState, "attempt">; refresh: boolean };

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DO = new RegExp(`^(?:(cancel)|ask-delete:(${ID})|delete:(${ID}):([1-9][0-9]{0,14}))$`);

/** La página de la lista, desde un cursor con forma o la primera. */
export const mineHref = (from: string | null): string => (from === null ? ROUTES.myComments : `${ROUTES.myComments}?${MINE_FIELDS.from}=${encodeURIComponent(from)}`);

/** Qué botón se pulsó, y a qué página se vuelve. Sin uno, con más de uno, o con algo que no tiene forma, cuenta como vacío. */
export function readMyCommentsForm(form: unknown): MineRequest {
  if (!(form instanceof FormData)) return { kind: "none" };
  const values = form.getAll("do");
  const [value] = values;
  if (values.length !== 1 || typeof value !== "string" || value.length > 120) return { kind: "none" };
  const match = DO.exec(value);
  if (match === null) return { kind: "none" };
  const from = form.getAll(MINE_FIELDS.from);
  const back = mineHref(from.length === 1 && typeof from[0] === "string" ? commentCursor(from[0]) : null);
  const [, cancel, asked, deleted, revisionText] = match;
  if (cancel !== undefined) return { kind: "cancel", back };
  if (asked !== undefined) return { kind: "ask", id: asked, back };
  const revision = Number(revisionText);
  if (deleted === undefined || !Number.isSafeInteger(revision)) return { kind: "none" };
  return { kind: "delete", id: deleted, revision, back };
}

/** Lo que pinta la lista después de borrar. Si no se supo, la pregunta se queda para reintentar. */
export function myDeleteOutcome(id: string, result: CommentDelete, back: string): MineOutcome {
  switch (result.kind) {
    case "deleted":
      return { kind: "state", refresh: true, state: { asking: null, notice: { kind: "deleted", id: null } } };
    case "not_found":
      return { kind: "state", refresh: true, state: { asking: null, notice: { kind: "gone", id: null } } };
    case "changed":
      return { kind: "state", refresh: true, state: { asking: null, notice: { kind: "changed", id } } };
    case "unavailable":
      return { kind: "state", refresh: false, state: { asking: id, notice: { kind: "unavailable", id } } };
    case "session":
      return (
        commentSessionExit(result.check as Exclude<SessionCheck, { kind: "pass" }>, back) ?? {
          kind: "state",
          refresh: false,
          state: { asking: id, notice: { kind: "unavailable", id } },
        }
      );
  }
}
