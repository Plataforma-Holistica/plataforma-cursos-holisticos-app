import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { asServer, ServerActor, Tx } from "@/adapters/supabase/db";
import { toDatabaseError } from "@/adapters/supabase/errors";
import type { SqlQuery } from "@/adapters/supabase/sql";

import { ADD_ANSWERS, MOVE_ANSWERS, RENAME_ANSWERS, SET_ACTIVE_ANSWERS } from "./lists";
import { askAdd, askMove, askRename, askSetActive, listsOf, readCatalogLists } from "./records";
import { createCatalogStore } from "./store";

// Las consultas de las listas y lo que el almacén hace alrededor: a nombre de quién abre cada
// transacción, qué reintenta y dónde entiende lo que contestó la base. Contra la base de
// verdad corren en `tests/integration/36-listas.test.ts`.

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const ITEM = "b0000000-0000-4000-8000-000000000002";

interface Sent {
  text: string;
  values: readonly unknown[];
}

function txWith(rows: unknown[]) {
  const sent: Sent[] = [];
  const tx: Tx = {
    query<Row>(query: SqlQuery, row: ZodType<Row>): Promise<Row[]> {
      sent.push({ text: query.text.replace(/\s+/g, " ").trim(), values: query.values });
      return Promise.resolve(rows.map((each) => row.parse(each)));
    },
    execute: () => Promise.reject(new Error("Estas consultas no ejecutan sentencias.")),
  };
  return { tx, sent };
}

function runnerWith(rows: unknown[], failures: unknown[] = []) {
  const opened: ServerActor[] = [];
  const pending = [...failures];
  const { tx, sent } = txWith(rows);
  const run = (async (actor: ServerActor, fn: (tx: Tx) => Promise<unknown>) => {
    opened.push(actor);
    if (pending.length > 0) throw pending.shift();
    return fn(tx);
  }) as typeof asServer;
  return { run, opened, sent };
}

const lockConflict = (code: string) => toDatabaseError({ code, severity: "ERROR" });

const RAW = {
  fresh_code: false,
  practices: [{ id: ITEM, slug: "yoga", name: "Yoga", position: 1, is_active: true, cover_tone: 3 }],
  levels: [{ id: ITEM, slug: "principiante", name: "Principiante", position: 2, is_active: false }],
};

describe("las listas, como las contesta la base", () => {
  it("se leen en nombres de la aplicación", () => {
    expect(listsOf(RAW)).toEqual({
      freshCode: false,
      practices: [{ id: ITEM, slug: "yoga", name: "Yoga", position: 1, isActive: true, coverTone: 3 }],
      levels: [{ id: ITEM, slug: "principiante", name: "Principiante", position: 2, isActive: false }],
    });
  });

  it("nula, cuando quien actúa no pasa la puerta con Contenido", () => {
    expect(listsOf(null)).toBeNull();
  });

  it.each<[string, unknown]>([
    ["un campo que este código no conoce", { ...RAW, secreto: 1 }],
    ["una práctica sin tono", { ...RAW, practices: [{ ...RAW.practices[0], cover_tone: undefined }] }],
    ["un tono fuera de los ocho", { ...RAW, practices: [{ ...RAW.practices[0], cover_tone: 9 }] }],
    ["un nivel con tono", { ...RAW, levels: [{ ...RAW.levels[0], cover_tone: 1 }] }],
    ["un id sin forma", { ...RAW, levels: [{ ...RAW.levels[0], id: "uno" }] }],
    ["sin listas", { fresh_code: true }],
  ])("%s no se entiende, y lanza: quien llama lo trata como «no se supo»", (_what, raw) => {
    expect(() => listsOf(raw)).toThrow();
  });

  it("se piden sin decir de quién es la cuenta", async () => {
    const { tx, sent } = txWith([{ lists: RAW }]);
    expect((await readCatalogLists(tx))?.practices).toHaveLength(1);
    expect(sent).toEqual([{ text: "select private.catalog_lists() as lists", values: [] }]);
  });
});

describe("las consultas de los cambios", () => {
  it("agregar manda la lista y el nombre, y devuelve el id cuando lo hay", async () => {
    const { tx, sent } = txWith([{ added: { answer: "added", id: ITEM } }]);
    expect(await askAdd(tx, "practices", "Yoga")).toEqual({ answer: "added", id: ITEM });
    expect(sent).toEqual([
      { text: "select private.catalog_add($1::text::public.catalog_list, $2::text) as added", values: ["practices", "Yoga"] },
    ]);
    expect(await askAdd(txWith([{ added: { answer: "forbidden" } }]).tx, "levels", "x")).toEqual({ answer: "forbidden", id: null });
  });

  it("renombrar, mover y desactivar mandan lo suyo como parámetros", async () => {
    const renamed = txWith([{ answer: "renamed" }]);
    expect(await askRename(renamed.tx, "levels", ITEM, "Avanzado")).toBe("renamed");
    expect(renamed.sent[0]?.values).toEqual(["levels", ITEM, "Avanzado"]);
    const moved = txWith([{ answer: "moved" }]);
    expect(await askMove(moved.tx, "practices", ITEM, "down")).toBe("moved");
    expect(moved.sent[0]?.text).toBe("select private.catalog_move($1::text::public.catalog_list, $2::uuid, $3::text) as answer");
    const active = txWith([{ answer: "deactivated" }]);
    expect(await askSetActive(active.tx, "practices", ITEM, false)).toBe("deactivated");
    expect(active.sent[0]?.values).toEqual(["practices", ITEM, false]);
  });
});

describe("el almacén", () => {
  type Store = ReturnType<typeof createCatalogStore>;
  const CHANGES: [string, string, unknown[], (store: Store) => Promise<unknown>, unknown][] = [
    ["agregar", "catalog_add", [{ added: { answer: "added", id: ITEM } }], (store) => store.add(claims, "practices", "Yoga"), { answer: "added", id: ITEM }],
    ["renombrar", "catalog_rename", [{ answer: "renamed" }], (store) => store.rename(claims, "practices", ITEM, "Otra"), "renamed"],
    ["mover", "catalog_move", [{ answer: "edge" }], (store) => store.move(claims, "levels", ITEM, "up"), "edge"],
    ["desactivar", "catalog_set_active", [{ answer: "unchanged" }], (store) => store.setActive(claims, "levels", ITEM, true), "unchanged"],
  ];

  it("las listas se leen como servidor, sin reintentar", async () => {
    const { run, opened } = runnerWith([{ lists: RAW }], [lockConflict("40P01")]);
    await expect(createCatalogStore(run).lists(claims)).rejects.toMatchObject({ code: "40P01" });
    expect(opened).toEqual([{ claims, reason: "catalog_lists" }]);
  });

  describe.each(CHANGES)("%s", (_name, reason, rows, call, expected) => {
    it("va como servidor, con las claims que se le pasan y su razón para la auditoría", async () => {
      const { run, opened } = runnerWith(rows);
      expect(await call(createCatalogStore(run))).toEqual(expected);
      expect(opened).toEqual([{ claims, reason }]);
    });

    it.each(["40P01", "55P03"])("un choque de candados (%s) se intenta una vez más, y solo una", async (code) => {
      const { run, opened } = runnerWith(rows, [lockConflict(code)]);
      expect(await call(createCatalogStore(run))).toEqual(expected);
      expect(opened).toHaveLength(2);
      const twice = runnerWith(rows, [lockConflict(code), lockConflict(code)]);
      await expect(call(createCatalogStore(twice.run))).rejects.toMatchObject({ code });
      expect(twice.opened).toHaveLength(2);
    });
  });

  it("una respuesta que no está en su lista lanza: no se pinta como hecha", async () => {
    await expect(createCatalogStore(runnerWith([{ answer: "renamed!" }]).run).rename(claims, "practices", ITEM, "x")).rejects.toThrow();
    await expect(createCatalogStore(runnerWith([{ added: { answer: "creado" } }]).run).add(claims, "practices", "x")).rejects.toThrow();
  });

  it.each(["added", "duplicate", "inactive_duplicate"])("agregar que contesta %s sin el id lanza", async (answer) => {
    await expect(createCatalogStore(runnerWith([{ added: { answer } }]).run).add(claims, "practices", "x")).rejects.toThrow();
  });

  it("las listas cerradas son las que escribe cada función de la base", () => {
    expect([...ADD_ANSWERS].sort()).toEqual(["added", "duplicate", "forbidden", "inactive_duplicate", "invalid", "needs_fresh_code"]);
    expect([...RENAME_ANSWERS].sort()).toEqual(["duplicate", "forbidden", "invalid", "needs_fresh_code", "not_found", "renamed", "unchanged"]);
    expect([...MOVE_ANSWERS].sort()).toEqual(["edge", "forbidden", "invalid", "moved", "needs_fresh_code", "not_found"]);
    expect([...SET_ACTIVE_ANSWERS].sort()).toEqual([
      "deactivated",
      "forbidden",
      "invalid",
      "needs_fresh_code",
      "not_found",
      "reactivated",
      "unchanged",
    ]);
  });
});
