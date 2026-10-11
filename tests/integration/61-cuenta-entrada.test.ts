import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "@/adapters/supabase/auth";
import { asSystem } from "@/adapters/supabase/db";
import { loadThrottleParams } from "@/services/account/store";

import {
  agePair,
  claimedUser,
  clearThrottle,
  freshOrigin,
  hitsOf,
  holdLock,
  keysOf,
  notedSessions,
  pairOf,
  seedHits,
  seedPair,
  signInBuckets,
  testServices,
  throttleRows,
} from "./helpers/account";
import {
  authAdmin,
  failingFetch,
  knownUser,
  memoryJar,
  networkDown,
  recordingFetch,
  sessionCount,
  type KnownUser,
} from "./helpers/auth";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Entrar (RF-102; TRD §9.2, filas «Freno progresivo» y «Token de acceso», y §9.9), contra la
// base, el Auth y los parámetros locales. Cada caso empieza con el freno y los contadores
// vacíos y con su propia dirección.

const COOKIE = "plataforma-sesion";
const WRONG = "una-contraseña-que-no-es";

const emails: string[] = [];
let params: Awaited<ReturnType<typeof loadThrottleParams>>;

async function claimed(options: { complete?: boolean } = {}): Promise<KnownUser> {
  const created = await claimedUser();
  emails.push(created.email);
  if (options.complete) await completeAccountAsOwner(created.id);
  return created;
}

async function unclaimed(options: { confirmed?: boolean } = {}): Promise<KnownUser> {
  const created = await knownUser(options);
  emails.push(created.email);
  return created;
}

/** `count` intentos seguidos con la contraseña equivocada, desde la misma dirección. */
async function fail(account: KnownUser, origin = freshOrigin(), count = 1, services = testServices()) {
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(await services.signIn(memoryJar(), { email: account.email, password: WRONG }, origin));
  }
  return { origin, results, keys: keysOf(account.email, origin) };
}

/**
 * Un Auth que detiene la entrada justo después de contestar: el intento ya está contado y
 * la sesión ya existe, pero el servicio todavía no lo sabe. `arrived` avisa que llegó ahí;
 * `release` la deja seguir.
 */
function gatedAuth() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let arrive: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const gated: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input instanceof Request ? input.url : input).includes("/token")) {
      arrive();
      await held;
    }
    return response;
  };
  return { auth: createAuth({ fetch: gated }), arrived, release };
}

beforeAll(async () => {
  params = await asSystem({ reason: "prueba" }, (tx) => loadThrottleParams(tx));
});

beforeEach(async () => {
  await clearThrottle();
});

afterAll(async () => {
  await clearThrottle();
  await deleteTestUsersByEmail(emails);
});

describe("los parámetros del freno", () => {
  // Tres están en minutos y el dominio los quiere en segundos (00-fundamentos §4).
  it("salen de la base, convertidos a segundos y a días", () => {
    expect(params).toEqual({
      threshold: 5,
      baseWaitSeconds: 60,
      maxWaitSeconds: 900,
      forgetAfterSeconds: 3600,
      trustDays: 30,
      hourlyCap: 20,
    });
  });
});

describe("entrar con la contraseña correcta", () => {
  it("abre la sesión, escribe una sola cookie y deja el par sin fallos y de confianza", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const jar = memoryJar();
    const services = testServices();

    const result = await services.signIn(jar, account, origin);

    expect(result).toEqual({ kind: "entered", pending: null });
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0]).toMatchObject({ name: COOKIE, options: { httpOnly: true, sameSite: "lax", path: "/" } });
    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: account.id } });
    expect(await sessionCount(account.id)).toBe(1);
    expect(await notedSessions(account.id)).toBe(1);

    const keys = keysOf(account.email, origin);
    const pair = await pairOf(keys);
    expect(pair).toMatchObject({ failed_count: 0, locked_until: null, last_failed_at: null });
    expect(pair?.last_success_at).toBeInstanceOf(Date);
    // El intento se contó por adelantado y se descontó al entrar: los topes son de fallos.
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(0);
    expect(await hitsOf(signInBuckets(keys).account)).toBe(0);
    expect(services.reported).toEqual([]);
  });

  it("a quien le falta completar su cuenta entra, y se le dice qué le falta", async () => {
    const account = await claimed();
    const jar = memoryJar();
    const result = await testServices().signIn(jar, account, freshOrigin());
    expect(result).toMatchObject({
      kind: "entered",
      pending: { variant: "complete_account", missing: { name: true, adultDeclaration: true } },
    });
    expect(jar.writes).toHaveLength(1);
  });

  it("el correo se normaliza igual que en Auth: mayúsculas y espacios no cambian la cuenta ni el par", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const typed = `  ${account.email.toUpperCase()} `;
    expect(await testServices().signIn(memoryJar(), { email: typed, password: account.password }, origin)).toEqual({
      kind: "entered",
      pending: null,
    });
    expect(await pairOf(keysOf(account.email, origin))).toMatchObject({ failed_count: 0 });
  });

  it("la respuesta nunca sale antes del piso de tiempo, en ningún camino", async () => {
    const account = await claimed({ complete: true });
    const services = testServices();
    await services.signIn(memoryJar(), account, freshOrigin());
    await services.signIn(memoryJar(), { email: account.email, password: WRONG }, freshOrigin());
    await services.signIn(memoryJar(), { email: "no es un correo", password: WRONG }, freshOrigin());
    expect(services.slept).toEqual([500, 500, 500]);
  });
});

describe("no revelar", () => {
  it("contraseña equivocada, correo sin cuenta, sin confirmar y vetada en Auth: la misma respuesta", async () => {
    const account = await claimed({ complete: true });
    const unconfirmed = await unclaimed({ confirmed: false });
    const banned = await claimed({ complete: true });
    await authAdmin().auth.admin.updateUserById(banned.id, { ban_duration: "1h" });
    const services = testServices();

    const results = [
      await services.signIn(memoryJar(), { email: account.email, password: WRONG }, freshOrigin()),
      await services.signIn(memoryJar(), { email: "it-nadie@prueba.test", password: WRONG }, freshOrigin()),
      // Auth distingue estos dos; el servicio no.
      await services.signIn(memoryJar(), unconfirmed, freshOrigin()),
      await services.signIn(memoryJar(), banned, freshOrigin()),
    ];
    for (const result of results) expect(result).toEqual({ kind: "invalid_credentials" });
    expect(services.reported).toEqual([]);
  });

  it("un correo sin forma da lo mismo, y ni se cuenta ni se le pregunta a Auth", async () => {
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    const rows = await throttleRows();
    expect(await services.signIn(memoryJar(), { email: "no es un correo", password: WRONG }, freshOrigin())).toEqual({
      kind: "invalid_credentials",
    });
    expect(spy.calls).toEqual([]);
    expect(await throttleRows()).toBe(rows);
  });

  it("un correo sin cuenta se frena igual que uno con cuenta", async () => {
    const ghost = { id: "", email: "it-fantasma-del-freno@prueba.test", password: WRONG };
    const { origin } = await fail(ghost, freshOrigin(), params.threshold);
    const again = await testServices().signIn(memoryJar(), ghost, origin);
    expect(again.kind).toBe("throttled");
  });
});

describe("el freno progresivo", () => {
  it("los fallos por debajo del umbral no esperan; el del umbral frena y dice hasta cuándo", async () => {
    const account = await claimed({ complete: true });
    const { origin, results, keys } = await fail(account, freshOrigin(), params.threshold);
    for (const result of results) expect(result).toEqual({ kind: "invalid_credentials" });

    const pair = await pairOf(keys);
    expect(pair?.failed_count).toBe(params.threshold);
    expect((pair?.locked_until?.getTime() ?? 0) - (pair?.last_failed_at?.getTime() ?? 0)).toBe(
      params.baseWaitSeconds * 1000,
    );

    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    // Frenado: ni con la contraseña correcta, y ni se le pregunta a Auth.
    const blocked = await services.signIn(memoryJar(), account, origin);
    expect(blocked).toEqual({ kind: "throttled", retryAt: pair?.locked_until });
    expect(spy.calls).toEqual([]);
    // Un intento hecho durante la espera no cuenta: no la alarga.
    expect(await pairOf(keys)).toEqual(pair);
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(params.threshold);
  });

  it("cumplida la espera se puede intentar, y el fallo siguiente la duplica", async () => {
    const account = await claimed({ complete: true });
    const { origin, keys } = await fail(account, freshOrigin(), params.threshold);
    await agePair(keys, params.baseWaitSeconds + 1);

    expect((await fail(account, origin)).results[0]).toEqual({ kind: "invalid_credentials" });
    const pair = await pairOf(keys);
    expect(pair?.failed_count).toBe(params.threshold + 1);
    expect((pair?.locked_until?.getTime() ?? 0) - (pair?.last_failed_at?.getTime() ?? 0)).toBe(
      params.baseWaitSeconds * 2 * 1000,
    );
  });

  it("vive en el par: otra dirección contra la misma cuenta no hereda el freno", async () => {
    const account = await claimed({ complete: true });
    await fail(account, freshOrigin(), params.threshold);
    // Fallar a propósito desde una red no deja fuera a la dueña en la suya.
    expect(await testServices().signIn(memoryJar(), account, freshOrigin())).toEqual({ kind: "entered", pending: null });
  });

  it("tras el olvido sin fallos, la cuenta de fallos vuelve a empezar", async () => {
    const account = await claimed({ complete: true });
    const { origin, keys } = await fail(account, freshOrigin(), params.threshold - 1);
    await agePair(keys, params.forgetAfterSeconds);

    await fail(account, origin);
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, locked_until: null });
  });

  it("entrar bien pone los fallos en cero", async () => {
    const account = await claimed({ complete: true });
    const { origin, keys } = await fail(account, freshOrigin(), params.threshold - 1);
    expect((await testServices().signIn(memoryJar(), account, origin)).kind).toBe("entered");
    expect(await pairOf(keys)).toMatchObject({ failed_count: 0, locked_until: null, last_failed_at: null });
    // Los fallos de antes sí siguen contados en la hora; el intento bueno, no.
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(params.threshold - 1);
  });

  it("dos intentos a la vez del mismo par cuentan dos", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const services = testServices();
    const results = await Promise.all([
      services.signIn(memoryJar(), { email: account.email, password: WRONG }, origin),
      services.signIn(memoryJar(), { email: account.email, password: WRONG }, origin),
    ]);
    expect(results.map((result) => result.kind)).toEqual(["invalid_credentials", "invalid_credentials"]);
    const keys = keysOf(account.email, origin);
    expect((await pairOf(keys))?.failed_count).toBe(2);
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(2);
    expect(await hitsOf(signInBuckets(keys).account)).toBe(2);
  });
});

describe("los topes por hora", () => {
  it("con el tope de la dirección lleno no procede, ni cuenta, ni deja filas, ni le pregunta a Auth", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const keys = keysOf(account.email, origin);
    await seedHits(signInBuckets(keys).ip, params.hourlyCap);
    const rows = await throttleRows();
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });

    expect(await services.signIn(memoryJar(), account, origin)).toEqual({ kind: "capped" });

    expect(spy.calls).toEqual([]);
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(params.hourlyCap);
    expect(await pairOf(keys)).toBeNull();
    expect(await throttleRows()).toBe(rows);
  });

  it("un intento antes del tope todavía procede", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    await seedHits(signInBuckets(keysOf(account.email, origin)).ip, params.hourlyCap - 1);
    expect((await testServices().signIn(memoryJar(), account, origin)).kind).toBe("entered");
  });

  it("con el tope de la cuenta lleno, una dirección nueva no procede", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    await seedHits(signInBuckets(keysOf(account.email, origin)).account, params.hourlyCap);
    expect(await testServices().signIn(memoryJar(), account, origin)).toEqual({ kind: "capped" });
  });

  it("pero el dispositivo de siempre sí: el tope de la cuenta no frena al par que entró bien hace poco", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const keys = keysOf(account.email, origin);
    await seedPair(keys, { last_success_at: new Date(Date.now() - 86_400_000) });
    await seedHits(signInBuckets(keys).account, params.hourlyCap);
    expect((await testServices().signIn(memoryJar(), account, origin)).kind).toBe("entered");
  });

  it("si coinciden el freno y un tope, manda el tope: no promete una hora", async () => {
    const account = await claimed({ complete: true });
    const { origin, keys } = await fail(account, freshOrigin(), params.threshold);
    await ownerQuery(
      "update private.rate_limit_counters set hits = $2 where bucket = $1",
      [signInBuckets(keys).ip, params.hourlyCap],
    );
    expect(await testServices().signIn(memoryJar(), account, origin)).toEqual({ kind: "capped" });
  });
});

describe("la dirección que no se conoce", () => {
  it("sin un alojamiento de fiar, todas las peticiones comparten cubo y nadie queda de confianza", async () => {
    const account = await claimed({ complete: true });
    const services = testServices({ proxyTrusted: () => false });
    const first = freshOrigin();
    const second = freshOrigin();

    await services.signIn(memoryJar(), { email: account.email, password: WRONG }, first);
    await services.signIn(memoryJar(), { email: account.email, password: WRONG }, second);
    // Dos «direcciones» distintas, un solo par y un solo cubo.
    const keys = keysOf(account.email, first, false);
    expect((await pairOf(keys))?.failed_count).toBe(2);
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(2);

    expect((await services.signIn(memoryJar(), account, second)).kind).toBe("entered");
    expect(await pairOf(keys)).toMatchObject({ failed_count: 0, last_success_at: null });
    // En local es lo normal: nadie pone la cabecera.
    expect(services.reported).toEqual([]);
  });

  it("fuera de local es un fallo de operación: se reporta en cada intento", async () => {
    const account = await claimed({ complete: true });
    const services = testServices({ proxyTrusted: () => false, isLocal: () => false });
    expect(await services.signIn(memoryJar(), { email: account.email, password: WRONG }, freshOrigin())).toEqual({
      kind: "invalid_credentials",
    });
    expect(services.reported).toEqual(["client_ip_unknown"]);
  });

  it("con la dirección conocida no se reporta nada, tampoco fuera de local", async () => {
    const account = await claimed({ complete: true });
    const services = testServices({ isLocal: () => false });
    await services.signIn(memoryJar(), { email: account.email, password: WRONG }, freshOrigin());
    expect(services.reported).toEqual([]);
  });
});

describe("lo que ni siquiera se le pregunta a Auth", () => {
  // Más larga de lo que la Plataforma deja fijar: no es la contraseña de nadie.
  it("una contraseña más larga que el máximo no llega a Auth ni se cuenta", async () => {
    const account = await claimed({ complete: true });
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    const jar = memoryJar();
    expect(await services.signIn(jar, { email: account.email, password: "x".repeat(73) }, freshOrigin())).toEqual({
      kind: "invalid_credentials",
    });
    expect(spy.calls).toEqual([]);
    expect(jar.writes).toEqual([]);
    expect(await throttleRows()).toBe(0);
    expect(services.slept).toEqual([500]);
  });
});

describe("cuando el freno no puede contar", () => {
  // Otro intento del mismo cubo va delante y no termina: el candado no se consigue, la
  // transacción vence, y sin poder contar no se le pregunta nada a Auth.
  it.each(["ip", "account"] as const)(
    "si no consigue el candado de la huella (%s), nadie pasa, no se le pregunta a Auth, y se reporta",
    async (which) => {
      const account = await claimed({ complete: true });
      const origin = freshOrigin();
      const keys = keysOf(account.email, origin);
      const spy = recordingFetch();
      const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
      const jar = memoryJar();
      const unlock = await holdLock(keys[which]);
      try {
        expect(await services.signIn(jar, account, origin)).toEqual({ kind: "unavailable" });
      } finally {
        await unlock();
      }
      expect(services.reported).toEqual(["throttle_unavailable"]);
      expect(spy.calls).toEqual([]);
      expect(jar.writes).toEqual([]);
      expect(await throttleRows()).toBe(0);
    },
  );

  // La entrada ya pasó la guarda y quedó anotada cuando el cierre del freno falla: entra
  // igual. El intento queda contado como fallo, que es el lado seguro, y se reporta.
  it("si el cierre del intento falla, quien ya entró entra igual, y se reporta", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const keys = keysOf(account.email, origin);
    const gate = gatedAuth();
    const services = testServices({ auth: gate.auth });
    const jar = memoryJar();

    const pending = services.signIn(jar, account, origin);
    await gate.arrived;
    const unlock = await holdLock(keys.account);
    gate.release();
    let result;
    try {
      result = await pending;
    } finally {
      await unlock();
    }

    expect(result).toEqual({ kind: "entered", pending: null });
    expect(services.reported).toEqual(["sign_in_settle_failed"]);
    expect(await testServices().checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: account.id } });
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, last_success_at: null });
    expect(await hitsOf(signInBuckets(keys).account)).toBe(1);
  });

  // El uno que se sumó por adelantado ya no está (alguien vació la cuenta entre tanto):
  // descontarlo no puede bajar de cero ni tumbar el cierre.
  it("descontar un intento de una cuenta que ya está en cero no falla ni baja de cero", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const keys = keysOf(account.email, origin);
    const gate = gatedAuth();
    const services = testServices({ auth: gate.auth });

    const pending = services.signIn(memoryJar(), account, origin);
    await gate.arrived;
    await ownerQuery("update private.rate_limit_counters set hits = 0");
    gate.release();

    expect((await pending).kind).toBe("entered");
    expect(services.reported).toEqual([]);
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(0);
    expect(await hitsOf(signInBuckets(keys).account)).toBe(0);
    expect(await pairOf(keys)).toMatchObject({ failed_count: 0 });
  });
});

describe("la marca de contraseña y la cuenta", () => {
  // Una contraseña correcta en una cuenta con la marca prendida: quien dio de alta un
  // correo ajeno no entra, y no queda como dispositivo de confianza.
  it("con la marca prendida no entra: va a recuperar, y el intento se cierra como fallo", async () => {
    const account = await unclaimed();
    const origin = freshOrigin();
    const jar = memoryJar();
    expect(await testServices().signIn(jar, account, origin)).toEqual({ kind: "must_recover" });
    expect(jar.writes).toEqual([]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await notedSessions(account.id)).toBe(0);
    const keys = keysOf(account.email, origin);
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, last_success_at: null });
    expect(await hitsOf(signInBuckets(keys).account)).toBe(1);
  });

  it("una sesión que no cabe en la cookie: la contraseña era buena, y la salida es recuperar", async () => {
    const account = await claimed({ complete: true });
    await authAdmin().auth.admin.updateUserById(account.id, { user_metadata: { relleno: "x".repeat(3_000) } });
    const origin = freshOrigin();
    const jar = memoryJar();
    const services = testServices();
    expect(await services.signIn(jar, account, origin)).toEqual({ kind: "must_recover" });
    expect(jar.writes).toEqual([]);
    expect(services.reported).toEqual(["session_oversized"]);
    expect(await sessionCount(account.id)).toBe(0);
    // No se supo si fue un fallo: el tope se descuenta y el par conserva el intento.
    const keys = keysOf(account.email, origin);
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, last_success_at: null });
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(0);
  });
});

describe("cuando la guarda no puede decidir a mitad de una entrada", () => {
  // Auth ya abrió la sesión. Si lo que sigue falla, esa sesión no puede quedar abierta ni
  // su cookie llegar al navegador.
  it("no entra, la sesión se cierra, no se supo, y se reporta", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const jar = memoryJar();
    const services = testServices({
      isLocal: () => {
        throw new Error("no se pudo saber");
      },
    });

    expect(await services.signIn(jar, account, origin)).toEqual({ kind: "unavailable" });

    expect(services.reported).toEqual(["gate_unavailable"]);
    expect(jar.writes).toEqual([]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await notedSessions(account.id)).toBe(0);
    const keys = keysOf(account.email, origin);
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, last_success_at: null });
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(0);
  });

  it("una cuenta sin perfil: lo mismo que una contraseña equivocada, y sin sesión", async () => {
    const account = await claimed();
    await ownerQuery("delete from public.profiles where id = $1", [account.id]);
    const origin = freshOrigin();
    const jar = memoryJar();
    const services = testServices();

    expect(await services.signIn(jar, account, origin)).toEqual({ kind: "invalid_credentials" });

    expect(services.reported).toEqual([]);
    expect(jar.writes).toEqual([]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await pairOf(keysOf(account.email, origin))).toMatchObject({ failed_count: 1, last_success_at: null });
  });
});

describe("cuando la sesión que sobra no se puede cerrar", () => {
  const logoutDown = () => createAuth({ fetch: failingFetch(/\/logout/, networkDown).fetch });

  it("una entrada que no se admite deja su sesión abierta en Auth: se reporta", async () => {
    const account = await unclaimed();
    const services = testServices({ auth: logoutDown() });
    const jar = memoryJar();

    expect(await services.signIn(jar, account, freshOrigin())).toEqual({ kind: "must_recover" });

    expect(jar.writes).toEqual([]);
    expect(services.reported).toEqual(["session_not_closed"]);
    // Nadie tiene sus tokens, y la aplicación no la reconoce.
    expect(await notedSessions(account.id)).toBe(0);
  });

  it("la sesión que el navegador traía: quien entra, entra igual, y se reporta", async () => {
    const ana = await claimed({ complete: true });
    const beto = await claimed({ complete: true });
    const jar = memoryJar();
    expect((await testServices().signIn(jar, ana, freshOrigin())).kind).toBe("entered");

    const services = testServices({ auth: logoutDown() });
    expect((await services.signIn(jar, beto, freshOrigin())).kind).toBe("entered");

    expect(services.reported).toEqual(["session_not_closed"]);
    expect(await testServices().checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: beto.id } });
    expect(await sessionCount(ana.id)).toBe(1);
  });
});

describe("cuando Auth no contesta", () => {
  it("no se supo: nadie entra, los topes se descuentan y el par conserva el intento", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    const jar = memoryJar();
    const down = testServices({ auth: createAuth({ fetch: failingFetch(/\/token/, networkDown).fetch }) });

    expect(await down.signIn(jar, account, origin)).toEqual({ kind: "unavailable" });

    expect(jar.writes).toEqual([]);
    const keys = keysOf(account.email, origin);
    // Quien pudiera hacer que Auth no conteste no puede así probar contraseñas sin acumular.
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, last_success_at: null });
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(0);
    expect(await hitsOf(signInBuckets(keys).account)).toBe(0);
  });
});

describe("la entrada que estaba en vuelo mientras cambiaba la contraseña", () => {
  // Auth abre la sesión sin volver a mirar la cuenta. Aquí la respuesta de Auth se detiene
  // después de que aceptó la contraseña; mientras, la cuenta se reclama de nuevo, que es lo
  // que pasa al recuperar. Esa entrada empezó antes del cambio: no se anota.
  it("no se anota, no deja cookie ni sesión, y cuenta como fallo", async () => {
    const account = await claimed({ complete: true });
    const origin = freshOrigin();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let arrive: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const gated: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input instanceof Request ? input.url : input).includes("/token")) {
        arrive();
        await held;
      }
      return response;
    };
    const services = testServices({ auth: createAuth({ fetch: gated }) });
    const jar = memoryJar();

    const pending = services.signIn(jar, account, origin);
    await arrived;
    const reclaimed = await ownerQuery<{ status: string }>(
      `with actor as (select set_config('app.actor_id', $1, true))
       select private.claim_account() as status from actor`,
      [account.id],
    );
    expect(reclaimed[0]?.status).toBe("already_claimed");
    release();

    expect(await pending).toEqual({ kind: "invalid_credentials" });
    expect(jar.writes).toEqual([]);
    expect(await notedSessions(account.id)).toBe(0);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await pairOf(keysOf(account.email, origin))).toMatchObject({ failed_count: 1, last_success_at: null });

    // Una entrada que empieza después del cambio sí se anota.
    expect((await testServices().signIn(memoryJar(), account, freshOrigin())).kind).toBe("entered");
  });
});

describe("la sesión que el navegador ya traía", () => {
  it("se cierra solo después de que la nueva entró: una contraseña mal tecleada no deja sin sesión", async () => {
    const ana = await claimed({ complete: true });
    const beto = await claimed({ complete: true });
    const jar = memoryJar();
    const services = testServices();
    expect((await services.signIn(jar, ana, freshOrigin())).kind).toBe("entered");

    expect(await services.signIn(jar, { email: beto.email, password: WRONG }, freshOrigin())).toEqual({
      kind: "invalid_credentials",
    });
    expect(await sessionCount(ana.id)).toBe(1);
    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: ana.id } });

    expect((await services.signIn(jar, beto, freshOrigin())).kind).toBe("entered");
    expect(await sessionCount(ana.id)).toBe(0);
    expect(await sessionCount(beto.id)).toBe(1);
    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: beto.id } });
  });
});

describe("salir", () => {
  it("cierra la sesión en Auth y borra la cookie", async () => {
    const account = await claimed({ complete: true });
    const jar = memoryJar();
    const services = testServices();
    await services.signIn(jar, account, freshOrigin());

    expect(await services.signOut(jar)).toBe("closed");
    expect(jar.get(COOKIE)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);
    expect(await services.checkSession(jar)).toEqual({ kind: "anonymous" });
  });
});
