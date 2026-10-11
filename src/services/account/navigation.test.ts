import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  consentsPath,
  homeOf,
  requiresSession,
  resolveDestination,
  RETURN_PARAM,
  ROUTES,
  SESSION_ROUTES,
  signInPath,
} from "./navigation";

const returnOf = (path: string) => new URL(path, "https://plataforma.example").searchParams.get(RETURN_PARAM);

describe("qué rutas piden sesión", () => {
  it.each([
    ["/inicio", true],
    ["/inicio/algo", true],
    ["/consentimientos", true],
    ["/consentimientos/x", true],
    ["/iniciox", false],
    ["/inicio.html", false],
    ["/", false],
    ["/entrar", false],
    ["/registro", false],
    ["/recuperar", false],
    ["/recuperar/abc", false],
    ["/verificar", false],
    ["/verificar/abc", false],
    ["/sesion/cerrar", false],
    ["/legal/terminos", false],
    ["", false],
  ])("%s: %s", (pathname, expected) => {
    expect(requiresSession(pathname)).toBe(expected);
  });

  it("las pantallas de visitante no están en la lista: pedirles sesión encerraría a quien no la tiene", () => {
    for (const route of [ROUTES.landing, ROUTES.signIn, ROUTES.signUp, ROUTES.recover, ROUTES.verify, ROUTES.closeSession]) {
      expect(SESSION_ROUTES).not.toContain(route);
    }
  });
});

describe("a dónde se va después de entrar", () => {
  it("sin destino, al inicio", () => {
    expect(homeOf()).toBe("/inicio");
    expect(resolveDestination(null)).toBe("/inicio");
    expect(resolveDestination(undefined)).toBe("/inicio");
    expect(resolveDestination("")).toBe("/inicio");
  });

  it.each([
    ["/inicio", "/inicio"],
    ["/inicio?pestana=2", "/inicio?pestana=2"],
    ["/inicio/algo", "/inicio/algo"],
    ["/inicio#seccion", "/inicio"],
  ])("un destino permitido se respeta: %s", (input, expected) => {
    expect(resolveDestination(input)).toBe(expected);
  });

  it.each([
    "//otro.example",
    "/\\otro.example",
    "https://otro.example/inicio",
    "/inicio/../../otro",
    "/%2e%2e/inicio",
    "/.//otro.example",
    "/inicio%2F..%2F..",
    "javascript:alert(1)",
    "inicio",
    " /inicio",
    "/iniciox",
    // Rutas propias que no son destino: volver a ellas daría vueltas o no llevaría a nada.
    "/entrar",
    "/registro",
    "/recuperar",
    "/consentimientos",
    "/sesion/cerrar",
    "/",
  ])("lo demás lleva al inicio: %s", (input) => {
    expect(resolveDestination(input)).toBe("/inicio");
  });
});

describe("mandar a entrar o a completar la cuenta, con el destino guardado", () => {
  it("guarda el destino codificado", () => {
    expect(signInPath("/inicio")).toBe("/entrar?volver=%2Finicio");
    expect(consentsPath("/inicio")).toBe("/consentimientos?volver=%2Finicio");
  });

  it("la consulta del destino viaja dentro del destino, no al lado", () => {
    const path = signInPath("/inicio?a=1&volver=%2F%2Fotro.example");
    expect(path).toBe("/entrar?volver=%2Finicio%3Fa%3D1%26volver%3D%252F%252Fotro.example");
    expect([...new URL(path, "https://plataforma.example").searchParams.keys()]).toEqual([RETURN_PARAM]);
  });

  it.each(["//otro.example", "/entrar", "/consentimientos", "/x y", "", null, undefined])(
    "un destino que no vale no se guarda: %s",
    (target) => {
      expect(signInPath(target)).toBe("/entrar");
      expect(consentsPath(target)).toBe("/consentimientos");
    },
  );

  it("lo que se guarda es lo que después se lee", () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9_~-]{1,8}$/);
    const query = fc.stringMatching(/^[A-Za-z0-9_.~=&+-]{0,12}$/);
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 3 }), query, (segments, search) => {
        const target = ["/inicio", ...segments].join("/") + (search === "" ? "" : `?${search}`);
        expect(resolveDestination(returnOf(signInPath(target)))).toBe(target);
        expect(resolveDestination(returnOf(consentsPath(target)))).toBe(target);
      }),
    );
  });

  it("nada de lo que llegue produce un destino fuera de la Plataforma", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const destination = resolveDestination(input);
        expect(destination.startsWith("/inicio")).toBe(true);
        expect(new URL(destination, "https://plataforma.example").origin).toBe("https://plataforma.example");
        expect(new URL(signInPath(input), "https://plataforma.example").pathname).toBe("/entrar");
      }),
    );
  });
});
