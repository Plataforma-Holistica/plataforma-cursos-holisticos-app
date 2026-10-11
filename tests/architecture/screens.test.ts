import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { posix, reachableFrom, sourceFiles, src } from "./sources";

// Tres cosas de las pantallas que el lint no alcanza a ver (TRD §4.2 y §9.3; flujo de la
// app §6.2):
//
// - Toda página que no es pública llama a la guarda de sesión. El paso previo solo mira si
//   hay cookie: una pantalla nueva que olvide la guarda quedaría abierta sin que nada falle.
// - Lo que viaja al navegador no arrastra código del servidor ni el catálogo entero.
// - La petición se lee en un solo archivo.

const app = join(src, "app");
const sources = sourceFiles(app).map((path) => ({ path, file: posix(path), text: readFileSync(path, "utf8") }));
const fileNames = sources.map((source) => source.file);

/** Las páginas que cualquiera ve sin sesión. Una página nueva no es pública hasta que entra aquí. */
const PUBLIC_PAGES = [
  // La portada provisional.
  "src/app/page.tsx",
  // La muestra de componentes, que solo existe con `pnpm dev`.
  "src/app/muestra/page.dev.tsx",
  "src/app/muestra/error/page.dev.tsx",
];

/** Las rutas, y lo que cada una tiene que llamar para no ser una puerta abierta. */
const ROUTE_HANDLERS: Record<string, RegExp | "public"> = {
  // El simulacro del registro de errores: no existe en producción.
  "src/app/api/error-drill/route.ts": /\berrorDrillAllowed\(\)/,
  // Cierra una sesión solo si la guarda la rechaza: eso lo decide el servicio.
  "src/app/sesion/cerrar/route.ts": /\bcloseRejectedSession\(/,
};

const GUARD_IMPORT = /import \{[^}]*\} from "@\/app\/_lib\/guard";/;
const GUARD_CALL = /\bawait (requireSession|requireIncompleteSession|visitorOnly)\(/;

describe("toda página pasa por la guarda o está en la lista de públicas", () => {
  const pages = fileNames.filter((file) => /\/page(\.dev)?\.tsx$/.test(file));

  it("hay páginas que revisar", () => {
    expect(pages).toContain("src/app/page.tsx");
  });

  it("la lista de públicas no nombra páginas que ya no existen", () => {
    for (const file of PUBLIC_PAGES) expect(pages).toContain(file);
  });

  it.each(pages.filter((file) => !PUBLIC_PAGES.includes(file)))("%s llama a la guarda", (file) => {
    const text = sources.find((source) => source.file === file)?.text ?? "";
    expect(text).toMatch(GUARD_IMPORT);
    expect(text).toMatch(GUARD_CALL);
  });

  it("una página pública no finge pasar por la guarda", () => {
    for (const file of PUBLIC_PAGES) {
      const text = sources.find((source) => source.file === file)?.text ?? "";
      expect(text).not.toMatch(GUARD_CALL);
    }
  });
});

describe("toda ruta está en la lista, con lo que la cuida", () => {
  const routes = fileNames.filter((file) => /\/route\.ts$/.test(file));

  it("no hay rutas fuera de la lista ni la lista nombra rutas que no existen", () => {
    expect(routes.sort()).toEqual(Object.keys(ROUTE_HANDLERS).sort());
  });

  it.each(Object.entries(ROUTE_HANDLERS))("%s", (file, guard) => {
    const text = sources.find((source) => source.file === file)?.text ?? "";
    if (guard !== "public") expect(text).toMatch(guard);
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
    expect(clients.map((source) => source.file)).toContain("src/app/error.tsx");
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

  it("solo ese archivo importa las cookies y las cabeceras de Next", () => {
    const importing = sources.filter((source) => /["'`]next\/headers["'`]/.test(source.text)).map((source) => source.file);
    expect(importing).toEqual([READER]);
  });

  it("nadie más lee las cabeceras ni las cookies del objeto de la petición", () => {
    const reading = sources
      .filter((source) => source.file !== READER)
      .filter((source) => /\b(?:request|req)\.(?:headers|cookies)\b/.test(source.text))
      .map((source) => source.file);
    expect(reading).toEqual([]);
  });
});
