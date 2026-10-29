import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de PA-89, los textos legales (T-110), con los servicios simulados: qué le pasa
// cada una a su servicio, en qué orden, y qué hace con cada respuesta. Lo que el servicio hace de verdad lo
// prueban `tests/integration/59-textos-legales.test.ts` y la pgTAP 56.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  const unavailable = () => Promise.resolve<unknown>({ kind: "unavailable" });
  return {
    giveLegalCode: logged("giveLegalCode", unavailable),
    publishLegalVersion: logged("publishLegalVersion", unavailable),
    leaveNotice: logged("leaveNotice", () => undefined),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/legal/legal-admin", async () => {
  const { legalBlocks } = await import("@/services/legal/blocks");
  const { createHash: hash } = await import("node:crypto");
  return {
    giveLegalCode: mocks.giveLegalCode,
    publishLegalVersion: mocks.publishLegalVersion,
    legalBlocks,
    bodyFingerprint: (body: string) => hash("sha256").update(body, "utf8").digest("hex"),
  };
});
vi.mock("@/services/account/account", () => ({ signOut: vi.fn(), forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { productDay } from "@/app/_lib/dates";
import { legalAction, legalCodeAction } from "@/app/admin/_textos/actions";
import { legalButton } from "@/app/admin/_textos/outcomes";

const jar = { get: () => undefined, set: () => undefined };
const IDLE = { kind: "idle" } as const;
const BODY = "# Reembolsos\n\nTexto.";
const SHA = createHash("sha256").update(BODY, "utf8").digest("hex");

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}
const today = () => productDay(new Date());
const fields = (over: { title?: string; body?: string; day?: string } = {}): [string, string][] => [
  ["title", over.title ?? " Reembolsos "],
  ["body", over.body ?? BODY],
  ["day", over.day ?? today()],
];

function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("una versión nueva", () => {
  it("«Nueva versión» abre el formulario con el día de hoy, sin llamar a nadie", async () => {
    expect(await legalAction(IDLE, form([["do", legalButton.new("refund_policy", 2)]]))).toEqual({
      kind: "composing",
      draft: { docType: "refund_policy", seen: 2, title: null, body: "", day: today() },
      problems: {},
      changed: false,
      attempt: 1,
    });
    expect(calls.order).toEqual([]);
  });

  it("«Cancelar», o lo que no se entiende, vuelve a la lista sin llamar a nadie", async () => {
    expect(await legalAction(IDLE, form([["do", legalButton.cancel()]]))).toEqual(IDLE);
    expect(await legalAction(IDLE, form([["do", "borrar:terms:1"]]))).toEqual(IDLE);
    expect(calls.order).toEqual([]);
  });

  it("«Ver cómo queda» revisa lo escrito y pinta la vista previa con su huella, sin llamar a nadie", async () => {
    const state = await legalAction({ kind: "composing", attempt: 4 } as never, form([["do", legalButton.preview("refund_policy", 2)], ...fields()]));
    expect(state).toMatchObject({
      kind: "previewing",
      draft: { docType: "refund_policy", seen: 2, title: "Reembolsos", body: BODY, day: today() },
      sha: SHA,
      blocks: [
        { kind: "heading", level: 1, text: "Reembolsos" },
        { kind: "paragraph", text: "Texto." },
      ],
      when: "Rige en cuanto la publiques.",
      failure: null,
      attempt: 5,
    });
    expect(calls.order).toEqual([]);
  });

  it("un día futuro se dice con su fecha", async () => {
    const state = await legalAction(IDLE, form([["do", legalButton.preview("refund_policy", 2)], ...fields({ day: "2099-01-15" })]));
    // Más de un año: no pasa.
    expect(state).toMatchObject({ kind: "composing", problems: { day: "too_far" } });
    const [year, month, day] = today().split("-").map(Number) as [number, number, number];
    const soon = new Date(Date.UTC(year, month - 1, day + 3)).toISOString().slice(0, 10);
    const later = await legalAction(IDLE, form([["do", legalButton.preview("refund_policy", 2)], ...fields({ day: soon })]));
    expect(later).toMatchObject({ kind: "previewing", draft: { day: soon } });
    expect((later as { when: string }).when).toMatch(/^Rige desde el \d{1,2} de [a-z]+ de \d{4}\.$/);
  });

  it("lo que no tiene forma se dice en su campo, con lo escrito", async () => {
    const state = await legalAction(IDLE, form([["do", legalButton.preview("terms", null)], ...fields({ title: "  ", body: "", day: "2000-01-01" })]));
    expect(state).toEqual({
      kind: "composing",
      draft: { docType: "terms", seen: null, title: "  ", body: "", day: "2000-01-01" },
      problems: { title: "required", body: "required", day: "past" },
      changed: false,
      attempt: 1,
    });
    expect(calls.order).toEqual([]);
  });

  it("«Seguir editando» vuelve al formulario con lo escrito", async () => {
    expect(await legalAction(IDLE, form([["do", legalButton.edit("terms", 1)], ...fields()]))).toMatchObject({
      kind: "composing",
      draft: { title: " Reembolsos ", body: BODY },
    });
    expect(calls.order).toEqual([]);
  });
});

describe("publicar", () => {
  const publish = (over: Parameters<typeof fields>[0] = {}, sha = SHA) =>
    legalAction(IDLE, form([["do", legalButton.publish("refund_policy", 2, sha)], ...fields(over)]));

  it("lleva lo escrito ya revisado, la versión vista y la huella de la vista previa; publicado, a la página con su aviso", async () => {
    once("publishLegalVersion", Promise.resolve({ kind: "answered", answer: "published", id: "b0000000-0000-4000-8000-000000000002", version: 3, effectiveFrom: "x" }));
    await expect(publish()).rejects.toThrow("redirige a /admin/textos-legales");
    expect(mocks.publishLegalVersion).toHaveBeenCalledWith(jar, {
      docType: "refund_policy",
      title: "Reembolsos",
      body: BODY,
      day: today(),
      seenVersion: 2,
      seenSha: SHA,
    });
    expect(calls.order).toEqual(["publishLegalVersion", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "legal_published");
  });

  it("lo que no tiene forma no llega al servicio", async () => {
    expect(await publish({ body: " " })).toMatchObject({ kind: "composing", problems: { body: "required" } });
    expect(calls.order).toEqual([]);
  });

  it("alguien publicó antes: al formulario con lo escrito y la versión de ahora, y la página se vuelve a pedir", async () => {
    once("publishLegalVersion", Promise.resolve({ kind: "answered", answer: "changed", version: 5 }));
    expect(await publish()).toMatchObject({ kind: "composing", draft: { seen: 5, body: BODY }, changed: true });
    expect(calls.order).toEqual(["publishLegalVersion", "refresh"]);
  });

  it("el texto cambió desde la vista previa: la vista previa otra vez, con la huella de lo que llegó", async () => {
    once("publishLegalVersion", Promise.resolve({ kind: "preview_stale" }));
    expect(await publish({}, "0".repeat(64))).toMatchObject({ kind: "previewing", sha: SHA, failure: "stale" });
    expect(calls.order).toEqual(["publishLegalVersion"]);
  });

  it("el código ya no es reciente: la vista previa sigue, y la página se vuelve a pedir para pintar «Tu código»", async () => {
    once("publishLegalVersion", Promise.resolve({ kind: "answered", answer: "needs_fresh_code" }));
    expect(await publish()).toMatchObject({ kind: "previewing", failure: "needs_code" });
    expect(calls.order).toEqual(["publishLegalVersion", "refresh"]);
  });

  it("«no se supo»: nunca hecho, y la lista se vuelve a leer", async () => {
    once("publishLegalVersion", Promise.resolve({ kind: "unknown" }));
    expect(await publish()).toEqual({ kind: "failed", reason: "unknown", attempt: 1 });
    expect(calls.order).toEqual(["publishLegalVersion", "refresh"]);
  });

  it("a quien la guarda no deja, a la página: decide su guarda", async () => {
    once("publishLegalVersion", Promise.resolve({ kind: "refused" }));
    await expect(publish()).rejects.toThrow("redirige a /admin/textos-legales");
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });
});

describe("dar el código", () => {
  it("un código sin forma no llega al servicio", async () => {
    expect(await legalCodeAction({ kind: "idle" }, form([["code", "12"]]))).toEqual({ kind: "invalid", problem: "invalid", attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("verificado, a la misma página", async () => {
    once("giveLegalCode", Promise.resolve({ kind: "verified" }));
    await expect(legalCodeAction({ kind: "idle" }, form([["code", "123456"]]))).rejects.toThrow("redirige a /admin/textos-legales");
    expect(mocks.giveLegalCode).toHaveBeenCalledWith(jar, "123456");
  });

  it("equivocado, se dice en el bloque", async () => {
    once("giveLegalCode", Promise.resolve({ kind: "wrong_code" }));
    expect(await legalCodeAction({ kind: "idle" }, form([["code", "123456"]]))).toEqual({ kind: "failed", reason: "wrong_code", attempt: 1 });
  });
});
