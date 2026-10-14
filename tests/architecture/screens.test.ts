import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { requiresSession } from "@/services/account/navigation";

import { posix, reachableFrom, sourceFiles, src } from "./sources";

// Cuatro cosas de las pantallas que el lint no alcanza a ver (TRD §4.2 y §9.3; flujo de la
// app §6.2):
//
// - Toda página que no es pública llama a la guarda de sesión, y la obedece. El paso previo
//   solo mira si hay cookie: una pantalla nueva que olvide la guarda quedaría abierta sin
//   que nada falle.
// - Toda ruta y todo archivo de acciones de servidor está en una lista, con lo que lo cuida:
//   cada uno es una puerta que se puede llamar directo, sin pasar por ninguna pantalla.
// - Lo que viaja al navegador no arrastra código del servidor ni el catálogo entero.
// - La petición se lee en un solo archivo.
//
// Son comprobaciones sobre el texto del código: atrapan el olvido, no la mala fe. Lo que
// cada puerta hace de verdad lo prueban sus tablas y las pruebas de extremo a extremo.

const app = join(src, "app");

/** El código sin sus comentarios: una llamada escrita en un comentario no es una llamada. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (path: string) => {
  const text = readFileSync(path, "utf8");
  return { path, file: posix(path), text, code: withoutComments(text) };
};
const sources = sourceFiles(app).map(read);
/** Todo el código de la aplicación, no solo sus pantallas. */
const everything = sourceFiles(src).map(read);
const fileNames = sources.map((source) => source.file);
const codeOf = (file: string) => sources.find((source) => source.file === file)?.code ?? "";

/** La dirección que sirve un archivo de `src/app`: sin los grupos entre paréntesis ni el nombre del archivo. */
function routeOf(file: string): string {
  const segments = file.replace(/^src\/app\//, "").split("/").slice(0, -1);
  return `/${segments.filter((segment) => !/^\(.*\)$/.test(segment)).join("/")}`;
}

/** Las páginas que cualquiera ve sin sesión. Una página nueva no es pública hasta que entra aquí. */
const PUBLIC_PAGES = [
  // La portada provisional.
  "src/app/page.tsx",
  // Los textos legales, que cualquiera lee sin sesión.
  "src/app/legal/[documento]/page.tsx",
  // «Revisa tu correo» y «Completa tu cuenta» (PA-14): una cuenta sin verificar no tiene
  // sesión, y el enlace del correo se abre en cualquier navegador.
  "src/app/(cuenta)/verificar/page.tsx",
  "src/app/(cuenta)/verificar/[token]/page.tsx",
  // Recuperar la contraseña (PA-13): quien la olvidó puede tener o no una sesión abierta.
  "src/app/(cuenta)/recuperar/page.tsx",
  "src/app/(cuenta)/recuperar/[token]/page.tsx",
  // La muestra de componentes, que solo existe con `pnpm dev`.
  "src/app/muestra/page.dev.tsx",
  "src/app/muestra/error/page.dev.tsx",
];

/** Las rutas, y lo que cada una tiene que llamar para no ser una puerta abierta. */
const ROUTE_HANDLERS: Record<string, RegExp> = {
  // El simulacro del registro de errores: no existe en producción.
  "src/app/api/error-drill/route.ts": /if \(!errorDrillAllowed\(\)\) return new Response\(null, \{ status: 404 \}\);/,
  // La medición de la cabecera de la dirección: tampoco existe en producción.
  "src/app/api/origin-drill/route.ts": /if \(!errorDrillAllowed\(\)\) return new Response\(null, \{ status: 404 \}\);/,
  // Cierra una sesión solo si la guarda la rechaza: eso lo decide el servicio.
  "src/app/sesion/cerrar/route.ts": /closedSessionRoute\(await closeRejectedSession\(jar\)\)/,
};

/**
 * Las acciones de servidor, archivo por archivo y una por una, con lo que el cuerpo de cada
 * una tiene que llamar. Todo lo que exportan se puede llamar directo: la autorización es del
 * servicio, no de la pantalla.
 *
 * Cada expresión se busca dentro de su función y de ninguna otra, y un archivo no puede
 * exportar una acción que no esté aquí. Atrapan el olvido y el renombre: que una acción deje
 * de pasar por su servicio, o que aparezca una puerta nueva sin que nadie la mire. Lo que
 * cada acción hace con cada respuesta lo prueban `tests/actions/` y sus tablas.
 */
const SERVER_ACTIONS: Record<string, Record<string, RegExp>> = {
  "src/app/(cuenta)/entrar/actions.ts": {
    // Entrar es de visitante: el servicio cuenta el intento, le pregunta a Auth y corre la guarda.
    signInAction: /await signIn\(jar, \{ email, password \}, await requestOrigin\(\)\)[\s\S]*return leaveFor\(jar, outcome\);/,
  },
  "src/app/(cuenta)/entrar/segundo-factor/actions.ts": {
    // Dar el código: lo que no tiene forma de código no llega al servicio, que corre la
    // guarda y verifica contra el factor que dice la base. Del formulario no llega ningún factor.
    giveCodeAction:
      /if \(problem\) return \{ kind: "invalid", problem, attempt \};[\s\S]*giveCodeOutcome\(await giveSecondFactorCode\(jar, code\), returnTo\)[\s\S]*return leaveFor\(jar, outcome\);/,
  },
  "src/app/(cuenta)/entrar/segundo-factor/configurar/actions.ts": {
    // Empezar: del formulario no se lee nada. El servicio corre la guarda y solo da de alta
    // un factor a quien tiene una invitación que puede aceptar y el buzón probado.
    startSecondFactorAction: /startOutcome\(await startSecondFactor\(jar\)\)[\s\S]*return leaveFor\(jar, outcome\);/,
    // Confirmar: lo que no tiene forma de código no llega al servicio. El factor que se ata
    // es el que el servidor anotó: lo pintado solo viaja para compararse.
    confirmSecondFactorAction:
      /if \(fields\) return \{ kind: "invalid", fields, attempt \};[\s\S]*confirmOutcome\(await confirmSecondFactor\(jar, \{ code, handoff, painted \}\), handoff\)[\s\S]*return leaveFor\(jar, outcome\);/,
  },
  "src/app/(cuenta)/consentimientos/actions.ts": {
    // Completar la cuenta: el servicio vuelve a correr la guarda antes de escribir nada.
    completeAccountAction: /await completeAccount\(\s*jar,[\s\S]*return leaveFor\(jar, outcome\);/,
  },
  "src/app/(cuenta)/cuenta/actions.ts": {
    // Cambiar el nombre: el servicio vuelve a correr la guarda, y del formulario solo llega el nombre.
    changeNameAction: /changeNameOutcome\(await changeName\(jar, \{ name: input\.name \}\)\)[\s\S]*return leaveFor\(jar, outcome\);/,
    // Cerrar sesiones: del formulario solo llega qué botón se pulsó. De quién es la cuenta y
    // cuál sesión se queda lo dice la sesión de quien envía, y lo decide el servicio.
    closeSessionsAction:
      /closeOthersOutcome\(await closeOtherSessions\(jar\)\)\s*: closeSessionOutcome\(await closeSession\(jar, \{ sessionId: request\.sessionId \}\)\);[\s\S]*return leaveFor\(jar, outcome\);/,
    // Cambiar la contraseña: del formulario solo llegan las dos contraseñas. De quién es la
    // cuenta lo dice la sesión, y el servicio comprueba la actual por el freno de intentos.
    changePasswordAction:
      /changePasswordOutcome\(await changePassword\(jar, input, await requestOrigin\(\)\)\)[\s\S]*return leaveFor\(jar, outcome\);/,
  },
  "src/app/(cuenta)/registro/actions.ts": {
    // Pedir el registro: el servicio cuenta el intento y aplica los topes antes de invitar a nadie.
    requestRegistrationAction:
      /mailRequestOutcome\(await requestRegistration\(\{ email \}, await requestOrigin\(\)\)\)[\s\S]*return leaveFor\(jar, \{ to: ROUTES\.verify, notice: null \}\);/,
  },
  "src/app/(cuenta)/verificar/actions.ts": {
    // Reenviar: el mismo servicio, con el correo que este navegador tiene anotado.
    resendAction:
      /const pending = readRegistration\(jar\);\s*if \(pending === null\) return leaveFor\([\s\S]*mailRequestOutcome\(await requestRegistration\(\{ email: pending\.email \}, await requestOrigin\(\)\)\)/,
    // «Ese no es mi correo»: no le pide nada a ningún servicio. Olvida la cookie y se va.
    notMyEmailAction: /^[^\n]*\{\s*const jar = await cookieJar\(\);\s*forgetRegistration\(jar\);\s*return leaveFor\(jar, \{ to: ROUTES\.signUp, notice: null \}\);\s*\}\s*$/,
  },
  "src/app/(cuenta)/verificar/[token]/actions.ts": {
    // Completar la cuenta desde el enlace: lo que no tiene forma de enlace no llega al servicio.
    completeRegistrationAction:
      /if \(!isLinkToken\(input\.token\)\) return \{ kind: "link_dead" \};[\s\S]*await completeRegistration\(\s*jar,[\s\S]*forgetRegistration\(jar\);\s*return leaveFor\(jar, outcome\);/,
  },
  "src/app/(cuenta)/recuperar/actions.ts": {
    // Pedir la recuperación: el servicio contesta lo mismo exista o no la cuenta.
    requestRecoveryAction: /mailRequestOutcome\(await requestRecovery\(\{ email \}, await requestOrigin\(\)\)\)/,
  },
  "src/app/(cuenta)/recuperar/[token]/actions.ts": {
    // Cambiar la contraseña desde el enlace: lo que no tiene forma de enlace no llega al servicio.
    completeRecoveryAction:
      /if \(!isLinkToken\(input\.token\)\) return \{ kind: "link_dead" \};[\s\S]*await completeRecovery\(\{ tokenHash: input\.token, password: input\.password \}, await requestOrigin\(\), jar\)[\s\S]*return leaveFor\(jar, outcome\);/,
  },
  "src/app/(cuenta)/_lib/session-actions.ts": {
    // Salir: solo usa la cookie de quien pide.
    // Cierra la sesión y, con el mismo tarro, se lleva las pruebas de ese navegador.
    signOutAction: /const jar = await cookieJar\(\);\s+await signOut\(jar\);\s+forgetBrowserProofs\(jar\);/,
  },
  "src/app/admin/equipo/actions.ts": {
    // Dar el código otra vez: lo que no tiene forma de código no llega al servicio, que corre
    // la guarda y verifica contra el factor que dice la base.
    freshCodeAction:
      /if \(problem\) return \{ kind: "invalid", problem, attempt \};[\s\S]*freshCodeOutcome\(await giveFreshCode\(jar, code\)\)[\s\S]*return leaveFor\(jar, outcome\);/,
    // Invitar: del formulario llegan el correo y las capacidades. Quién invita lo dice la sesión.
    inviteAction:
      /if \(problems\) return \{ kind: "invalid", \.\.\.input, problems, attempt \};[\s\S]*inviteOutcome\(await inviteAdmin\(jar, input\)\)[\s\S]*return leaveFor\(jar, outcome\);/,
    // Dar y quitar: del formulario solo llega qué botón se pulsó. Preguntar no llama a nadie,
    // y quitar lleva lo que se confirmó, para que el servicio lo compruebe.
    teamAction:
      /if \(request\.step === "ask"\) return \{ kind: "confirm", intent, changed: false, attempt \};[\s\S]*grantOutcome\(await grantCapability\(jar, \{ profile: intent\.profile, capability: intent\.capability \}\)\)\s*: revokeOutcome\(await revokeCapability\(jar, \{ profile: intent\.profile, capability: intent\.capability, confirmed: request\.confirmed \}\)\);[\s\S]*return leaveFor\(jar, outcome\);/,
    // Revocar e invitar de nuevo: del formulario solo llega cuál invitación.
    invitationsAction:
      /if \(request\.step === "ask"\) return \{ kind: "confirm", id: request\.id, attempt \};[\s\S]*revokeInvitationOutcome\(await revokeInvitation\(jar, \{ id: request\.id \}\)\)\s*: reinviteOutcome\(await reinviteAdmin\(jar, \{ id: request\.id \}\)\);[\s\S]*return leaveFor\(jar, outcome\);/,
    // Restablecer: el primer envío deja el testigo; el segundo lleva lo que se confirmó.
    resetAction:
      /prepareResetOutcome\(await prepareReset\(jar, \{ profile \}\)\)\s*: resetOutcome\(await resetSecondFactor\(jar, \{ profile, confirmed: request\.confirmed \}\)\);[\s\S]*return leaveFor\(jar, outcome\);/,
  },
};

/** El texto de una función exportada de un archivo de acciones: de su `export` a la llave que la cierra. */
function actionBody(code: string, name: string): string {
  const start = code.indexOf(`export async function ${name}(`);
  if (start < 0) return "";
  const end = code.indexOf("\n}\n", start);
  return end < 0 ? code.slice(start) : code.slice(start, end + 2);
}

const GUARD_IMPORT = /import \{[^}]*\} from "@\/app\/_lib\/guard";/;
const SESSION_GUARD = /= await (requireSession|requireIncompleteSession|requireAdmin|requireSecondFactor|requireFactorSetup)\(/;
const VISITOR_GUARD = /^\s*await visitorOnly\(\);$/m;

/**
 * Las pantallas del equipo, cada una con la guarda que le toca. Las tres le preguntan a la
 * base quién es del equipo; la guarda de sesión a secas dejaría entrar a cualquier cuenta.
 * Una página que cuelgue de administración y no esté aquí usa la de administración.
 */
const TEAM_GUARDS: Record<string, string> = {
  "/entrar/segundo-factor": "requireSecondFactor",
  "/entrar/segundo-factor/configurar": "requireFactorSetup",
};
const teamGuardOf = (route: string): string | null =>
  TEAM_GUARDS[route] ?? (route === "/admin" || route.startsWith("/admin/") ? "requireAdmin" : null);

describe("toda página pasa por la guarda o está en la lista de públicas", () => {
  // Next sirve como página todo `page` con las extensiones de `pageExtensions`.
  const pages = fileNames.filter((file) => /\/page(\.dev)?\.tsx?$/.test(file));
  const guarded = pages.filter((file) => !PUBLIC_PAGES.includes(file));

  it("hay páginas que revisar, de las dos clases", () => {
    expect(pages).toContain("src/app/page.tsx");
    expect(guarded).toContain("src/app/inicio/page.tsx");
    expect(guarded).toContain("src/app/(cuenta)/entrar/page.tsx");
  });

  it("la lista de públicas no nombra páginas que ya no existen, ni rutas que piden sesión", () => {
    for (const file of PUBLIC_PAGES) {
      expect(pages).toContain(file);
      expect(requiresSession(routeOf(file)), file).toBe(false);
    }
  });

  it("sabe qué dirección sirve cada archivo", () => {
    expect(routeOf("src/app/page.tsx")).toBe("/");
    expect(routeOf("src/app/inicio/page.tsx")).toBe("/inicio");
    expect(routeOf("src/app/(cuenta)/consentimientos/page.tsx")).toBe("/consentimientos");
    expect(routeOf("src/app/(cuenta)/cuenta/page.tsx")).toBe("/cuenta");
    expect(routeOf("src/app/(cuenta)/verificar/[token]/page.tsx")).toBe("/verificar/[token]");
  });

  it.each(guarded)("%s llama a la guarda que le toca", (file) => {
    const code = codeOf(file);
    expect(code).toMatch(GUARD_IMPORT);
    if (requiresSession(routeOf(file))) {
      // Una pantalla con sesión guarda lo que la guarda contesta y pinta sus dos estados:
      // llamarla y no obedecerla dejaría ver la pantalla a una cuenta suspendida.
      expect(code).toMatch(SESSION_GUARD);
      expect(code).toMatch(/\.kind === "suspended"\) return </);
      expect(code).toMatch(/\.kind === "unavailable"\) return </);
      expect(code).not.toMatch(VISITOR_GUARD);
    } else {
      expect(code).toMatch(VISITOR_GUARD);
    }
  });

  it("toda ruta que pide sesión tiene su página revisada: ninguna se sirve sin pasar por aquí", () => {
    const sessionPages = guarded.filter((file) => requiresSession(routeOf(file))).map(routeOf);
    expect(sessionPages.sort()).toEqual([
      "/admin",
      "/admin/[...resto]",
      "/admin/equipo",
      "/consentimientos",
      "/cuenta",
      "/entrar/segundo-factor",
      "/entrar/segundo-factor/configurar",
      "/inicio",
    ]);
  });

  describe("las pantallas del equipo usan su propia guarda", () => {
    const teamPages = guarded.filter((file) => teamGuardOf(routeOf(file)) !== null);

    it("hay pantallas del equipo que revisar, y la lista no nombra rutas que no existen", () => {
      expect(teamPages.map(routeOf)).toEqual(expect.arrayContaining(Object.keys(TEAM_GUARDS)));
      for (const route of Object.keys(TEAM_GUARDS)) expect(requiresSession(route), route).toBe(true);
    });

    it("sabe qué guarda le toca a cada ruta", () => {
      expect(teamGuardOf("/entrar/segundo-factor")).toBe("requireSecondFactor");
      expect(teamGuardOf("/admin")).toBe("requireAdmin");
      expect(teamGuardOf("/admin/equipo")).toBe("requireAdmin");
      expect(teamGuardOf("/admin/[...resto]")).toBe("requireAdmin");
      expect(teamGuardOf("/administrar")).toBeNull();
      expect(teamGuardOf("/inicio")).toBeNull();
      expect(teamGuardOf("/entrar")).toBeNull();
    });

    it.each(teamPages)("%s llama a la guarda del equipo que le toca, y a ninguna otra", (file) => {
      const code = codeOf(file);
      const called = [...code.matchAll(/\bawait (require\w+|visitorOnly)\(/g)].map((match) => match[1]);
      expect(called).toEqual([teamGuardOf(routeOf(file))]);
      // No le pregunta al servicio por su cuenta: eso es de la guarda.
      expect(code).not.toMatch(/\bcheckSession\b|\bteamStanding\b/);
      // Y la guarda es lo primero que la página espera, salvo leer su dirección: ningún otro
      // servicio corre antes de saber quién pide.
      const body = code.slice(code.indexOf("export default async function"));
      const awaited = [...body.matchAll(/\bawait \(?([\w.]+)/g)].map((match) => match[1]);
      expect(awaited.filter((name) => name !== "searchParams" && name !== "params")[0]).toBe(teamGuardOf(routeOf(file)));
      // Sin límites de espera: lo de abajo se pintaría antes de que la guarda conteste, y un
      // «no existe» dicho después ya no llegaría con su estado.
      expect(code).not.toMatch(/\bSuspense\b/);
    });

    it.each(teamPages)("%s no exporta su título: no debe poder asomarse en la respuesta de «no existe»", (file) => {
      expect(codeOf(file)).not.toMatch(/export (const metadata|(async )?function generateMetadata)\b/);
    });

    describe("bajo administración, toda ruta le contesta lo mismo a quien no es del equipo", () => {
      const under = sources.filter((source) => source.file.startsWith("src/app/admin/"));

      it("hay un comodín que atiende lo que no tiene página, y corre la guarda antes de decir que no existe", () => {
        const wildcard = codeOf("src/app/admin/[...resto]/page.tsx");
        expect(wildcard).toMatch(/const step = await requireAdmin\(path\);[\s\S]*\n\s*notFound\(\);\n\}/);
        // La guarda va antes: si dijera «no existe» primero, la ruta que existe y la que no se distinguirían.
        expect(wildcard.indexOf("requireAdmin(path)")).toBeLessThan(wildcard.lastIndexOf("notFound()"));
      });

      it("no hay rutas, ni pantallas de carga, ni límites de espera: pintarían o contestarían antes que la guarda", () => {
        expect(under.map((source) => source.file).filter((file) => /\/(route|loading|layout|template|default|error|not-found)\.tsx?$/.test(file))).toEqual([]);
        expect(under.filter((source) => /\bSuspense\b/.test(source.code)).map((source) => source.file)).toEqual([]);
      });

      it("ninguna página de administración es pública", () => {
        expect(PUBLIC_PAGES.filter((file) => file.startsWith("src/app/admin/"))).toEqual([]);
        const pagesUnder = under.map((source) => source.file).filter((file) => /\/page(\.dev)?\.tsx?$/.test(file));
        expect(pagesUnder.sort()).toEqual(["src/app/admin/[...resto]/page.tsx", "src/app/admin/equipo/page.tsx", "src/app/admin/page.tsx"]);
        for (const file of pagesUnder) expect(teamPages).toContain(file);
      });
    });

    it("las demás pantallas con sesión no usan una guarda del equipo: el segundo factor solo se pide en administración", () => {
      const others = guarded.filter((file) => teamGuardOf(routeOf(file)) === null);
      for (const file of others) {
        expect(codeOf(file), file).not.toMatch(/\b(requireAdmin|requireSecondFactor|requireFactorSetup)\(/);
      }
    });
  });

  it("una página pública no finge pasar por la guarda", () => {
    for (const file of PUBLIC_PAGES) {
      expect(codeOf(file)).not.toMatch(SESSION_GUARD);
      expect(codeOf(file)).not.toMatch(VISITOR_GUARD);
    }
  });

  it("no hay armazones ni plantillas además del de la raíz: pintarían antes que la guarda de su página", () => {
    const frames = fileNames.filter((file) => /\/(layout|template|default|loading)\.tsx?$/.test(file));
    expect(frames).toEqual(["src/app/layout.tsx"]);
  });
});

describe("toda ruta está en la lista, con lo que la cuida", () => {
  const routes = fileNames.filter((file) => /\/route\.tsx?$/.test(file));

  it("no hay rutas fuera de la lista ni la lista nombra rutas que no existen", () => {
    expect(routes.sort()).toEqual(Object.keys(ROUTE_HANDLERS).sort());
  });

  it.each(Object.entries(ROUTE_HANDLERS))("%s", (file, guard) => {
    expect(codeOf(file)).toMatch(guard);
  });

  it.each(Object.keys(ROUTE_HANDLERS))("%s solo atiende lecturas: lo que cambia algo es una acción de servidor", (file) => {
    const methods = [...codeOf(file).matchAll(/export (?:async )?function ([A-Z]+)\(/g)].map((match) => match[1]);
    expect(methods.filter((method) => method !== "GET" && method !== "HEAD")).toEqual([]);
    expect(methods).toContain("GET");
    // Tampoco exportado de otra forma: como constante, o con otro nombre.
    expect(codeOf(file)).not.toMatch(/\b(POST|PUT|PATCH|DELETE|OPTIONS)\b/);
  });
});

describe("todo archivo de acciones de servidor está en la lista, con el servicio por el que pasa", () => {
  const isServerAction = (code: string) => /^\s*["']use server["'];?/.test(code);
  // En todo el código: una acción de servidor fuera de `src/app` también sería una puerta.
  const actionFiles = everything.filter((source) => isServerAction(source.code)).map((source) => source.file);

  it("no hay acciones fuera de la lista ni la lista nombra archivos que no existen", () => {
    expect(actionFiles.sort()).toEqual(Object.keys(SERVER_ACTIONS).sort());
  });

  it("la marca de acción de servidor solo va al inicio de un archivo, nunca dentro de una función", () => {
    const inline = everything.filter((source) => /["']use server["']/.test(source.code) && !isServerAction(source.code));
    expect(inline.map((source) => source.file)).toEqual([]);
  });

  const listed = Object.entries(SERVER_ACTIONS).flatMap(([file, actions]) =>
    Object.entries(actions).map(([name, service]) => [file, name, service] as const),
  );

  it.each(listed)("%s · %s llama a lo suyo, dentro de su propia función", (file, name, service) => {
    const body = actionBody(codeOf(file), name);
    expect(body).not.toBe("");
    expect(body).toMatch(service);
  });

  it("el cuerpo de una acción es solo el suyo: no alcanza a la función de al lado", () => {
    const code = codeOf("src/app/(cuenta)/verificar/actions.ts");
    expect(actionBody(code, "notMyEmailAction")).not.toContain("requestRegistration");
    expect(actionBody(code, "resendAction")).not.toContain("notMyEmailAction");
    expect(actionBody(code, "noExisteAction")).toBe("");
  });

  it.each(Object.entries(SERVER_ACTIONS))("%s exporta esas acciones y ninguna otra cosa", (file, actions) => {
    const exported = [...codeOf(file).matchAll(/^export (.*)$/gm)].map((match) => match[1] ?? "");
    for (const line of exported) expect(line).toMatch(/^async function \w+Action\(/);
    const names = exported.map((line) => /^async function (\w+)\(/.exec(line)?.[1] ?? line);
    // Una acción nueva en un archivo ya revisado es otra puerta: entra a la lista, con lo suyo.
    expect(names.sort()).toEqual(Object.keys(actions).sort());
    // Y no hay otra forma de exportar: ni lista, ni reexportación, ni por omisión.
    expect(codeOf(file)).not.toMatch(/^export\s*(\{|\*|default\b)/m);
  });
});

describe("pedir un correo corre detrás de la respuesta", () => {
  // `requestRegistration` y `requestRecovery` no salen armados del servicio: quien los arma
  // dice cómo se manda la llamada a Auth detrás de la respuesta, y armados sin eso correrían
  // en línea, con lo que el tiempo delataría si un correo tiene cuenta. En `src/app` los arma
  // un solo archivo, con `after()`.
  const MAIL_REQUESTS = "src/app/_lib/mail-requests.ts";
  const outside = sources.filter((source) => source.file !== MAIL_REQUESTS && !/\.test\.tsx?$/.test(source.file));

  it("un solo archivo de la aplicación arma servicios de cuenta, y lo hace con `after()`", () => {
    expect(outside.filter((source) => /\bcreateAccountServices\b/.test(source.code)).map((source) => source.file)).toEqual([]);
    const code = codeOf(MAIL_REQUESTS);
    expect(code).toMatch(/import \{ after \} from "next\/server";/);
    expect(code).toMatch(/createAccountServices\(\{ defer: deferAfterResponse \}\)/);
    expect(code).toMatch(/try \{\s*after\(work\);\s*\} catch \{/);
  });

  it("el servicio no entrega esas dos ya armadas: quien las quiere tiene que decir cómo corren detrás", () => {
    const service = everything.find((source) => source.file === "src/services/account/account.ts")?.code ?? "";
    const armed = /export const \{([^}]*)\} = services;/.exec(service)?.[1] ?? "";
    // La lista de lo que sí sale armado existe y se leyó bien.
    expect(armed).toMatch(/\bsignIn\b/);
    expect(armed).not.toMatch(/\brequest(Registration|Recovery)\b/);
    // El objeto con todos los servicios armados no sale de ese archivo por ningún otro
    // lado: se crea, se desestructura en esa lista, y nada más lo nombra.
    expect(service.match(/(?<![\w/])services\b(?!\/)/g)).toHaveLength(2);
    expect(service).toMatch(/^const services = createAccountServices\(\);$/m);
    expect(service).not.toMatch(/^export default\b/m);
    // Ni en esa lista ni exportadas de ninguna otra forma, en ese archivo.
    expect(service).not.toMatch(/^export\b[^\n;]*\brequest(Registration|Recovery)\b/m);
    expect(service).not.toMatch(/^export \{[^}]*\brequest(Registration|Recovery)\b[^}]*\}/m);
  });

  it("quien pide un correo usa los de ese archivo, y de ningún otro lado", () => {
    const users = outside.filter((source) => /\b(requestRegistration|requestRecovery)\(/.test(source.code));
    expect(users.map((source) => source.file).sort()).toEqual([
      "src/app/(cuenta)/recuperar/actions.ts",
      "src/app/(cuenta)/registro/actions.ts",
      "src/app/(cuenta)/verificar/actions.ts",
    ]);
    for (const source of users) {
      expect(source.code, source.file).toMatch(/import \{ request(Registration|Recovery) \} from "@\/app\/_lib\/mail-requests";/);
      // Ni armados aquí mismo, ni traídos con otro nombre.
      expect(source.code, source.file).not.toMatch(/\b(?:const|let|var|function)\s+request(Registration|Recovery)\b/);
      expect(source.code, source.file).not.toMatch(/\bas request(Registration|Recovery)\b/);
    }
  });
});

describe("lo que viaja al navegador", () => {
  const isClient = (text: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["'];?/.test(text);
  const isServerAction = (text: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["'];?/.test(text);
  const clients = sources.filter((source) => isClient(source.text));
  // Desde un componente de cliente, una acción de servidor es una referencia: su código no
  // viaja. Ahí se corta la cadena.
  const shipped = (path: string) => reachableFrom(path, { runtimeOnly: true, stopAt: isServerAction });

  it("reconoce un componente de cliente", () => {
    expect(isClient('"use client";\nimport x from "y";')).toBe(true);
    expect(isClient("// nota\n'use client'\n")).toBe(true);
    expect(isClient('import x from "y";\n"use client";')).toBe(false);
    const names = clients.map((source) => source.file);
    expect(names).toContain("src/app/error.tsx");
    expect(names).toContain("src/app/(cuenta)/entrar/screen.tsx");
    expect(names).toContain("src/app/(cuenta)/consentimientos/screen.tsx");
    expect(names).toContain("src/app/(cuenta)/cuenta/screen.tsx");
  });

  it.each(clients.map((source) => [source.file, source.path]))("%s no arrastra código del servidor", (_file, path) => {
    const reached = shipped(path);
    const files = [...reached.files].filter((file) => !isServerAction(readFileSync(file, "utf8")));
    const serverOnly = files.filter((file) => /import ["']server-only["']/.test(readFileSync(file, "utf8"))).map(posix);
    expect(serverOnly).toEqual([]);
    // El registro de errores del navegador sí viaja, con su adaptador y lo poco de la
    // configuración que el navegador puede saber. La base y las variables del servidor, no.
    expect(files.map(posix).filter((file) => /^src\/(adapters\/supabase\/|config\/env\.ts$)/.test(file))).toEqual([]);
    expect([...reached.packages].filter((name) => /^(pg|server-only|next\/headers)$/.test(name))).toEqual([]);
  });

  it.each(clients.map((source) => [source.file, source.path]))("%s no carga el catálogo de textos entero", (_file, path) => {
    expect([...shipped(path).files].map(posix)).not.toContain("src/messages/index.ts");
  });

  it("las reglas de los campos, que validan en el navegador, son solo el dominio", () => {
    const reached = reachableFrom(join(src, "services/account/field-rules.ts"));
    expect([...reached.files].map(posix).sort()).toEqual([
      "src/domain/access/display-name.ts",
      "src/domain/access/email.ts",
      "src/domain/access/password-policy.ts",
      "src/domain/access/second-factor-code.ts",
      "src/services/account/field-rules.ts",
    ]);
    expect([...reached.packages]).toEqual([]);
  });
});

describe("el ancla de un bloque es de su pantalla y de ninguna otra", () => {
  // Una pantalla por bloques le da a cada formulario la dirección a la que vuelve sin
  // JavaScript, con el ancla de su bloque. Si la acción redirige, el navegador se lleva el
  // ancla a la pantalla de destino: allá no debe existir, o la página se desplazaría sola.
  const anchors = sources.flatMap((source) =>
    [...source.code.matchAll(/"(bloque-[a-z0-9-]+)"/g)].map((match) => ({ file: source.file, anchor: match[1] ?? "" })),
  );

  it("hay anclas que revisar", () => {
    expect(anchors.map(({ anchor }) => anchor).sort()).toEqual([
      "bloque-contrasena",
      "bloque-equipo-codigo",
      "bloque-equipo-invitaciones",
      "bloque-equipo-invitar",
      "bloque-equipo-personas",
      "bloque-equipo-restablecer",
      "bloque-nombre",
      "bloque-sesiones",
    ]);
  });

  it.each(anchors)("$anchor solo se escribe en $file", ({ file, anchor }) => {
    expect(everything.filter((source) => source.code.includes(anchor)).map((source) => source.file)).toEqual([file]);
  });
});

describe("la petición se lee en un solo archivo", () => {
  const READER = "src/app/_lib/request-context.ts";
  const others = sources.filter((source) => source.file !== READER);

  it("solo ese archivo importa las cookies y las cabeceras de Next", () => {
    const importing = sources.filter((source) => /["'`]next\/headers["'`]/.test(source.code)).map((source) => source.file);
    expect(importing).toEqual([READER]);
  });

  it("nadie más lee las cabeceras ni las cookies del objeto de la petición", () => {
    // Con cualquier nombre de variable, o sacándolas al recibir la petición.
    const reading = others
      .filter(
        (source) =>
          /\b(?:request|req)\.(?:headers|cookies)\b/.test(source.code) ||
          /\b\w+\.(?:headers|cookies)\.(?:get|getAll|has|entries|forEach|keys|values)\(/.test(source.code) ||
          /\{[^{}]*\b(?:headers|cookies)\b[^{}]*\}\s*(?::\s*(?:Next)?Request\b|=\s*(?:request|req)\b)/.test(source.code),
      )
      .map((source) => source.file);
    expect(reading).toEqual([]);
  });

  it("el lector saca de las cabeceras exactamente dos cosas", () => {
    const names = [...codeOf(READER).matchAll(/list\.get\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(names.sort()).toEqual(["user-agent", "x-real-ip"]);
  });

  it("lee de la petición la cabecera de la dirección que pone el alojamiento, y ninguna otra dirección", () => {
    const reader = codeOf(READER);
    expect(reader).toMatch(/realIp: list\.get\("x-real-ip"\)/);
    expect(reader).toMatch(/userAgent: list\.get\("user-agent"\)/);
    // Las demás cabeceras que dicen traer una dirección las escribe quien pide, o son de
    // otro alojamiento: no se nombran en ningún lado del código.
    const others = /["'`](?:x-forwarded-for|x-vercel-forwarded-for|x-client-ip|cf-connecting-ip|true-client-ip|forwarded)["'`]/i;
    expect(everything.filter((source) => others.test(source.code)).map((source) => source.file)).toEqual([]);
  });
});
