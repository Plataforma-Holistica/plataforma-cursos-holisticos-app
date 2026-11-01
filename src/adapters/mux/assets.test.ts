import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/config/env", () => ({ getEnv: () => ({ MUX_TOKEN_ID: "identificador", MUX_TOKEN_SECRET: "secreto" }) }));

import { createMuxAssets } from "./assets";

// El adaptador de los videos en Mux (T-403, tercera solicitud) con `fetch` simulado. Lo que Mux contesta de verdad se midió el 2026-11-01
// contra la cuenta de desarrollo (`PROGRESO.md`): esas respuestas son las que se copian aquí.

const SIGNED = "https://x.supabase.co/storage/v1/object/sign/video-originals/t/c/v?token=FIRMA";
const VIDEO = "33333333-3333-4333-8333-333333333333";
const AUTH = `Basic ${Buffer.from("identificador:secreto").toString("base64")}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchOf = (...answers: (Response | Error)[]) => {
  const fake = vi.fn(() => {
    const next = answers.shift();
    if (next === undefined) return Promise.reject(new Error("Nadie debía pedir esto."));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return fake as unknown as typeof fetch & typeof fake;
};
const sent = (fake: { mock: { calls: unknown[][] } }, call = 0) => fake.mock.calls[call] as [string, RequestInit];

/** Como lo contestó Mux para la prueba real, sin lo que aquí no se lee. */
const asset = (fields: Record<string, unknown> = {}) => ({
  id: "ASSET",
  status: "ready",
  duration: 15,
  passthrough: VIDEO,
  created_at: "1793558175",
  playback_ids: [{ id: "PLAYBACK", policy: "signed" }],
  tracks: [
    { type: "video" },
    { type: "text", status: "ready", language_code: "es", text_source: "generated_vod" },
    { type: "audio", status: "ready" },
  ],
  ...fields,
});

describe("create", () => {
  it("pide exactamente lo que dice el plan: firmado, basic en 1080p, subtítulos en español y el id como passthrough, sin meta", async () => {
    const fake = fetchOf(json({ data: { id: "ASSET" } }, 201));
    expect(await createMuxAssets(fake).create({ url: SIGNED, passthrough: VIDEO })).toBe("ASSET");
    const [url, init] = sent(fake);
    expect(url).toBe("https://api.mux.com/video/v1/assets");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: AUTH, "content-type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      inputs: [{ url: SIGNED, generated_subtitles: [{ language_code: "es", name: "Español (automático)" }] }],
      playback_policies: ["signed"],
      video_quality: "basic",
      max_resolution_tier: "1080p",
      passthrough: VIDEO,
    });
  });

  it("todo lo que no sea un id creado es nulo, sin lanzar: un corte no dice que no lo haya creado, y eso lo decide quien llama", async () => {
    for (const answer of [json({ error: { type: "invalid_parameters", messages: [SIGNED] } }, 400), json({}, 401), json({}, 429), json({}, 500), json({ data: {} }, 201), json({ data: { id: 7 } }, 201), new Error("corte")]) {
      expect(await createMuxAssets(fetchOf(answer)).create({ url: SIGNED, passthrough: VIDEO })).toBeNull();
    }
    expect(await createMuxAssets(fetchOf(new Response("no es json", { status: 201 }))).create({ url: SIGNED, passthrough: VIDEO })).toBeNull();
  });
});

describe("read", () => {
  it("lee el asset y dice lo que el servicio necesita", async () => {
    const fake = fetchOf(json({ data: asset() }));
    expect(await createMuxAssets(fake).read("ASSET")).toEqual({ state: "ready", playback: "PLAYBACK", seconds: 15, captions: true, error: null });
    const [url, init] = sent(fake);
    expect(url).toBe("https://api.mux.com/video/v1/assets/ASSET");
    expect(init.headers).toMatchObject({ authorization: AUTH });
  });

  it("los segundos se redondean hacia arriba: 15.01 s ya cobra el minuto y el segundo que empezó", async () => {
    const read = await createMuxAssets(fetchOf(json({ data: asset({ duration: 15.01 }) }))).read("ASSET");
    expect(read).toMatchObject({ seconds: 16 });
  });

  it("solo una dirección firmada: si Mux diera una pública, no hay reproducción que anotar", async () => {
    const pub = await createMuxAssets(fetchOf(json({ data: asset({ playback_ids: [{ id: "ABIERTA", policy: "public" }] }) }))).read("ASSET");
    expect(pub).toMatchObject({ state: "ready", playback: null });
    const both = await createMuxAssets(fetchOf(json({ data: asset({ playback_ids: [{ id: "ABIERTA", policy: "public" }, { id: "FIRMADA", policy: "signed" }] }) }))).read("ASSET");
    expect(both).toMatchObject({ playback: "FIRMADA" });
    const none = await createMuxAssets(fetchOf(json({ data: asset({ playback_ids: undefined }) }))).read("ASSET");
    expect(none).toMatchObject({ playback: null });
  });

  it("los subtítulos cuentan solo con una pista de texto terminada", async () => {
    const preparing = [{ type: "text", status: "preparing" }];
    const errored = [{ type: "text", status: "errored" }];
    const audioReady = [{ type: "audio", status: "ready" }];
    for (const tracks of [preparing, errored, audioReady, [], undefined]) {
      expect(await createMuxAssets(fetchOf(json({ data: asset({ tracks }) }))).read("ASSET")).toMatchObject({ captions: false });
    }
  });

  it("preparando sigue preparando, y sin duración no hay segundos", async () => {
    const read = await createMuxAssets(fetchOf(json({ data: asset({ status: "preparing", duration: undefined, playback_ids: [] }) }))).read("ASSET");
    expect(read).toEqual({ state: "preparing", playback: null, seconds: null, captions: true, error: null });
  });

  it("una duración que no tiene sentido no es una duración", async () => {
    for (const duration of [0, -1, "15", Number.NaN]) {
      expect(await createMuxAssets(fetchOf(json({ data: asset({ duration }) }))).read("ASSET")).toMatchObject({ seconds: null });
    }
  });

  it("con error dice su tipo, y nada de lo que Mux escribió: sus mensajes pueden traer la dirección firmada", async () => {
    const read = await createMuxAssets(fetchOf(json({ data: asset({ status: "errored", errors: { type: "invalid_input", messages: [SIGNED] } }) }))).read("ASSET");
    expect(read).toEqual({ state: "errored", playback: "PLAYBACK", seconds: 15, captions: true, error: "invalid_input" });
    const odd = await createMuxAssets(fetchOf(json({ data: asset({ status: "errored", errors: { type: SIGNED } }) }))).read("ASSET");
    expect(odd).toMatchObject({ error: "unknown" });
    const bare = await createMuxAssets(fetchOf(json({ data: asset({ status: "errored" }) }))).read("ASSET");
    expect(bare).toMatchObject({ error: "unknown" });
  });

  it("un 404 es que ya no está; lo demás es que no se supo", async () => {
    expect(await createMuxAssets(fetchOf(json({}, 404))).read("ASSET")).toBe("gone");
    // Medido: un id que Mux no reconoce contesta 400, y no dice que el asset se haya ido.
    for (const answer of [json({ error: { type: "invalid_parameters" } }, 400), json({}, 500), json({}, 429), json({ data: { status: "nuevo" } }), json({}), new Error("corte")]) {
      expect(await createMuxAssets(fetchOf(answer)).read("ASSET")).toBeNull();
    }
  });

  it("un id sale escapado en la dirección", async () => {
    const fake = fetchOf(json({}, 404));
    await createMuxAssets(fake).read("a/b?c");
    expect(sent(fake)[0]).toBe("https://api.mux.com/video/v1/assets/a%2Fb%3Fc");
  });
});

describe("findByPassthrough", () => {
  const SINCE = 1_793_000_000;
  const row = (id: string, createdAt: number, passthrough: string | undefined = "otro") => ({ id, created_at: String(createdAt), passthrough });
  const page = (rows: unknown[]) => json({ data: rows });
  const full = (createdAt: number, extra: unknown[] = []) => [...extra, ...Array.from({ length: 100 - extra.length }, (_, i) => row(`relleno-${i}`, createdAt))];

  it("recorre las páginas, del más nuevo al más viejo, y encuentra el suyo", async () => {
    const fake = fetchOf(page(full(SINCE + 100)), page([row("OTRO", SINCE + 50), row("SUYO", SINCE + 40, VIDEO)]));
    expect(await createMuxAssets(fake).findByPassthrough(VIDEO, SINCE)).toEqual(["SUYO"]);
    expect(sent(fake, 0)[0]).toBe("https://api.mux.com/video/v1/assets?limit=100&page=1");
    expect(sent(fake, 1)[0]).toBe("https://api.mux.com/video/v1/assets?limit=100&page=2");
    expect(sent(fake, 0)[1].headers).toMatchObject({ authorization: AUTH });
  });

  it("los junta todos: dos con el mismo passthrough son uno que sobra", async () => {
    const fake = fetchOf(page([row("NUEVO", SINCE + 50, VIDEO), row("VIEJO", SINCE + 40, VIDEO)]));
    expect(await createMuxAssets(fake).findByPassthrough(VIDEO, SINCE)).toEqual(["NUEVO", "VIEJO"]);
  });

  it("una lista vacía dice que no está", async () => {
    expect(await createMuxAssets(fetchOf(page([]))).findByPassthrough(VIDEO, SINCE)).toEqual([]);
  });

  it("deja de pedir al pasar de cuando nació la fila, con una hora de margen por los relojes", async () => {
    const fake = fetchOf(page(full(SINCE - 3601)));
    expect(await createMuxAssets(fake).findByPassthrough(VIDEO, SINCE)).toEqual([]);
    expect(fake).toHaveBeenCalledTimes(1);

    const inside = fetchOf(page(full(SINCE - 3599)), page([]));
    expect(await createMuxAssets(inside).findByPassthrough(VIDEO, SINCE)).toEqual([]);
    expect(inside).toHaveBeenCalledTimes(2);
  });

  it("si no se pudo terminar de buscar es nulo, nunca «no está»: con «no está» se crearía otro y se pagaría dos veces", async () => {
    for (const answer of [json({}, 500), json({}, 429), json({ data: "no" }), json({ data: [{ id: 1 }] }), new Error("corte")]) {
      expect(await createMuxAssets(fetchOf(answer)).findByPassthrough(VIDEO, SINCE)).toBeNull();
    }
    expect(await createMuxAssets(fetchOf(page(full(SINCE + 100)), json({}, 500))).findByPassthrough(VIDEO, SINCE)).toBeNull();
  });

  it("también lo que encontró antes de fallar es nulo: pudo haber otro más adelante", async () => {
    const fake = fetchOf(page(full(SINCE + 100, [row("SUYO", SINCE + 100, VIDEO)])), json({}, 500));
    expect(await createMuxAssets(fake).findByPassthrough(VIDEO, SINCE)).toBeNull();
  });

  it("un asset sin fecha legible no detiene la búsqueda", async () => {
    const odd = { id: "RARO", created_at: "ayer" };
    const fake = fetchOf(page([...full(SINCE + 100).slice(1), odd]), page([]));
    expect(await createMuxAssets(fake).findByPassthrough(VIDEO, SINCE)).toEqual([]);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("tiene tope: pasado el tope no se supo, y no se sigue pidiendo sin fin", async () => {
    const fake = vi.fn(() => Promise.resolve(page(full(SINCE + 100)))) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    expect(await createMuxAssets(fake).findByPassthrough(VIDEO, SINCE)).toBeNull();
    expect(fake).toHaveBeenCalledTimes(50);
  });
});

describe("remove", () => {
  it("borra, y lo que ya no está cuenta como borrado", async () => {
    const fake = fetchOf(new Response(null, { status: 204 }));
    expect(await createMuxAssets(fake).remove("ASSET")).toBe(true);
    const [url, init] = sent(fake);
    expect(url).toBe("https://api.mux.com/video/v1/assets/ASSET");
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ authorization: AUTH });
    expect(await createMuxAssets(fetchOf(json({}, 404))).remove("ASSET")).toBe(true);
  });

  it("lo demás se queda en la papelera: un 400 no dice que se haya ido", async () => {
    for (const answer of [json({}, 400), json({}, 401), json({}, 429), json({}, 500), new Error("corte")]) {
      expect(await createMuxAssets(fetchOf(answer)).remove("ASSET")).toBe(false);
    }
  });
});
