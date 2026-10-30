// En Next 16.3 la utilidad conserva el nombre anterior del paso previo.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config, proxy } from "@/proxy";
import { refreshSession, type CookieJar, type CookieOptions } from "@/services/account/session";

// El paso previo, sin red: qué hace con lo que la renovación le escribe en el tarro. La
// renovación de verdad, contra el Auth local, está en tests/integration/50-proxy.test.ts.

vi.mock("@/services/account/session", () => ({ refreshSession: vi.fn() }));

const refresh = vi.mocked(refreshSession);

const options: CookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 34_560_000 };

// Por omisión, una ruta que no pide sesión: ahí el paso previo solo renueva.
function request(cookies: Record<string, string> = {}, path = "/cursos/yoga", method = "GET"): NextRequest {
  const header = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new NextRequest(`https://plataforma.example${path}`, { method, ...(header ? { headers: { cookie: header } } : {}) });
}

/** Lo que haría la renovación con el tarro que el paso previo le arma. */
function refreshing(act: (jar: CookieJar) => void): void {
  refresh.mockImplementation((jar) => {
    act(jar);
    return Promise.resolve({ kind: "none" });
  });
}

/** Las cookies que la página y la acción de esta petición van a ver. */
const forwarded = (response: Response) => response.headers.get("x-middleware-request-cookie");

beforeEach(() => {
  refresh.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("el paso previo", () => {
  it("si la renovación no escribe nada, deja pasar la petición tal cual", async () => {
    refresh.mockResolvedValue({ kind: "none" });
    const response = await proxy(request({ otra: "1" }));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBeNull();
    expect(forwarded(response)).toBeNull();
  });

  it("el tarro lee las cookies de la petición", async () => {
    const seen: (string | undefined)[] = [];
    refreshing((jar) => seen.push(jar.get("__Host-plataforma-sesion"), jar.get("no-existe")));
    await proxy(request({ "__Host-plataforma-sesion": "v1.a.b.c.cg" }));
    expect(seen).toEqual(["v1.a.b.c.cg", undefined]);
  });

  it("lo que la renovación escribe llega al navegador con sus atributos y a la petición", async () => {
    refreshing((jar) => jar.set("__Host-plataforma-sesion", "v1.nueva.b.c.cg", options));
    const response = await proxy(request({ "__Host-plataforma-sesion": "v1.vieja.b.c.cg", otra: "1" }));

    // Next agrega además la fecha en que vence, calculada de la misma vida.
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-plataforma-sesion=v1\.nueva\.b\.c\.cg; Path=\/; Expires=[^;]+; Max-Age=34560000; Secure; HttpOnly; SameSite=lax$/,
    );
    // La página y la acción de esta misma petición ven la cookie nueva, y las demás siguen.
    expect(forwarded(response)).toBe("__Host-plataforma-sesion=v1.nueva.b.c.cg; otra=1");
    expect(response.headers.get("x-middleware-override-headers")).toContain("cookie");
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("una respuesta que escribe la cookie no se guarda en ninguna caché", async () => {
    refreshing((jar) => jar.set("plataforma-sesion", "v1.a.b.c.cg", { ...options, secure: false }));
    const response = await proxy(request());
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });

  it("sin https la cookie no sale como Secure", async () => {
    refreshing((jar) => jar.set("plataforma-sesion", "v1.a.b.c.cg", { ...options, secure: false }));
    const response = await proxy(request());
    expect(response.headers.get("set-cookie")).toMatch(
      /^plataforma-sesion=v1\.a\.b\.c\.cg; Path=\/; Expires=[^;]+; Max-Age=34560000; HttpOnly; SameSite=lax$/,
    );
  });

  it("un borrado llega al navegador con los mismos atributos y quita la cookie de la petición", async () => {
    refreshing((jar) => jar.set("__Host-plataforma-sesion", "", { ...options, maxAge: 0 }));
    const response = await proxy(request({ "__Host-plataforma-sesion": "v1.vieja.b.c.cg", otra: "1" }));

    // Sin `Secure` y sin `Path=/` el navegador ignoraría el borrado de una cookie `__Host-`.
    expect(response.headers.get("set-cookie")).toBe(
      "__Host-plataforma-sesion=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
    );
    expect(forwarded(response)).toBe("otra=1");
  });

  it("después de escribir, el tarro lee lo que se escribió", async () => {
    const seen: (string | undefined)[] = [];
    refreshing((jar) => {
      jar.set("plataforma-sesion", "primera", options);
      jar.set("plataforma-sesion", "segunda", options);
      seen.push(jar.get("plataforma-sesion"));
    });
    const response = await proxy(request({ "plataforma-sesion": "vieja" }));
    expect(seen).toEqual(["segunda"]);
    expect(forwarded(response)).toBe("plataforma-sesion=segunda");
  });

  it("si la renovación lanza, no lanza: deja pasar sin tocar la cookie y sin decir de quién era", async () => {
    refresh.mockRejectedValue(new Error("ana@prueba.test no pudo renovar v1.secreto"));
    const response = await proxy(request({ "plataforma-sesion": "v1.a.b.c.cg" }));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(forwarded(response)).toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("El paso previo no pudo revisar la sesión.");
  });

  it("si la renovación escribió y después lanzó, lo escrito no sale", async () => {
    refresh.mockImplementation((jar) => {
      jar.set("plataforma-sesion", "a-medias", options);
      return Promise.reject(new Error("a medias"));
    });
    const response = await proxy(request({ "plataforma-sesion": "vieja" }));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(forwarded(response)).toBeNull();
  });

  it("fuera de las rutas con sesión no redirige ni contesta por su cuenta", async () => {
    refresh.mockResolvedValue({ kind: "lost" });
    const response = await proxy(request({}, "/legal/terminos"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

// La redirección optimista (flujo de la app §6.2 y §6.3): ahorra pintar una pantalla a
// quien llega sin sesión. No es el control: la guarda de cada página decide.
describe("la redirección a entrar", () => {
  const location = (response: Response) => response.headers.get("location");

  it("sin sesión, una ruta con sesión manda a entrar y guarda a dónde se iba", async () => {
    refresh.mockResolvedValue({ kind: "none" });
    const response = await proxy(request({}, "/inicio"));
    expect(response.status).toBe(307);
    expect(location(response)).toBe("https://plataforma.example/entrar?volver=%2Finicio");
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("una lección no la manda a entrar: la guarda de la página decide si a entrar o a registrarse", async () => {
    refresh.mockResolvedValue({ kind: "none" });
    const response = await proxy(request({}, "/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002"));
    expect(response.status).toBe(200);
    expect(location(response)).toBeNull();
  });

  it("guarda también la consulta, dentro del destino", async () => {
    refresh.mockResolvedValue({ kind: "none" });
    const response = await proxy(request({}, "/inicio/algo?pestana=2&volver=%2F%2Fotro.example"));
    expect(location(response)).toBe(
      "https://plataforma.example/entrar?volver=%2Finicio%2Falgo%3Fpestana%3D2%26volver%3D%252F%252Fotro.example",
    );
  });

  it("no guarda el parámetro interno con que Next pide una pantalla", async () => {
    refresh.mockResolvedValue({ kind: "none" });
    const response = await proxy(request({}, "/inicio?_rsc=abc12&pestana=2"));
    expect(location(response)).toBe("https://plataforma.example/entrar?volver=%2Finicio%3Fpestana%3D2");
  });

  it("un destino que no se puede guardar no impide mandar a entrar", async () => {
    refresh.mockResolvedValue({ kind: "none" });
    const response = await proxy(request({}, `/inicio?x=${"a".repeat(2_000)}`));
    expect(response.status).toBe(307);
    expect(location(response)).toBe("https://plataforma.example/entrar");
  });

  it("la sesión perdida también manda a entrar, y el borrado de su cookie viaja en la redirección", async () => {
    refresh.mockImplementation((jar) => {
      jar.set("__Host-plataforma-sesion", "", { ...options, maxAge: 0 });
      return Promise.resolve({ kind: "lost" });
    });
    const response = await proxy(request({ "__Host-plataforma-sesion": "v1.vieja.b.c.cg" }, "/consentimientos"));
    expect(response.status).toBe(307);
    // `/consentimientos` no es un destino al que se vuelva: después de entrar decide la guarda.
    expect(location(response)).toBe("https://plataforma.example/entrar");
    expect(response.headers.get("set-cookie")).toBe(
      "__Host-plataforma-sesion=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate, max-age=0");
  });

  it("una redirección no se guarda en caché aunque no escriba nada", async () => {
    refresh.mockResolvedValue({ kind: "none" });
    const response = await proxy(request({}, "/inicio"));
    expect(response.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate, max-age=0");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("con sesión deja pasar: quién entra lo decide la guarda de la página", async () => {
    refresh.mockResolvedValue({ kind: "session", claims: { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 } });
    const response = await proxy(request({ "plataforma-sesion": "v1.a.b.c.cg" }, "/inicio"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(location(response)).toBeNull();
  });

  it("cuando no se supo, no manda a entrar: no es lo mismo que no tener sesión", async () => {
    refresh.mockResolvedValue({ kind: "unknown" });
    const response = await proxy(request({ "plataforma-sesion": "v1.a.b.c.cg" }, "/inicio"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(location(response)).toBeNull();
  });

  it("si la renovación lanza, tampoco: deja pasar", async () => {
    refresh.mockRejectedValue(new Error("sin red"));
    const response = await proxy(request({}, "/inicio"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(location(response)).toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "un envío (%s) nunca se redirige: un 307 lo reenviaría a otra pantalla, y su acción correría ahí",
    async (method) => {
      refresh.mockResolvedValue({ kind: "none" });
      const response = await proxy(request({}, "/inicio", method));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(location(response)).toBeNull();
    },
  );

  it("una petición HEAD se trata como una lectura", async () => {
    refresh.mockResolvedValue({ kind: "none" });
    const response = await proxy(request({}, "/inicio", "HEAD"));
    expect(response.status).toBe(307);
  });

  it.each(["/", "/entrar", "/entrar?volver=%2Finicio", "/registro", "/recuperar", "/recuperar/abc", "/verificar/abc", "/sesion/cerrar", "/iniciox", "/legal/terminos"])(
    "una ruta que no pide sesión no se redirige: %s",
    async (path) => {
      refresh.mockResolvedValue({ kind: "none" });
      const response = await proxy(request({}, path));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(location(response)).toBeNull();
    },
  );
});

describe("el alcance del paso previo", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it.each([
    "/",
    "/entrar",
    "/registro",
    "/verificar/abc",
    "/inicio",
    "/cuenta/sesiones",
    "/portal/cursos/nuevo",
    "/admin",
    "/api/error-drill",
    "/cursos/respiracion.consciente",
    // Terminan como una extensión, pero sin punto: no son archivos.
    "/cursos/masaje-holistico",
    "/cursos/reiki-basico",
    "/portal/historico",
    "/admin/publico",
    "/terapias/svg",
    "/cursos/png",
    "/faviconxico",
    "/_next/data/x/inicio.json",
  ])("cubre %s", (url) => {
    expect(matches(url)).toBe(true);
  });

  it.each([
    "/_next/static/chunks/main.js",
    "/_next/image?url=%2Ffoto.png&w=640&q=75",
    "/favicon.ico",
    "/logo.svg",
    "/portadas/curso.webp",
    "/fuentes/texto.woff2",
  ])("no corre para el archivo estático %s", (url) => {
    expect(matches(url)).toBe(false);
  });
});
