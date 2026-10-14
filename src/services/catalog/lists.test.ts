import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Capability, CodeGiven, TeamCheck, TeamStanding } from "@/services/account/team";

import { CATALOG_NAME_MAX, catalogNameOf, createCatalogLists, type CatalogLists, type CatalogStore } from "./lists";

// Las prácticas y los niveles, con todo lo de fuera simulado: aquí se prueba a quién se le
// pregunta qué, en qué orden, y qué se decide con cada respuesta. Contra la base de verdad se
// prueban en `tests/integration/36-listas.test.ts` y en `supabase/tests/17_listas.test.sql`.

const ME = "a0000000-0000-4000-8000-000000000001";
const ITEM = "b0000000-0000-4000-8000-000000000002";
const BOUND = "fa000000-0000-4000-8000-0000000000b0";
const claims = { userId: ME, aal: "aal2", sessionId: "5e000000-0000-4000-8000-000000000001", issuedAt: 0 } as VerifiedClaims;
const LISTS: CatalogLists = { freshCode: true, practices: [], levels: [] };
/** Un nivel en la posición 3, para mover. */
const LEVEL = { id: ITEM, slug: "medio", name: "Medio", position: 3, isActive: true };
const WITH_LEVEL: CatalogLists = { ...LISTS, levels: [LEVEL] };

const standingOf = (capabilities: Capability[]): TeamStanding => ({ state: "member", capabilities, factor: BOUND }) as TeamStanding;
const teamCheck = (standing: TeamStanding = standingOf(["content"])): TeamCheck => ({ kind: "team", claims, standing, inProgress: null });

function listsWith(
  setup: {
    check?: TeamCheck;
    /** Lo que contesta la guarda la segunda vez, después de dar el código. */
    checkAfter?: TeamCheck;
    answer?: string | "throws";
    lists?: CatalogLists | null | "throws";
    given?: CodeGiven;
  } = {},
) {
  const calls: string[] = [];
  const reported: string[] = [];
  const answered = <Answer>(label: string) => {
    calls.push(label);
    if (setup.answer === "throws") return Promise.reject(new Error("sin base"));
    return Promise.resolve((setup.answer ?? "ok") as Answer);
  };
  const store = {
    lists: vi.fn(() => {
      calls.push("lists");
      if (setup.lists === "throws") return Promise.reject(new Error("sin base"));
      return Promise.resolve(setup.lists === undefined ? LISTS : setup.lists);
    }),
    add: vi.fn((_claims: VerifiedClaims, list: string, name: string) =>
      answered<string>(`add ${list} ${name}`).then((answer) => ({ answer, id: answer === "added" ? ITEM : null })),
    ),
    rename: vi.fn((_claims: VerifiedClaims, list: string, id: string, name: string) => answered(`rename ${list} ${id} ${name}`)),
    move: vi.fn((_claims: VerifiedClaims, list: string, id: string, direction: string) => answered(`move ${list} ${id} ${direction}`)),
    setActive: vi.fn((_claims: VerifiedClaims, list: string, id: string, active: boolean) => answered(`active ${list} ${id} ${active}`)),
  } as unknown as CatalogStore & { [key: string]: ReturnType<typeof vi.fn> };
  let guards = 0;
  const teamStanding = vi.fn(() => {
    calls.push("guarda");
    guards += 1;
    return Promise.resolve((guards > 1 ? setup.checkAfter : undefined) ?? setup.check ?? teamCheck());
  });
  const giveSecondFactorCode = vi.fn((_jar: unknown, code: string) => {
    calls.push(`código ${code}`);
    return Promise.resolve(setup.given ?? ({ kind: "verified" } as CodeGiven));
  });
  const service = createCatalogLists(
    {
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { teamStanding, giveSecondFactorCode, store },
  );
  return { ...service, calls, reported, store };
}

const reader = { get: () => undefined };
const jar = { get: () => undefined, set: () => undefined };

/** Los cuatro cambios, con algo que tenga forma. */
const ENTRIES: [string, (service: ReturnType<typeof listsWith>) => Promise<{ kind: string }>][] = [
  ["agregar", (service) => service.addItem(reader, { list: "practices", name: "Yoga" })],
  ["renombrar", (service) => service.renameItem(reader, { list: "practices", id: ITEM, name: "Yoga suave" })],
  ["mover", (service) => service.moveItem(reader, { list: "levels", id: ITEM, direction: "up", position: 3 })],
  ["desactivar", (service) => service.setItemActive(reader, { list: "practices", id: ITEM, active: false })],
];

const NOT_ADMITTED: [string, TeamCheck][] = [
  ["sin sesión", { kind: "anonymous" }],
  ["una cuenta común", teamCheck({ state: "none" } as TeamStanding)],
  ["una invitada", teamCheck({ state: "invited", kind: "grant", capabilities: ["content"] } as unknown as TeamStanding)],
  ["alguien a quien se le venció el código", teamCheck({ state: "needs_code", factor: BOUND } as TeamStanding)],
  ["alguien del equipo sin Contenido", teamCheck(standingOf(["config", "support", "finance", "moderation"]))],
];

describe("la guarda va primero en todo cambio", () => {
  describe.each(ENTRIES)("%s", (_name, call) => {
    it.each(NOT_ADMITTED)("a %s no se le pregunta nada más a la base, y no se le dice «prohibido»", async (_who, check) => {
      const service = listsWith({ check });
      expect(await call(service)).toEqual({ kind: "refused" });
      expect(service.calls).toEqual(["guarda"]);
      expect(service.reported).toEqual([]);
    });

    it("si no se supo quién pide, no se intenta nada: la guarda ya lo reportó", async () => {
      const service = listsWith({ check: { kind: "unavailable" } });
      expect(await call(service)).toEqual({ kind: "unavailable" });
      expect(service.calls).toEqual(["guarda"]);
      expect(service.reported).toEqual([]);
    });

    it("si la base no contesta, no se supo, y se reporta", async () => {
      const service = listsWith({ answer: "throws" });
      expect(await call(service)).toEqual({ kind: "unknown" });
      expect(service.reported).toEqual(["catalog_change_unavailable"]);
    });
  });
});

describe("lo que llega se revisa antes de tocar la base", () => {
  it.each<[string, Record<string, unknown>]>([
    ["una lista que no existe", { list: "cursos", name: "Yoga" }],
    ["sin lista", { name: "Yoga" }],
    ["un nombre vacío", { list: "practices", name: "" }],
    ["solo espacios", { list: "practices", name: "   " }],
    ["con un salto de línea", { list: "practices", name: "Tai\nchi" }],
    ["demasiado largo", { list: "practices", name: "a".repeat(CATALOG_NAME_MAX + 1) }],
    ["un nombre que no es texto", { list: "practices", name: 7 }],
  ])("agregar con %s: no llega", async (_what, input) => {
    const service = listsWith();
    expect(await service.addItem(reader, input as never)).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["un id sin forma", { list: "practices", id: "uno", direction: "up", position: 1 }],
    ["un id en mayúsculas", { list: "practices", id: ITEM.toUpperCase(), direction: "up", position: 1 }],
    ["una dirección que no existe", { list: "practices", id: ITEM, direction: "left", position: 1 }],
    ["sin la posición que se vio", { list: "practices", id: ITEM, direction: "up" }],
    ["una posición en texto", { list: "practices", id: ITEM, direction: "up", position: "1" }],
    ["la posición cero", { list: "practices", id: ITEM, direction: "up", position: 0 }],
    ["una posición con decimales", { list: "practices", id: ITEM, direction: "up", position: 1.5 }],
  ])("mover con %s: no llega", async (_what, input) => {
    const service = listsWith();
    expect(await service.moveItem(reader, input as never)).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it.each([undefined, "false", 0, null])("desactivar sin decir si (%j): no llega", async (active) => {
    const service = listsWith();
    expect(await service.setItemActive(reader, { list: "practices", id: ITEM, active })).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("renombrar a un nombre sin forma: no llega", async () => {
    const service = listsWith();
    expect(await service.renameItem(reader, { list: "levels", id: ITEM, name: "" })).toEqual({ kind: "malformed" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("el nombre llega sin espacios a los lados", async () => {
    const service = listsWith({ answer: "added" });
    expect(await service.addItem(reader, { list: "practices", name: "  Yoga  " })).toEqual({ kind: "answered", answer: "added", id: ITEM });
    expect(service.calls).toEqual(["guarda", "add practices Yoga"]);
  });

  it("la forma del nombre es la de la tabla", () => {
    expect(catalogNameOf("a".repeat(CATALOG_NAME_MAX))).toBe("a".repeat(CATALOG_NAME_MAX));
    expect(catalogNameOf(" Meditación guiada ")).toBe("Meditación guiada");
    expect(catalogNameOf("Tai\tchi")).toBeNull();
    expect(CATALOG_NAME_MAX).toBe(40);
  });

  it("el nombre llega en NFC, y sin caracteres de formato que no se ven", () => {
    // «Básico» escrito descompuesto: la b, la a, el acento suelto.
    expect(catalogNameOf("Ba\u0301sico")).toBe("Básico");
    expect(catalogNameOf("Yo\u00adga")).toBeNull();
    expect(catalogNameOf("Yo\u200bga")).toBeNull();
    expect(catalogNameOf("\u202eagoY")).toBeNull();
    expect(catalogNameOf("Yo\ufeffga")).toBeNull();
    // El espacio duro no es de formato: dentro del nombre se queda, y la base lo compara como un espacio.
    expect(catalogNameOf("Tai\u00a0chi")).toBe("Tai\u00a0chi");
  });
});

describe("quien actúa sale de la sesión, y lo que la base contesta sale tal cual", () => {
  it("cada cambio va a nombre de las claims que dio la guarda", async () => {
    const service = listsWith({ answer: "renamed" });
    await service.renameItem(reader, { list: "practices", id: ITEM, name: "Yoga suave" });
    expect(service.store.rename).toHaveBeenCalledExactlyOnceWith(claims, "practices", ITEM, "Yoga suave");
  });

  it.each(["duplicate", "inactive_duplicate", "needs_fresh_code", "forbidden", "invalid"])("agregar contesta %s", async (answer) => {
    const service = listsWith({ answer });
    expect(await service.addItem(reader, { list: "levels", name: "Principiante" })).toEqual({ kind: "answered", answer, id: null });
  });

  it("mover y desactivar le pasan a la base lo que llegó", async () => {
    const service = listsWith({ answer: "moved", lists: WITH_LEVEL });
    expect(await service.moveItem(reader, { list: "levels", id: ITEM, direction: "down", position: 3 })).toEqual({
      kind: "answered",
      answer: "moved",
    });
    expect(await service.setItemActive(reader, { list: "levels", id: ITEM, active: true })).toEqual({ kind: "answered", answer: "moved" });
    expect(service.calls).toEqual(["guarda", "lists", `move levels ${ITEM} down`, "guarda", `active levels ${ITEM} true`]);
  });
});

describe("mover, solo si sigue donde se vio", () => {
  it("relee la lista con las claims de la guarda, y mueve si la posición es la que se vio", async () => {
    const service = listsWith({ answer: "moved", lists: WITH_LEVEL });
    await service.moveItem(reader, { list: "levels", id: ITEM, direction: "up", position: 3 });
    expect(service.store.lists).toHaveBeenCalledExactlyOnceWith(claims);
    expect(service.store.move).toHaveBeenCalledExactlyOnceWith(claims, "levels", ITEM, "up");
  });

  it("si ya se movió (un doble envío, otra pestaña), contesta changed y no mueve", async () => {
    const service = listsWith({ answer: "moved", lists: WITH_LEVEL });
    expect(await service.moveItem(reader, { list: "levels", id: ITEM, direction: "up", position: 4 })).toEqual({ kind: "changed" });
    expect(service.store.move).not.toHaveBeenCalled();
    expect(service.reported).toEqual([]);
  });

  it("la posición se busca en la lista que se pidió, no en la otra", async () => {
    const service = listsWith({ answer: "not_found", lists: WITH_LEVEL });
    expect(await service.moveItem(reader, { list: "practices", id: ITEM, direction: "up", position: 4 })).toEqual({
      kind: "answered",
      answer: "not_found",
    });
  });

  it("una que ya no está la contesta la base: not_found", async () => {
    const service = listsWith({ answer: "not_found" });
    expect(await service.moveItem(reader, { list: "levels", id: ITEM, direction: "up", position: 3 })).toEqual({
      kind: "answered",
      answer: "not_found",
    });
    expect(service.calls).toEqual(["guarda", "lists", `move levels ${ITEM} up`]);
  });

  it("si la lectura es nula (dejó de pasar la puerta), decide la página", async () => {
    const service = listsWith({ answer: "moved", lists: null });
    expect(await service.moveItem(reader, { list: "levels", id: ITEM, direction: "up", position: 3 })).toEqual({ kind: "refused" });
    expect(service.store.move).not.toHaveBeenCalled();
  });

  it("si la lectura no contesta, no se supo, se reporta y no se mueve", async () => {
    const service = listsWith({ answer: "moved", lists: "throws" });
    expect(await service.moveItem(reader, { list: "levels", id: ITEM, direction: "up", position: 3 })).toEqual({ kind: "unknown" });
    expect(service.store.move).not.toHaveBeenCalled();
    expect(service.reported).toEqual(["catalog_change_unavailable"]);
  });
});

describe("dar el código otra vez", () => {
  it.each(NOT_ADMITTED)("a %s no se le verifica nada", async (_who, check) => {
    const service = listsWith({ check });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind: "refused" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("si no se supo quién pide, no se intenta nada", async () => {
    const service = listsWith({ check: { kind: "unavailable" } });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind: "unavailable" });
    expect(service.calls).toEqual(["guarda"]);
  });

  it("verificado, vuelve a pasar por la guarda y lee las listas con esas claims: reciente", async () => {
    const after = { ...claims, issuedAt: 9 } as VerifiedClaims;
    const service = listsWith({ checkAfter: { kind: "team", claims: after, standing: standingOf(["content"]), inProgress: null } });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind: "verified" });
    expect(service.calls).toEqual(["guarda", "código 123456", "guarda", "lists"]);
    expect(service.store.lists).toHaveBeenCalledExactlyOnceWith(after);
    expect(service.reported).toEqual([]);
  });

  it("sirve a quien tiene Contenido y no configuración", async () => {
    const service = listsWith({ check: teamCheck(standingOf(["content"])) });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind: "verified" });
  });

  it.each<[CodeGiven["kind"], string]>([
    ["wrong_code", "wrong_code"],
    ["throttled", "throttled"],
    ["unavailable", "unavailable"],
    ["not_member", "refused"],
    ["signed_out", "refused"],
    ["anonymous", "refused"],
    ["suspended", "refused"],
    ["must_sign_out", "refused"],
  ])("si dar el código contesta %s: %s, sin leer nada", async (given, kind) => {
    const service = listsWith({ given: { kind: given } as CodeGiven });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind });
    expect(service.calls).toEqual(["guarda", "código 123456"]);
  });

  it("si después de verificar la guarda ya no la deja, lo que diga la guarda", async () => {
    const service = listsWith({ checkAfter: teamCheck(standingOf(["config"])) });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind: "refused" });
    expect(service.store.lists).not.toHaveBeenCalled();
  });

  it("si las listas siguen diciendo que no es reciente: es configuración, y se reporta", async () => {
    const service = listsWith({ lists: { ...LISTS, freshCode: false } });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind: "not_available" });
    expect(service.reported).toEqual(["catalog_change_unavailable"]);
  });

  it("si la lectura es nula (perdió Contenido entre medias), decide la página, sin reportar", async () => {
    const service = listsWith({ lists: null });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind: "refused" });
    expect(service.reported).toEqual([]);
  });

  it("si la lectura no contesta: no se puede decir que pase, y se reporta", async () => {
    const service = listsWith({ lists: "throws" });
    expect(await service.giveCatalogCode(jar, "123456")).toEqual({ kind: "not_available" });
    expect(service.reported).toEqual(["catalog_change_unavailable"]);
  });
});

describe("leer las listas", () => {
  it("con las claims que dio la guarda de la sección", async () => {
    const service = listsWith();
    expect(await service.catalogLists(claims)).toEqual({ kind: "lists", lists: LISTS });
    expect(service.store.lists).toHaveBeenCalledExactlyOnceWith(claims);
  });

  it("nula (la sesión dejó de pasar): no se supo, sin reportar", async () => {
    const service = listsWith({ lists: null });
    expect(await service.catalogLists(claims)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual([]);
  });

  it("si la base no contesta, no se supo, y se reporta", async () => {
    const service = listsWith({ lists: "throws" });
    expect(await service.catalogLists(claims)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["catalog_lists_unavailable"]);
  });
});
