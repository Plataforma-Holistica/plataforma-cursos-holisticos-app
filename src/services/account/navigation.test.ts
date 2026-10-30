import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  consentsPath,
  entryDestination,
  portalNoticePath,
  homeOf,
  isLessonPath,
  lessonPath,
  periodClosePath,
  periodPath,
  proxySignsIn,
  requiresSession,
  resolveDestination,
  RETURN_PARAM,
  returnsOutsideAdmin,
  ROUTES,
  secondFactorPath,
  SESSION_ROUTES,
  signInPath,
  signUpPath,
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
    // El portal del maestro, y lo que cuelgue de él (T-402).
    ["/portal", true],
    ["/portal/cursos", true],
    ["/portal/cursos/c0000000-0000-4000-8000-000000000001", true],
    ["/portales", false],
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
    // La lección pide sesión (T-203); la ficha del curso, que cuelga de lo mismo, es pública
    // (flujo §6.1). Por eso la lección va por patrón y no por prefijo.
    ["/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002", true],
    ["/cursos/[slug]/lecciones/[leccion]", true],
    ["/cursos", false],
    ["/cursos/respirar", false],
    ["/cursos/respirar/lecciones", false],
    ["/cursos/respirar/lecciones/una/otra", false],
    ["/cursos//lecciones/x", false],
    ["/cursosx/respirar/lecciones/x", false],
  ])("%s: %s", (pathname, expected) => {
    expect(requiresSession(pathname)).toBe(expected);
  });

  it("la lección es la única ruta por patrón, y el paso previo no manda a entrar desde ella", () => {
    expect(isLessonPath("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002")).toBe(true);
    expect(isLessonPath("/cursos/respirar")).toBe(false);
    // A quien llega sin sesión lo manda la guarda de la página: al registro si el curso es el
    // abierto, a entrar si no. El paso previo no lee la base y no sabe cuál.
    expect(proxySignsIn("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002")).toBe(false);
    for (const route of SESSION_ROUTES) expect(proxySignsIn(route), route).toBe(true);
    expect(proxySignsIn("/admin/equipo")).toBe(true);
    expect(proxySignsIn("/cursos/respirar")).toBe(false);
  });

  it("la dirección de una lección se arma con el slug y el id", () => {
    expect(lessonPath("respirar", "b0000000-0000-4000-8000-000000000002")).toBe("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002");
    // Lo que no tiene forma no se pega a una dirección.
    expect(lessonPath("respirar/../x", "b0000000-0000-4000-8000-000000000002")).toBeNull();
    expect(lessonPath("respirar", "no es un id")).toBeNull();
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
    ["/portal/cursos", "/portal/cursos"],
    ["/portal/cursos/c0000000-0000-4000-8000-000000000001?leccion=x", "/portal/cursos/c0000000-0000-4000-8000-000000000001?leccion=x"],
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

describe("a una lección se vuelve después de entrar o de registrarse", () => {
  it("vale como destino, con lo que cuelga de los cursos", () => {
    expect(resolveDestination("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002")).toBe("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002");
    expect(returnOf(signInPath("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002"))).toBe("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002");
  });

  it("el registro guarda el destino igual que entrar", () => {
    expect(signUpPath("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002")).toBe(`/registro?volver=${encodeURIComponent("/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002")}`);
    expect(signUpPath("//otro.example")).toBe("/registro");
    expect(signUpPath(null)).toBe("/registro");
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

  it.each([
    // El estado en el portal del maestro (T-401): sin destino, a lo que le falta, o al portal.
    ["teacher_invited", null, "/portal/invitacion"],
    ["teacher_notice", null, "/portal/aviso"],
    ["teacher", null, "/portal"],
    ["teacher", "//otro.example", "/portal"],
    // Quien pidió una pantalla va a esa pantalla, y su guarda decide.
    ["teacher", "/cuenta", "/cuenta"],
    ["teacher_invited", "/portal/cursos", "/portal/cursos"],
    ["teacher_notice", "/cuenta", "/cuenta"],
  ] as const)("%s con destino %s: %s", (state, returnTo, expected) => {
    expect(entryDestination(state, returnTo)).toBe(expected);
  });

  it("el aviso del maestro dice a dónde sigue", () => {
    expect(portalNoticePath("/portal/cursos?leccion=1")).toBe("/portal/aviso?volver=%2Fportal%2Fcursos%3Fleccion%3D1");
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

describe("las direcciones de un periodo (T-605)", () => {
  it("el periodo va como AAAA-MM, con el mes en dos cifras", () => {
    expect(periodPath(202710)).toBe("/admin/periodos/2027-10");
    expect(periodPath(202701)).toBe("/admin/periodos/2027-01");
    expect(periodClosePath(202612)).toBe("/admin/periodos/2026-12/cierre");
  });
});
