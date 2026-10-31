import { beforeEach, describe, expect, it, vi } from "vitest";

// La acción de bajar un recurso (RF-308; FL-14; T-404), con la puerta simulada: qué le pasa a la puerta y qué hace con cada
// respuesta. Lo que la puerta hace de verdad lo prueba tests/integration/91-recursos-alumno.test.ts, y los dos canales en un
// navegador, tests/e2e/equipo/recursos.equipo.ts.

const mocks = vi.hoisted(() => ({
  getResourceGrant: vi.fn(),
  cookieJar: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`redirige a ${to}`);
  }),
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/media/media", () => ({ getResourceGrant: mocks.getResourceGrant }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { downloadResourceAction } from "@/app/_catalog/resources/actions";
import { DOWNLOAD_CHANNEL_FIELD, DOWNLOAD_CHANNEL_JS } from "@/app/_catalog/resources/channel";
import type { DownloadState } from "@/app/_catalog/resources/outcomes";

const RESOURCE = "e0000000-0000-4000-8000-000000000006";
const URL = "https://storage/bajar?token=t&download=a.pdf";
const jar = { get: () => undefined, set: () => undefined };
const IDLE: DownloadState = { kind: "idle" };

function form(resource: string | null, javascript: boolean): FormData {
  const data = new FormData();
  if (resource !== null) data.append("do", `download:${resource}`);
  if (javascript) data.append(DOWNLOAD_CHANNEL_FIELD, DOWNLOAD_CHANNEL_JS);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieJar.mockResolvedValue(jar);
  mocks.getResourceGrant.mockResolvedValue({ kind: "granted", url: URL });
});

describe("los dos canales", () => {
  it("con JavaScript la dirección vuelve en el estado, y el navegador la abre: el enrutador no se queda esperando un adjunto", async () => {
    await expect(downloadResourceAction(IDLE, form(RESOURCE, true))).resolves.toEqual({ kind: "granted", url: URL, attempt: 1 });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getResourceGrant).toHaveBeenCalledExactlyOnceWith(jar, RESOURCE);
  });

  it("sin JavaScript redirige: la dirección no vuelve en ningún estado", async () => {
    await expect(downloadResourceAction(IDLE, form(RESOURCE, false))).rejects.toThrow(`redirige a ${URL}`);
  });

  it("un canal que no es el que este código escribe cuenta como sin JavaScript", async () => {
    const data = form(RESOURCE, false);
    data.append(DOWNLOAD_CHANNEL_FIELD, "otra");
    await expect(downloadResourceAction(IDLE, data)).rejects.toThrow(`redirige a ${URL}`);
  });
});

describe("del estado anterior solo se lee el número de intento", () => {
  it("cuenta", async () => {
    const previous: DownloadState = { kind: "granted", url: "https://otra/", attempt: 4 };
    await expect(downloadResourceAction(previous, form(RESOURCE, true))).resolves.toEqual({ kind: "granted", url: URL, attempt: 5 });
  });
});

describe("lo que llega", () => {
  it.each<[string, (data: FormData) => void]>([
    ["sin botón", () => undefined],
    [
      "con dos botones",
      (data) => {
        data.append("do", `download:${RESOURCE}`);
        data.append("do", `download:${RESOURCE}`);
      },
    ],
    ["con otro verbo", (data) => data.append("do", `remove:${RESOURCE}`)],
    ["con algo que no es un identificador", (data) => data.append("do", "download:x")],
    ["con mayúsculas", (data) => data.append("do", `download:${RESOURCE.toUpperCase()}`)],
    ["con algo de más", (data) => data.append("do", `download:${RESOURCE}:x`)],
  ])("%s cuenta como vacío, y no llama a nadie", async (_name, fill) => {
    const data = new FormData();
    fill(data);
    await expect(downloadResourceAction(IDLE, data)).resolves.toEqual(IDLE);
    expect(mocks.getResourceGrant).not.toHaveBeenCalled();
  });

  it("lo que no es un formulario cuenta como vacío", async () => {
    await expect(downloadResourceAction(IDLE, "x" as unknown as FormData)).resolves.toEqual(IDLE);
    expect(mocks.getResourceGrant).not.toHaveBeenCalled();
  });
});

describe("cada respuesta", () => {
  it.each<[string, unknown, DownloadState]>([
    ["no está", { kind: "not_found" }, { kind: "gone", attempt: 1 }],
    ["pidió de más", { kind: "throttled" }, { kind: "throttled", attempt: 1 }],
    ["no se supo", { kind: "unavailable" }, { kind: "unavailable", attempt: 1 }],
    ["la sesión ya no pasa: vuelve a pedir la página, donde decide su guarda", { kind: "refused" }, { kind: "reload", attempt: 1 }],
    ["cuenta suspendida: lo mismo", { kind: "suspended" }, { kind: "reload", attempt: 1 }],
    ["una negativa por suspensión no es PA-33", { kind: "denied", account: { allowed: false, reason: "suspended" } }, { kind: "reload", attempt: 1 }],
  ])("%s", async (_name, grant, state) => {
    mocks.getResourceGrant.mockResolvedValue(grant);
    await expect(downloadResourceAction(IDLE, form(RESOURCE, true))).resolves.toEqual(state);
    // Sin JavaScript, igual: lo único que cambia de canal es la dirección.
    await expect(downloadResourceAction(IDLE, form(RESOURCE, false))).resolves.toEqual(state);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("sin acceso: PA-33, en palabras y con su fecha", async () => {
    mocks.getResourceGrant.mockResolvedValue({ kind: "denied", account: { allowed: false, reason: "never_subscribed" } });
    const never = await downloadResourceAction(IDLE, form(RESOURCE, true));
    expect(never).toMatchObject({ kind: "denied", attempt: 1 });
    expect(never.kind === "denied" && never.text.length).toBeGreaterThan(0);

    mocks.getResourceGrant.mockResolvedValue({ kind: "denied", account: { allowed: false, reason: "expired", endedAt: new Date("2026-09-15T12:00:00.000Z") } });
    const ended = await downloadResourceAction(IDLE, form(RESOURCE, true));
    expect(ended.kind === "denied" && ended.title).toContain("2026");
  });
});
