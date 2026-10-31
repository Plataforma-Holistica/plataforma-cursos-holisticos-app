import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de PA-48 (T-409), con el servicio simulado: qué le pasan, en qué orden, y qué hacen con cada respuesta. Lo que el servicio hace de
// verdad lo prueban src/services/teachers/tax-profile.test.ts, tests/integration/83-datos-fiscales.test.ts y el extremo a extremo del equipo.

const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  const unknown = () => Promise.resolve<unknown>({ kind: "unavailable" });
  return {
    revealTaxProfile: logged("revealTaxProfile", unknown),
    saveTaxProfile: logged("saveTaxProfile", unknown),
    leaveNotice: logged("leaveNotice", () => undefined),
    signOut: logged("signOut", () => Promise.resolve()),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
    requestOrigin: vi.fn(),
  };
});
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar, requestOrigin: mocks.requestOrigin }));
vi.mock("@/services/teachers/tax-data", () => ({ revealTaxProfile: mocks.revealTaxProfile, saveTaxProfile: mocks.saveTaxProfile }));
vi.mock("@/services/account/account", () => ({ signOut: mocks.signOut, forgetBrowserProofs: vi.fn() }));
vi.mock("@/services/account/notice", () => ({ leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import { revealTaxDataAction, saveTaxDataAction } from "@/app/portal/_fiscal/actions";

const jar = { get: () => undefined, set: () => undefined };
const origin = { ip: "203.0.113.1", userAgent: "prueba" };
const IDLE = { kind: "idle" } as const;
const CLABE = "012180001234567895";
const FIELDS = { rfc: "GODE561231GR8", regime: "626", legal_name: "Elena", clabe: CLABE, seen: "2", password: "la-de-ella" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  mocks.cookieJar.mockResolvedValue(jar);
  mocks.requestOrigin.mockResolvedValue(origin);
});

describe("ver lo guardado", () => {
  it("le pasa al servicio solo la contraseña y la petición", async () => {
    once("revealTaxProfile", { kind: "wrong_password" });
    await expect(revealTaxDataAction(IDLE, form({ password: "la-de-ella", teacher: "de-otro" }))).resolves.toEqual({ kind: "failed", reason: "wrong_password", attempt: 1 });
    expect(mocks.revealTaxProfile).toHaveBeenCalledWith(jar, "la-de-ella", origin);
  });

  it("lo mostrado no vuelve a pedir la página: se quedaría en la lectura de la auditoría sin nada que la pinte", async () => {
    once("revealTaxProfile", { kind: "revealed", data: { rfc: "•••• 1GR8", legalName: "•••• lena", regime: "626", clabe: "•••• 7895", updatedAt: "2026-10-31T18:00:00.000Z" } });
    const state = await revealTaxDataAction(IDLE, form({ password: "la-de-ella" }));
    expect(state).toMatchObject({ kind: "revealed", data: { clabe: "•••• 7895" } });
    expect(calls.order).toEqual(["revealTaxProfile"]);
  });

  it("del estado anterior solo lee el intento", async () => {
    await expect(revealTaxDataAction({ kind: "failed", reason: "unavailable", attempt: 4 }, form({ password: "x" }))).resolves.toMatchObject({ attempt: 5 });
  });

  it("nunca devuelve la contraseña", async () => {
    once("revealTaxProfile", { kind: "wrong_password" });
    expect(JSON.stringify(await revealTaxDataAction(IDLE, form({ password: "la-de-ella" })))).not.toContain("la-de-ella");
  });
});

describe("guardar", () => {
  it("le pasa al servicio lo escrito, la versión vista y la petición", async () => {
    once("saveTaxProfile", { kind: "wrong_password" });
    await saveTaxDataAction(IDLE, form(FIELDS));
    expect(mocks.saveTaxProfile).toHaveBeenCalledWith(jar, { rfc: "GODE561231GR8", regime: "626", legalName: "Elena", clabe: CLABE, seen: 2, password: "la-de-ella" }, origin);
  });

  it("sin una versión vista con forma no llama a nadie: dice que cambió y vuelve a pedir la página", async () => {
    await expect(saveTaxDataAction(IDLE, form({ ...FIELDS, seen: "x" }))).resolves.toEqual({ kind: "failed", reason: "changed", attempt: 1 });
    expect(calls.order).toEqual(["refresh"]);
  });

  it("guardado, deja el aviso y redirige", async () => {
    once("saveTaxProfile", { kind: "saved" });
    await expect(saveTaxDataAction(IDLE, form(FIELDS))).rejects.toThrow("redirige a /portal/datos-fiscales");
    expect(calls.order).toEqual(["saveTaxProfile", "leaveNotice", "redirect"]);
    expect(mocks.leaveNotice).toHaveBeenCalledWith(jar, "tax_data_saved");
  });

  it("una versión que ya no es vuelve a pedir la página, para llevar la de ahora", async () => {
    once("saveTaxProfile", { kind: "changed" });
    await expect(saveTaxDataAction(IDLE, form(FIELDS))).resolves.toEqual({ kind: "failed", reason: "changed", attempt: 1 });
    expect(calls.order).toEqual(["saveTaxProfile", "refresh"]);
  });

  it("ninguna respuesta trae lo escrito", async () => {
    for (const answer of [{ kind: "invalid", problems: { clabe: "length" } }, { kind: "wrong_password" }, { kind: "changed" }, { kind: "unavailable" }, { kind: "throttled", retryAt: new Date() }]) {
      once("saveTaxProfile", answer);
      const text = JSON.stringify(await saveTaxDataAction(IDLE, form(FIELDS)));
      for (const plain of [FIELDS.rfc, FIELDS.legal_name, CLABE, FIELDS.password]) expect(text).not.toContain(plain);
    }
  });
});
