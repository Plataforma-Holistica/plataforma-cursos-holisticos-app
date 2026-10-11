import { describe, expect, it, vi } from "vitest";

import { IdentityUnavailableError } from "./errors";
import { createKeyCache, type Jwk } from "./keys";

// Las claves públicas con las que se verifica un token. El adaptador lleva su propia
// caché para que un token con un identificador de clave inventado no cueste una petición
// al servidor de identidad cada vez: el SDK no recuerda las claves que no existen.

const key = (kid: string): Jwk => ({ kid, alg: "ES256", kty: "EC" });

function setup(responses: (Jwk[] | Error)[]) {
  let time = 1_000_000;
  const fetchKeys = vi.fn(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("la prueba no esperaba otra petición");
    if (next instanceof Error) throw next;
    return next;
  });
  const cache = createKeyCache({ fetchKeys, now: () => time });
  return { cache, fetchKeys, advance: (ms: number) => (time += ms) };
}

describe("caché de claves públicas", () => {
  it("la primera vez las pide, y después contesta de memoria", async () => {
    const { cache, fetchKeys } = setup([[key("a"), key("b")]]);

    expect(await cache.find("a")).toEqual(key("a"));
    expect(await cache.find("b")).toEqual(key("b"));
    expect(await cache.find("a")).toEqual(key("a"));
    expect(fetchKeys).toHaveBeenCalledOnce();
  });

  it("una clave desconocida no vuelve a salir a la red en el siguiente minuto", async () => {
    const { cache, fetchKeys, advance } = setup([[key("a")]]);
    await cache.find("a");

    for (let i = 0; i < 50; i += 1) expect(await cache.find(`inventada-${i}`)).toBeNull();
    advance(59_000);
    expect(await cache.find("otra")).toBeNull();
    expect(fetchKeys).toHaveBeenCalledOnce();
  });

  it("pasado el minuto vuelve a pedirlas una vez: así entra una clave recién rotada", async () => {
    const { cache, fetchKeys, advance } = setup([[key("a")], [key("a"), key("nueva")]]);
    await cache.find("a");
    advance(61_000);

    expect(await cache.find("nueva")).toEqual(key("nueva"));
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it("las claves conocidas se refrescan cada diez minutos", async () => {
    const { cache, fetchKeys, advance } = setup([[key("a")], [key("a")]]);
    await cache.find("a");
    advance(9 * 60_000);
    await cache.find("a");
    expect(fetchKeys).toHaveBeenCalledOnce();

    advance(2 * 60_000);
    await cache.find("a");
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it("muchas peticiones a la vez comparten una sola salida a la red", async () => {
    const { cache, fetchKeys } = setup([[key("a")]]);

    const found = await Promise.all([cache.find("a"), cache.find("a"), cache.find("zzz")]);

    expect(found).toEqual([key("a"), key("a"), null]);
    expect(fetchKeys).toHaveBeenCalledOnce();
  });

  it("sin claves y sin red, no se sabe: no es lo mismo que un token inválido", async () => {
    const { cache } = setup([new Error("sin red")]);

    await expect(cache.find("a")).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  it("si el refresco falla pero la clave ya se conocía, se sigue usando", async () => {
    const { cache, advance } = setup([[key("a")], new Error("sin red")]);
    await cache.find("a");
    advance(11 * 60_000);

    expect(await cache.find("a")).toEqual(key("a"));
  });

  it("tras un fallo, el siguiente intento vuelve a salir: no se queda roto", async () => {
    const { cache, fetchKeys } = setup([new Error("sin red"), [key("a")]]);
    await expect(cache.find("a")).rejects.toBeInstanceOf(IdentityUnavailableError);

    expect(await cache.find("a")).toEqual(key("a"));
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it("una clave conocida no espera al refresco: se contesta y se refresca detrás", async () => {
    let release: (keys: Jwk[]) => void = () => undefined;
    let time = 1_000_000;
    const fetchKeys = vi
      .fn<() => Promise<Jwk[]>>()
      .mockResolvedValueOnce([key("a"), key("retirada")])
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const cache = createKeyCache({ fetchKeys, now: () => time });
    await cache.find("a");
    time += 11 * 60_000;

    // El servidor de identidad no ha contestado, y aun así hay respuesta.
    expect(await cache.find("retirada")).toEqual(key("retirada"));
    expect(fetchKeys).toHaveBeenCalledTimes(2);

    // Cuando contesta, la clave retirada ya no está.
    release([key("a")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(await cache.find("a")).toEqual(key("a"));
    time += 61_000;
    fetchKeys.mockResolvedValueOnce([key("a")]);
    expect(await cache.find("retirada")).toBeNull();
  });

  it("si el refresco de detrás falla, no deja un rechazo suelto", async () => {
    const { cache, advance } = setup([[key("a")], new Error("sin red"), new Error("sin red")]);
    await cache.find("a");
    advance(11 * 60_000);
    expect(await cache.find("a")).toEqual(key("a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.find("a")).toEqual(key("a"));
  });

  describe("distinguir «no existe» de «no se ha vuelto a preguntar»", () => {
    it("recién preguntado y no está: no existe", async () => {
      const { cache } = setup([[key("a")]]);
      expect(await cache.lookup("otra")).toEqual({ kind: "absent" });
    });

    it("preguntado hace menos de un minuto: no se sabe, puede ser una clave recién rotada", async () => {
      const { cache, advance, fetchKeys } = setup([[key("a")]]);
      await cache.find("a");
      advance(30_000);
      expect(await cache.lookup("nueva")).toEqual({ kind: "unchecked" });
      expect(fetchKeys).toHaveBeenCalledOnce();
    });

    it("pasado el minuto se vuelve a preguntar, y entonces sí se sabe", async () => {
      const { cache, advance } = setup([[key("a")], [key("a"), key("nueva")], [key("a"), key("nueva")]]);
      await cache.find("a");
      advance(61_000);
      expect(await cache.lookup("nueva")).toEqual({ kind: "found", key: key("nueva") });
      advance(61_000);
      expect(await cache.lookup("inventada")).toEqual({ kind: "absent" });
    });

    it("una clave conocida se encuentra", async () => {
      const { cache } = setup([[key("a")]]);
      expect(await cache.lookup("a")).toEqual({ kind: "found", key: key("a") });
    });

    it("sin claves y sin red, no se sabe", async () => {
      const { cache } = setup([new Error("sin red")]);
      await expect(cache.lookup("a")).rejects.toBeInstanceOf(IdentityUnavailableError);
    });
  });

  describe("tener las claves a la mano antes de gastar algo", () => {
    it("las pide si nunca las ha pedido, y después no", async () => {
      const { cache, fetchKeys } = setup([[key("a")]]);
      await cache.ready();
      await cache.ready();
      expect(fetchKeys).toHaveBeenCalledOnce();
    });

    it("sin red, lo dice", async () => {
      const { cache } = setup([new Error("sin red")]);
      await expect(cache.ready()).rejects.toBeInstanceOf(IdentityUnavailableError);
    });
  });

  it("ignora lo que no tiene forma de clave", async () => {
    const { cache } = setup([[{ alg: "ES256" } as Jwk, key("a")]]);

    expect(await cache.find("a")).toEqual(key("a"));
    expect(await cache.find("undefined")).toBeNull();
  });
});
