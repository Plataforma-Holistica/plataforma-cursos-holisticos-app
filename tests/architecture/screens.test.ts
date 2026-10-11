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
  "src/app/(cuenta)/consentimientos/actions.ts": {
    // Completar la cuenta: el servicio vuelve a correr la guarda antes de escribir nada.
    completeAccountAction: /await completeAccount\(\s*jar,[\s\S]*return leaveFor\(jar, outcome\);/,
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
      /if \(!isLinkToken\(input\.token\)\) return \{ kind: "link_dead" \};[\s\S]*await completeRecovery\(\{ tokenHash: input\.token, password: input\.password \}, await requestOrigin\(\)\)[\s\S]*return leaveFor\(await cookieJar\(\), outcome\);/,
  },
  "src/app/(cuenta)/_lib/session-actions.ts": {
    // Salir: solo usa la cookie de quien pide.
    signOutAction: /await signOut\(await cookieJar\(\)\)/,
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
const SESSION_GUARD = /= await (requireSession|requireIncompleteSession)\(/;
const VISITOR_GUARD = /^\s*await visitorOnly\(\);$/m;

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
    expect(sessionPages.sort()).toEqual(["/consentimientos", "/inicio"]);
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
      "src/services/account/field-rules.ts",
    ]);
    expect([...reached.packages]).toEqual([]);
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
