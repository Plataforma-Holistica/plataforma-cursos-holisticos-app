import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  consentsPath,
  entryDestination,
  homeOf,
  requiresSession,
  resolveDestination,
  RETURN_PARAM,
  returnsOutsideAdmin,
  ROUTES,
  secondFactorPath,
  SESSION_ROUTES,
  signInPath,
  teamDestination,
} from "./navigation";

const returnOf = (path: string) => new URL(path, "https://plataforma.example").searchParams.get(RETURN_PARAM);

describe("qué rutas piden sesión", () => {
  it.each([
    ["/inicio", true],
    ["/inicio/algo", true],
    ["/consentimientos", true],
    ["/consentimientos/x", true],
    ["/cuenta", true],
    ["/cuenta/datos", true],
    ["/cuentas", false],
    // Administración, y lo que cuelgue de ella.
    ["/admin", true],
    ["/admin/equipo", true],
    ["/admin/no-existe/tampoco", true],
    ["/administrar", false],
    ["/admin.html", false],
    // Las dos pantallas del segundo factor piden sesión, aunque cuelguen de la de entrar.
    ["/entrar/segundo-factor", true],
    ["/entrar/segundo-factor/configurar", true],
    ["/entrar/segundo-factores", false],
    ["/entrar/otra", false],
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
    ["/cuenta", "/cuenta"],
    ["/cuenta?bloque=nombre", "/cuenta?bloque=nombre"],
    ["/admin", "/admin"],
    ["/admin/equipo", "/admin/equipo"],
    ["/admin/equipo?pagina=2", "/admin/equipo?pagina=2"],
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
    "/cuentas",
    "/cuenta/../entrar",
    "/administrar",
    "/admin/../entrar",
    "/admin//otro.example",
    // Las pantallas del segundo factor son de paso: volver a ellas daría vueltas.
    "/entrar/segundo-factor",
    "/entrar/segundo-factor/configurar",
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
    expect(signInPath("/cuenta")).toBe("/entrar?volver=%2Fcuenta");
    expect(consentsPath("/cuenta")).toBe("/consentimientos?volver=%2Fcuenta");
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
      fc.property(fc.constantFrom("/inicio", "/cuenta", "/admin"), fc.array(segment, { maxLength: 3 }), query, (root, segments, search) => {
        const target = [root, ...segments].join("/") + (search === "" ? "" : `?${search}`);
        expect(resolveDestination(returnOf(signInPath(target)))).toBe(target);
        expect(resolveDestination(returnOf(consentsPath(target)))).toBe(target);
      }),
    );
  });

  it("nada de lo que llegue produce un destino fuera de la Plataforma", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const destination = resolveDestination(input);
        // Solo las tres pantallas a las que se puede volver, o lo que cuelga de ellas.
        expect(destination).toMatch(/^\/(inicio|cuenta|admin)(?:[/?]|$)/);
        expect(new URL(destination, "https://plataforma.example").origin).toBe("https://plataforma.example");
        expect(new URL(signInPath(input), "https://plataforma.example").pathname).toBe("/entrar");
      }),
    );
  });
});

describe("a dónde va quien es del equipo", () => {
  it("las pantallas del segundo factor y administración tienen su ruta", () => {
    expect(ROUTES.secondFactor).toBe("/entrar/segundo-factor");
    expect(ROUTES.factorSetup).toBe("/entrar/segundo-factor/configurar");
    expect(ROUTES.admin).toBe("/admin");
  });

  it("a dar el código se va guardando a dónde se quería ir", () => {
    expect(secondFactorPath("/admin")).toBe("/entrar/segundo-factor?volver=%2Fadmin");
    expect(secondFactorPath("/admin/equipo?pagina=2")).toBe("/entrar/segundo-factor?volver=%2Fadmin%2Fequipo%3Fpagina%3D2");
    expect(secondFactorPath("/cuenta")).toBe("/entrar/segundo-factor?volver=%2Fcuenta");
  });

  it.each(["//otro.example", "/entrar", "/entrar/segundo-factor", "/consentimientos", "", null, undefined])(
    "un destino que no vale no se guarda al ir a dar el código: %s",
    (target) => {
      expect(secondFactorPath(target)).toBe("/entrar/segundo-factor");
    },
  );

  it("con el código dado se va al destino guardado, y sin uno que valga, a administración", () => {
    expect(teamDestination("/admin/equipo")).toBe("/admin/equipo");
    expect(teamDestination("/admin")).toBe("/admin");
    expect(teamDestination("/cuenta")).toBe("/cuenta");
    expect(teamDestination("/inicio?pestana=2")).toBe("/inicio?pestana=2");
    for (const input of [null, undefined, "", "//otro.example", "/entrar", "/entrar/segundo-factor", "/administrar"]) {
      expect(teamDestination(input)).toBe("/admin");
    }
  });

  it("nada de lo que llegue saca de la Plataforma a quien da su código", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(teamDestination(input)).toMatch(/^\/(inicio|cuenta|admin)(?:[/?]|$)/);
        expect(new URL(secondFactorPath(input), "https://plataforma.example").pathname).toBe("/entrar/segundo-factor");
      }),
    );
  });

  it.each([
    ["/inicio", true],
    ["/cuenta", true],
    ["/cuenta?bloque=nombre", true],
    ["/inicio/algo", true],
    // Pedir administración no es pedir otra cosa.
    ["/admin", false],
    ["/admin/equipo", false],
    ["/admin?x=1", false],
    // Lo que no vale como destino tampoco: sin destino, quien es del equipo va a lo suyo.
    ["/administrar", false],
    ["/adminx", false],
    ["//otro.example", false],
    ["/entrar", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("si el destino guardado vale y no es de administración: %s es %s", (input, expected) => {
    expect(returnsOutsideAdmin(input)).toBe(expected);
  });
});

describe("a dónde va quien acaba de entrar, según su estado en el equipo", () => {
  it.each([
    // Quien no es del equipo, y también cuando no se supo: «no se supo» no da nada.
    ["none", null, "/inicio"],
    ["none", "/cuenta", "/cuenta"],
    ["none", "/admin", "/admin"],
    [null, null, "/inicio"],
    [null, "/cuenta", "/cuenta"],
    [null, "/admin/equipo", "/admin/equipo"],
    ["invited_unproven", null, "/entrar/segundo-factor/configurar"],
    ["invited_unproven", "/admin", "/entrar/segundo-factor/configurar"],
    ["invited", null, "/entrar/segundo-factor/configurar"],
    ["invited", "/admin/equipo", "/entrar/segundo-factor/configurar"],
    ["unbound", null, "/entrar/segundo-factor"],
    ["unbound", "/admin", "/entrar/segundo-factor"],
    ["needs_code", null, "/entrar/segundo-factor"],
    ["needs_code", "/admin/equipo?pagina=2", "/entrar/segundo-factor?volver=%2Fadmin%2Fequipo%3Fpagina%3D2"],
    ["needs_code", "//otro.example", "/entrar/segundo-factor"],
    ["member", null, "/admin"],
    ["member", "/admin/equipo", "/admin/equipo"],
    ["member", "/cuenta", "/cuenta"],
  ] as const)("%s con destino %s: %s", (state, returnTo, expected) => {
    expect(entryDestination(state, returnTo)).toBe(expected);
  });

  it.each(["invited_unproven", "invited", "unbound", "needs_code", "member"] as const)(
    "%s que pidió otra pantalla va a esa pantalla: el segundo factor solo se pide en administración",
    (state) => {
      expect(entryDestination(state, "/cuenta")).toBe("/cuenta");
      expect(entryDestination(state, "/inicio?pestana=2")).toBe("/inicio?pestana=2");
    },
  );

  it("nunca manda directo a administración a quien no ha dado su código", () => {
    for (const state of ["invited_unproven", "invited", "unbound", "needs_code"] as const) {
      for (const returnTo of [null, "/admin", "/admin/equipo", "/administrar", "//otro.example"]) {
        expect(entryDestination(state, returnTo), `${state} con ${returnTo}`).toMatch(/^\/entrar\/segundo-factor/);
      }
    }
  });
});
