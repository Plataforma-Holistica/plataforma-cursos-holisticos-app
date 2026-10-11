import { afterAll, describe, expect, it } from "vitest";

import { confirmSession, createAuth, readSession, refreshSession, signIn, signOut } from "@/adapters/supabase/auth";
import {
  decodeSessionCookie,
  encodeSessionCookie,
  sessionCookieOptions,
  type SessionTokens,
} from "@/adapters/supabase/auth-cookies";

import {
  authAdmin,
  failingFetch,
  knownUser,
  memoryJar,
  networkDown,
  recordingFetch,
  sessionCount,
  tooManyRequests,
  type KnownUser,
  type MemoryJar,
} from "./helpers/auth";
import { inspectAccessToken } from "@/adapters/supabase/claims";
import { IdentityUnavailableError } from "@/adapters/supabase/errors";

import { deleteTestUsersByEmail } from "./helpers/users";

// El adaptador de Auth, contra el Auth local: entrar, leer la sesión, renovarla y salir
// (TRD §9.2, filas «Token de acceso», «Cierre de sesión» y «Cookies»).
//
// En local el sitio va por http: la cookie se llama `plataforma-sesion` y no es `Secure`.
// La variante de https se prueba sin red, en `auth-cookies.test.ts`.

const COOKIE = "plataforma-sesion";
const MINUTE = 60_000;

// El token dura 15 minutos. Con el reloj 14 adelante le queda menos de lo que hace falta
// para no renovar; con 16, ya venció.
const nearExpiry = () => Date.now() + 14 * MINUTE;
const pastExpiry = () => Date.now() + 16 * MINUTE;
// Vencido para la primera mirada, que es la del token de la cookie, y con la hora de
// verdad después: así el token que trae la renovación no nace vencido para la prueba.
const expiredAtFirstLook = () => {
  let looked = false;
  return () => {
    if (looked) return Date.now();
    looked = true;
    return Date.now() + 16 * MINUTE;
  };
};

const emails: string[] = [];

async function user(options: { confirmed?: boolean } = {}): Promise<KnownUser> {
  const created = await knownUser(options);
  emails.push(created.email);
  return created;
}

/** Una persona con la sesión abierta y su cookie en un tarro. */
async function signedIn(): Promise<{ account: KnownUser; jar: MemoryJar }> {
  const account = await user();
  const jar = memoryJar();
  const entered = await signIn(jar, account.email, account.password);
  if (!entered.ok) throw new Error(`La persona de prueba no entró: ${entered.reason}`);
  jar.writes.length = 0;
  return { account, jar };
}

function tokensIn(jar: MemoryJar): SessionTokens {
  const tokens = decodeSessionCookie(jar.get(COOKIE) ?? "");
  if (!tokens) throw new Error("El tarro no tiene una cookie de sesión que se entienda.");
  return tokens;
}

const jarWithCookie = (value: string) => memoryJar(new Map([[COOKIE, value]]));

/** El mismo token con la firma cambiada: lo que mandaría quien inventa una sesión. */
function forged(tokens: SessionTokens): string {
  const [header, payload, signature = ""] = tokens.accessToken.split(".");
  const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  const value = encodeSessionCookie({ ...tokens, accessToken: `${header}.${payload}.${flipped}` });
  if (!value) throw new Error("No se pudo armar la cookie falsa.");
  return value;
}

const cleared = [{ name: COOKIE, value: "", options: { ...sessionCookieOptions(false), maxAge: 0 } }];

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

describe("entrar", () => {
  it("escribe una sola cookie, con sus atributos, y esa cookie se lee como la sesión de la persona", async () => {
    const account = await user();
    const jar = memoryJar();
    const entered = await signIn(jar, account.email, account.password);

    expect(entered).toMatchObject({ ok: true, claims: { userId: account.id, aal: "aal1" } });
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0]).toMatchObject({
      name: COOKIE,
      options: { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 400 * 24 * 60 * 60 },
    });
    // Una sesión normal ocupa una fracción de lo que cabe.
    expect(jar.writes[0]?.value.length).toBeLessThan(1_500);

    const read = await readSession(jar);
    expect(read).toMatchObject({ kind: "session", claims: { userId: account.id } });
    if (read.kind === "session") {
      expect(read.claims.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Math.abs(read.claims.issuedAt - Date.now())).toBeLessThan(MINUTE);
    }
  });

  it("con la contraseña equivocada no escribe nada", async () => {
    const account = await user();
    const jar = memoryJar();
    expect(await signIn(jar, account.email, "otra-contraseña")).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
    expect(jar.writes).toEqual([]);
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("un correo que no existe da lo mismo que una contraseña equivocada", async () => {
    expect(await signIn(memoryJar(), "it-nadie@prueba.test", "la-que-sea")).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });

  it("sin confirmar el correo: Auth lo dice solo con la contraseña correcta", async () => {
    const account = await user({ confirmed: false });
    expect(await signIn(memoryJar(), account.email, account.password)).toEqual({
      ok: false,
      reason: "email_not_confirmed",
    });
    expect(await signIn(memoryJar(), account.email, "otra-contraseña")).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });

  it("una cuenta suspendida en Auth: lo dice antes de mirar la contraseña", async () => {
    const account = await user();
    await authAdmin().auth.admin.updateUserById(account.id, { ban_duration: "1h" });
    expect(await signIn(memoryJar(), account.email, account.password)).toEqual({ ok: false, reason: "banned" });
    expect(await signIn(memoryJar(), account.email, "otra-contraseña")).toEqual({ ok: false, reason: "banned" });
  });

  it("sin respuesta de Auth, o con su límite de peticiones, no escribe nada", async () => {
    const account = await user();
    const jar = memoryJar();
    const down = createAuth({ fetch: failingFetch(/\/token/, networkDown).fetch });
    expect(await down.signIn(jar, account.email, account.password)).toEqual({ ok: false, reason: "unknown" });
    const limited = createAuth({ fetch: failingFetch(/\/token/, tooManyRequests).fetch });
    expect(await limited.signIn(jar, account.email, account.password)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(jar.writes).toEqual([]);
  });
});

describe("leer la sesión", () => {
  it("sin cookie no hay sesión", async () => {
    expect(await readSession(memoryJar())).toEqual({ kind: "none" });
  });

  it.each([
    ["que no se entiende", "basura"],
    ["de la biblioteca de Supabase", "base64-eyJhY2Nlc3NfdG9rZW4iOiJhIn0"],
    ["con un token que no es un token", "v1.aaa.bbb.ccc.YWJj"],
  ])("una cookie %s no es una sesión", async (_name, value) => {
    expect(await readSession(jarWithCookie(value))).toEqual({ kind: "none" });
  });

  it("una cookie con la firma cambiada no es una sesión", async () => {
    const { jar } = await signedIn();
    expect(await readSession(jarWithCookie(forged(tokensIn(jar))))).toEqual({ kind: "none" });
  });

  it("con el token vencido dice que venció, y no renueva ni escribe", async () => {
    const { jar } = await signedIn();
    const spy = recordingFetch();
    const later = createAuth({ now: pastExpiry, fetch: spy.fetch });

    expect(await later.readSession(jar)).toEqual({ kind: "expired" });
    expect(spy.calls).toEqual([]);
    expect(jar.writes).toEqual([]);
    // Con el reloj de verdad, la misma cookie sigue siendo su sesión.
    expect((await readSession(jar)).kind).toBe("session");
  });

  it("por vencer tampoco renueva: leer no tiene con qué", async () => {
    const { jar } = await signedIn();
    const spy = recordingFetch();
    const later = createAuth({ now: nearExpiry, fetch: spy.fetch });
    expect((await later.readSession(jar)).kind).toBe("session");
    expect(spy.calls).toEqual([]);
    expect(jar.writes).toEqual([]);
  });
});

describe("renovar la sesión", () => {
  it("con el token recién emitido no hace nada", async () => {
    const { account, jar } = await signedIn();
    const spy = recordingFetch();
    const auth = createAuth({ fetch: spy.fetch });
    expect(await auth.refreshSession(jar)).toMatchObject({ kind: "session", claims: { userId: account.id } });
    expect(spy.calls).toEqual([]);
    expect(jar.writes).toEqual([]);
  });

  it("sin cookie no hace nada", async () => {
    const jar = memoryJar();
    expect(await refreshSession(jar)).toEqual({ kind: "none" });
    expect(jar.writes).toEqual([]);
  });

  it("con el token por vencer renueva contra Auth y escribe la cookie nueva", async () => {
    const { account, jar } = await signedIn();
    const before = tokensIn(jar);
    const spy = recordingFetch();
    const auth = createAuth({ now: nearExpiry, fetch: spy.fetch });

    const refreshed = await auth.refreshSession(jar);

    expect(refreshed).toMatchObject({ kind: "session", claims: { userId: account.id } });
    expect(spy.calls).toEqual(["/auth/v1/token?grant_type=refresh_token"]);
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0]).toMatchObject({ name: COOKIE, options: sessionCookieOptions(false) });
    const after = tokensIn(jar);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    // Es la misma sesión de Auth, no una nueva.
    const read = await readSession(jar);
    expect(read).toMatchObject({ kind: "session" });
    if (read.kind === "session" && refreshed.kind === "session") {
      expect(read.claims.sessionId).toBe(refreshed.claims.sessionId);
    }
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("con el token ya vencido también renueva", async () => {
    const { account, jar } = await signedIn();
    const before = tokensIn(jar);
    const refreshed = await createAuth({ now: expiredAtFirstLook() }).refreshSession(jar);
    expect(refreshed).toMatchObject({ kind: "session", claims: { userId: account.id } });
    expect(tokensIn(jar).refreshToken).not.toBe(before.refreshToken);
    expect((await readSession(jar)).kind).toBe("session");
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("dos renovaciones a la vez con la misma cookie sobreviven las dos", async () => {
    const { jar } = await signedIn();
    const other = jar.copy();
    // Dos instancias del servidor: no comparten la salida a la red.
    const [first, second] = await Promise.all([
      createAuth({ now: nearExpiry }).refreshSession(jar),
      createAuth({ now: nearExpiry }).refreshSession(other),
    ]);
    expect(first.kind).toBe("session");
    expect(second.kind).toBe("session");
    // Las dos cookies que quedaron sirven para la siguiente renovación.
    expect((await createAuth({ now: nearExpiry }).refreshSession(jar)).kind).toBe("session");
    expect((await createAuth({ now: nearExpiry }).refreshSession(other)).kind).toBe("session");
  });

  it("en una misma instancia, las renovaciones simultáneas del mismo token salen una sola vez", async () => {
    const { jar } = await signedIn();
    const other = jar.copy();
    const spy = recordingFetch();
    const auth = createAuth({ now: nearExpiry, fetch: spy.fetch });
    const results = await Promise.all([auth.refreshSession(jar), auth.refreshSession(other)]);
    expect(results.map((result) => result.kind)).toEqual(["session", "session"]);
    expect(spy.calls).toHaveLength(1);
    expect(tokensIn(jar)).toEqual(tokensIn(other));
  });

  it.each([
    ["que no se entiende", () => Promise.resolve("basura")],
    ["con un token que no es un token", () => Promise.resolve("v1.aaa.bbb.ccc.YWJj")],
    ["con la firma cambiada", async () => forged(tokensIn((await signedIn()).jar))],
  ])("una cookie %s se borra sin preguntarle a Auth", async (_name, value) => {
    const jar = jarWithCookie(await value());
    const spy = recordingFetch();
    const auth = createAuth({ now: pastExpiry, fetch: spy.fetch });
    expect(await auth.refreshSession(jar)).toEqual({ kind: "none" });
    expect(spy.calls).toEqual([]);
    expect(jar.writes).toEqual(cleared);
  });

  it("con Auth inalcanzable y el token todavía vigente, sigue con la sesión que hay", async () => {
    const { account, jar } = await signedIn();
    const down = createAuth({ now: nearExpiry, fetch: failingFetch(/\/token/, networkDown).fetch });
    expect(await down.refreshSession(jar)).toMatchObject({ kind: "session", claims: { userId: account.id } });
    expect(jar.writes).toEqual([]);
  });

  it("con Auth inalcanzable y el token vencido, no se supo: la cookie queda intacta y no tarda", async () => {
    const { jar } = await signedIn();
    const before = jar.get(COOKIE);
    const down = createAuth({ now: pastExpiry, fetch: failingFetch(/\/token/, networkDown).fetch });

    const started = Date.now();
    expect(await down.refreshSession(jar)).toEqual({ kind: "unknown" });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(jar.writes).toEqual([]);
    expect(jar.get(COOKIE)).toBe(before);
    // Cuando Auth vuelve, la misma cookie renueva.
    expect((await createAuth({ now: expiredAtFirstLook() }).refreshSession(jar)).kind).toBe("session");
    expect(tokensIn(jar).refreshToken).not.toBe(decodeSessionCookie(before ?? "")?.refreshToken);
  });

  it("si Auth tarda más que el tiempo límite, no espera", async () => {
    const { jar } = await signedIn();
    const slow = createAuth({
      now: pastExpiry,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("tiempo", "TimeoutError")));
        }),
    });
    const started = Date.now();
    expect(await slow.refreshSession(jar)).toEqual({ kind: "unknown" });
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(jar.writes).toEqual([]);
  });

  it.each([
    ["el límite de peticiones", tooManyRequests],
    ["un error interno", () => Response.json({ code: "unexpected_failure" }, { status: 500 })],
    ["la página de error de una pasarela", () => new Response("<html>502</html>", { status: 502 })],
    ["un 403 sin código", () => new Response("Forbidden", { status: 403 })],
    ["un 200 que no trae tokens", () => Response.json({ ok: true })],
    ["un código que no se conoce", () => Response.json({ code: "algo_nuevo" }, { status: 400 })],
  ])("con %s la cookie no se borra", async (_name, respond) => {
    const { jar } = await signedIn();
    const failing = createAuth({ now: pastExpiry, fetch: failingFetch(/\/token/, respond).fetch });
    expect(await failing.refreshSession(jar)).toEqual({ kind: "unknown" });
    expect(jar.writes).toEqual([]);
  });

  it("si la renovación trae la sesión de otra cuenta, no la escribe", async () => {
    const { account, jar } = await signedIn();
    const other = await signedIn();
    const theirs = tokensIn(other.jar);
    const swapped = failingFetch(/\/token/, () =>
      Response.json({ access_token: theirs.accessToken, refresh_token: theirs.refreshToken }),
    );
    const auth = createAuth({ now: nearExpiry, fetch: swapped.fetch });

    // Se queda con la sesión que había, mientras su token valga, y no toca la cookie.
    expect(await auth.refreshSession(jar)).toMatchObject({ kind: "session", claims: { userId: account.id } });
    expect(swapped.calls).toHaveLength(1);
    expect(jar.writes).toEqual([]);
  });

  it("si la renovación trae otra sesión de la misma cuenta, tampoco la escribe", async () => {
    const { account, jar } = await signedIn();
    const second = memoryJar();
    await signIn(second, account.email, account.password);
    const theirs = tokensIn(second);
    const swapped = failingFetch(/\/token/, () =>
      Response.json({ access_token: theirs.accessToken, refresh_token: theirs.refreshToken }),
    );
    const auth = createAuth({ now: nearExpiry, fetch: swapped.fetch });
    expect((await auth.refreshSession(jar)).kind).toBe("session");
    expect(jar.writes).toEqual([]);
  });

  it("si el token que trae la renovación no vale, no se supo: la cookie no se toca", async () => {
    const { jar } = await signedIn();
    // Con el reloj fijo 16 minutos adelante, el token nuevo también nace vencido.
    expect(await createAuth({ now: pastExpiry }).refreshSession(jar)).toEqual({ kind: "unknown" });
    expect(jar.writes).toEqual([]);
  });

  it("tras un fallo pasajero, esa instancia no vuelve a salir a la red enseguida", async () => {
    const { jar } = await signedIn();
    const failing = failingFetch(/\/token/, tooManyRequests);
    let clock = Date.now() + 16 * MINUTE;
    const auth = createAuth({ now: () => clock, fetch: failing.fetch });

    await auth.refreshSession(jar);
    await auth.refreshSession(jar);
    expect(failing.calls).toHaveLength(1);

    // Pasada la pausa, vuelve a intentar.
    clock += 11_000;
    await auth.refreshSession(jar);
    expect(failing.calls).toHaveLength(2);
  });

  it("el fallo de una sola sesión no detiene la renovación de las demás", async () => {
    const { jar } = await signedIn();
    const other = await signedIn();
    // Un rechazo que no es de todos: Auth contestó, con un código que no se conoce.
    let rejected = 0;
    const picky: typeof fetch = (input, init) => {
      if (rejected === 0 && String(input).includes("/token")) {
        rejected += 1;
        return Promise.resolve(Response.json({ code: "algo_nuevo", message: "x" }, { status: 400 }));
      }
      return fetch(input, init);
    };
    const auth = createAuth({ now: nearExpiry, fetch: picky });

    await auth.refreshSession(jar);
    expect(jar.writes).toEqual([]);
    // La otra persona renueva enseguida, en la misma instancia.
    expect((await auth.refreshSession(other.jar)).kind).toBe("session");
    expect(other.jar.writes).toHaveLength(1);
  });

  it("con un token de renovación que Auth no conoce, la sesión se perdió y la cookie se borra", async () => {
    const { jar } = await signedIn();
    const tokens = tokensIn(jar);
    const stale = jarWithCookie(encodeSessionCookie({ ...tokens, refreshToken: "zzzzzzzzzzzz" }) ?? "");
    expect(await createAuth({ now: pastExpiry }).refreshSession(stale)).toEqual({ kind: "lost" });
    expect(stale.writes).toEqual(cleared);
  });

  it("una sesión cerrada en otro lado se pierde al renovar", async () => {
    const { jar } = await signedIn();
    const elsewhere = jar.copy();
    expect(await signOut(elsewhere)).toBe("closed");

    // Su token conserva la firma: leerla todavía la da por buena.
    expect((await readSession(jar)).kind).toBe("session");
    expect(await createAuth({ now: nearExpiry }).refreshSession(jar)).toEqual({ kind: "lost" });
    expect(jar.writes).toEqual(cleared);
  });

  it(
    "una cookie atrasada dos renovaciones, usada pasados 10 segundos, pierde su sesión; la que va al día sigue",
    async () => {
      const { account, jar } = await signedIn();
      const old = jar.copy();
      const auth = () => createAuth({ now: nearExpiry });
      expect((await auth().refreshSession(jar)).kind).toBe("session");
      expect((await auth().refreshSession(jar)).kind).toBe("session");

      await new Promise((resolve) => setTimeout(resolve, 10_500));

      // Auth la toma por una cookie copiada y la rechaza. Medido contra el Auth local: no
      // revoca a los demás, así que el navegador que va al día conserva su sesión.
      expect(await createAuth({ now: pastExpiry }).refreshSession(old)).toEqual({ kind: "lost" });
      expect(old.writes).toEqual(cleared);
      expect((await createAuth({ now: expiredAtFirstLook() }).refreshSession(jar)).kind).toBe("session");
      expect(await sessionCount(account.id)).toBe(1);
    },
    30_000,
  );
});

describe("cuando no se puede saber si el token vale", () => {
  // Las claves públicas no se pudieron bajar, o el token dice una clave por la que todavía
  // no se ha vuelto a preguntar (una recién rotada). No es «no hay sesión».
  const blind = [
    ["las claves públicas no se pueden bajar", () => Promise.reject(new IdentityUnavailableError())],
    ["el token dice una clave que no se ha vuelto a preguntar", () => Promise.resolve({ state: "unknown_key" as const })],
  ] as const;

  it.each(blind)("%s: leer contesta que no se supo", async (_name, inspectToken) => {
    const { jar } = await signedIn();
    expect(await createAuth({ inspectToken }).readSession(jar)).toEqual({ kind: "unknown" });
  });

  it.each(blind)("%s: renovar no borra la cookie ni le pregunta a Auth", async (_name, inspectToken) => {
    const { jar } = await signedIn();
    const before = jar.get(COOKIE);
    const spy = recordingFetch();
    const auth = createAuth({ inspectToken, fetch: spy.fetch, now: pastExpiry });

    expect(await auth.refreshSession(jar)).toEqual({ kind: "unknown" });
    expect(jar.writes).toEqual([]);
    expect(jar.get(COOKIE)).toBe(before);
    expect(spy.calls).toEqual([]);
  });

  it.each(blind)("%s: entrar no escribe la cookie, y cierra la sesión que Auth creó", async (_name, inspectToken) => {
    const account = await user();
    const jar = memoryJar();
    expect(await createAuth({ inspectToken }).signIn(jar, account.email, account.password)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(jar.writes).toEqual([]);
    expect(await sessionCount(account.id)).toBe(0);
  });

  it.each(blind)("%s: salir borra la cookie y cierra la sesión igual", async (_name, inspectToken) => {
    const { account, jar } = await signedIn();
    expect(await createAuth({ inspectToken }).signOut(jar)).toBe("closed");
    expect(jar.writes).toEqual(cleared);
    expect(await sessionCount(account.id)).toBe(0);
  });
});

describe("un token firmado con una clave que no se conoce", () => {
  /** El mismo token, diciendo que lo firmó otra clave. */
  function withOtherKey(tokens: SessionTokens): string {
    const [header = "", payload, signature] = tokens.accessToken.split(".");
    const parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>;
    const other = Buffer.from(JSON.stringify({ ...parsed, kid: "una-clave-que-no-existe" })).toString("base64url");
    const value = encodeSessionCookie({ ...tokens, accessToken: `${other}.${payload}.${signature}` });
    if (!value) throw new Error("No se pudo armar la cookie.");
    return value;
  }

  it("recién preguntadas las claves, no se sabe si es inventado o de una clave nueva: la cookie no se borra", async () => {
    // Entrar acaba de usar las claves: se preguntaron hace menos de un minuto.
    const { jar } = await signedIn();
    const odd = jarWithCookie(withOtherKey(tokensIn(jar)));
    const spy = recordingFetch();
    const auth = createAuth({ fetch: spy.fetch });

    expect(await inspectAccessToken(tokensIn(odd).accessToken)).toEqual({ state: "unknown_key" });
    expect(await auth.readSession(odd)).toEqual({ kind: "unknown" });
    expect(await auth.refreshSession(odd)).toEqual({ kind: "unknown" });
    expect(odd.writes).toEqual([]);
    expect(spy.calls).toEqual([]);
  });
});

describe("los límites de tiempo y el margen", () => {
  it("con dos minutos de vida no renueva; con poco más de un minuto, sí", async () => {
    const { jar } = await signedIn();
    const spy = recordingFetch();
    // El token dura 15 minutos y el margen es de 90 segundos.
    await createAuth({ now: () => Date.now() + 13 * MINUTE, fetch: spy.fetch }).refreshSession(jar);
    expect(spy.calls).toEqual([]);
    await createAuth({ now: () => Date.now() + 13.75 * MINUTE, fetch: spy.fetch }).refreshSession(jar);
    expect(spy.calls).toEqual(["/auth/v1/token?grant_type=refresh_token"]);
  });

  it("toda llamada a Auth lleva tiempo límite y no pasa por ninguna caché", async () => {
    const account = await user();
    const seen: { path: string; signal: unknown; cache: unknown }[] = [];
    const watching: typeof fetch = (input, init) => {
      seen.push({ path: new URL(String(input)).pathname, signal: init?.signal, cache: init?.cache });
      return fetch(input, init);
    };
    const auth = createAuth({ fetch: watching, now: nearExpiry });
    const jar = memoryJar();

    await auth.signIn(jar, account.email, account.password);
    await auth.refreshSession(jar);
    await auth.confirmSession(jar);
    await auth.requestPasswordRecovery(account.email);
    await auth.signOut(jar);

    expect(seen.map((call) => call.path)).toEqual([
      "/auth/v1/token",
      "/auth/v1/token",
      "/auth/v1/user",
      "/auth/v1/recover",
      "/auth/v1/logout",
    ]);
    for (const call of seen) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.cache).toBe("no-store");
    }
  });

  it("una respuesta de éxito que no se entiende no cuenta como éxito", async () => {
    const { account, jar } = await signedIn();
    const odd = createAuth({ fetch: failingFetch(/\/logout/, () => new Response("<html>ok</html>")).fetch });
    expect(await odd.signOut(jar)).toBe("unknown");
    expect(await sessionCount(account.id)).toBe(1);
  });
});

describe("preguntarle a Auth si la sesión vive", () => {
  it("una sesión abierta vive; cerrada, ya no, aunque su token todavía verifique", async () => {
    const { jar } = await signedIn();
    const kept = jar.copy();
    expect(await confirmSession(jar)).toBe("alive");

    expect(await signOut(jar)).toBe("closed");

    expect((await readSession(kept)).kind).toBe("session");
    expect(await confirmSession(kept)).toBe("revoked");
  });

  it("sin cookie no hay nada vivo", async () => {
    expect(await confirmSession(memoryJar())).toBe("revoked");
    expect(await confirmSession(jarWithCookie("basura"))).toBe("revoked");
  });

  it("sin respuesta de Auth, no se supo", async () => {
    const { jar } = await signedIn();
    const down = createAuth({ fetch: failingFetch(/\/user/, networkDown).fetch });
    expect(await down.confirmSession(jar)).toBe("unknown");
    const limited = createAuth({ fetch: failingFetch(/\/user/, tooManyRequests).fetch });
    expect(await limited.confirmSession(jar)).toBe("unknown");
  });

  it("cambiar la contraseña por la API de administración la revoca", async () => {
    const { account, jar } = await signedIn();
    await authAdmin().auth.admin.updateUserById(account.id, { password: "otra-contraseña-larga" });
    expect(await confirmSession(jar)).toBe("revoked");
  });
});

describe("salir", () => {
  it("cierra esta sesión, borra su cookie y deja viva la de otro dispositivo", async () => {
    const { account, jar } = await signedIn();
    const other = memoryJar();
    await signIn(other, account.email, account.password);
    expect(await sessionCount(account.id)).toBe(2);

    expect(await signOut(jar)).toBe("closed");

    expect(jar.writes).toEqual(cleared);
    expect(await readSession(jar)).toEqual({ kind: "none" });
    expect(await sessionCount(account.id)).toBe(1);
    expect(await confirmSession(other)).toBe("alive");
  });

  it("con una cookie inventada no le pregunta nada a Auth", async () => {
    const { jar } = await signedIn();
    const fake = jarWithCookie(forged(tokensIn(jar)));
    const spy = recordingFetch();
    expect(await createAuth({ fetch: spy.fetch }).signOut(fake)).toBe("closed");
    expect(spy.calls).toEqual([]);
    expect(fake.writes).toEqual(cleared);
  });

  it("sin cookie no hay nada que cerrar ni que borrar", async () => {
    const jar = memoryJar();
    expect(await signOut(jar)).toBe("closed");
    expect(jar.writes).toEqual([]);
  });

  it("una cookie que no se entiende se borra", async () => {
    const jar = jarWithCookie("basura");
    expect(await signOut(jar)).toBe("closed");
    expect(jar.writes).toEqual(cleared);
  });

  it("aunque Auth no conteste, la cookie se borra; y dice que no se supo", async () => {
    const { account, jar } = await signedIn();
    const down = createAuth({ fetch: failingFetch(/\/logout/, networkDown).fetch });
    expect(await down.signOut(jar)).toBe("unknown");
    expect(jar.writes).toEqual(cleared);
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("con el token vencido renueva primero, para poder cerrar la sesión en Auth", async () => {
    const { account, jar } = await signedIn();
    const spy = recordingFetch();
    const later = createAuth({ now: pastExpiry, fetch: spy.fetch });
    expect(await later.signOut(jar)).toBe("closed");
    expect(spy.calls).toEqual(["/auth/v1/token?grant_type=refresh_token", "/auth/v1/logout?scope=local"]);
    expect(jar.writes).toEqual(cleared);
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("con el token vencido, la sesión se cierra con el token nuevo, no con el vencido", async () => {
    const { account, jar } = await signedIn();
    const old = tokensIn(jar).accessToken;
    // Auth rechaza un token vencido: se simula para el que traía la cookie.
    const picky: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      const isLogout = String(input instanceof Request ? input.url : input).includes("/logout");
      return isLogout && headers.get("authorization") === `Bearer ${old}`
        ? Promise.resolve(Response.json({ code: "bad_jwt", message: "x" }, { status: 403 }))
        : fetch(input, init);
    };
    expect(await createAuth({ now: pastExpiry, fetch: picky }).signOut(jar)).toBe("closed");
    expect(await sessionCount(account.id)).toBe(0);
  });
});
