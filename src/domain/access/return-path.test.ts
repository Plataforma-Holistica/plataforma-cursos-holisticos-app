import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { RETURN_PATH_MAX_LENGTH, resolveReturnPath } from "./return-path";

// A dónde se vuelve después de entrar (parámetro `volver`, flujo de la app §6.4). Solo vale
// una ruta propia y de una lista de destinos: cualquier otra cosa lleva al inicio del rol.
// Lo que se cuida es que nadie arme un enlace a la Plataforma que termine en otro sitio.

const ALLOWED = ["/inicio", "/cursos", "/planes", "/cuenta"];
const ORIGIN = "https://plataforma.test";

describe("resolveReturnPath", () => {
  it.each([
    ["una ruta de la lista", "/inicio", "/inicio"],
    ["una ruta bajo un destino de la lista", "/cursos/yoga-inicial/lecciones/3", "/cursos/yoga-inicial/lecciones/3"],
    ["una ruta con consulta", "/planes?plan=anual&origen=curso", "/planes?plan=anual&origen=curso"],
    ["una consulta con un valor codificado", "/planes?nota=a%20b", "/planes?nota=a%20b"],
    ["un segmento con punto en medio", "/cursos/v1.2", "/cursos/v1.2"],
  ])("acepta %s", (_name, input, path) => {
    expect(resolveReturnPath(input, ALLOWED)).toEqual({ kind: "path", path });
  });

  it("descarta el fragmento", () => {
    expect(resolveReturnPath("/inicio#//sitio.test", ALLOWED)).toEqual({ kind: "path", path: "/inicio" });
  });

  it.each([null, undefined, ""])("sin destino («%s») va al inicio del rol", (input) => {
    expect(resolveReturnPath(input, ALLOWED)).toEqual({ kind: "default", reason: "absent" });
  });

  it.each([
    ["una dirección completa", "https://sitio.test/inicio"],
    ["una dirección sin protocolo", "//sitio.test/inicio"],
    ["una barra invertida tras la primera", "/\\sitio.test"],
    ["una barra invertida en medio", "/inicio\\..\\sitio"],
    ["un tabulador que el navegador quita", "/\t/sitio.test"],
    ["un salto de línea", "/inicio\n/x"],
    ["un espacio", "/inicio /x"],
    ["un segmento de un punto", "/./inicio"],
    ["un punto y dos barras, que el navegador convierte en otro sitio", "/.//sitio.test"],
    ["dos puntos que suben", "/cursos/../..//sitio.test"],
    ["un segmento vacío", "/cursos//sitio.test"],
    ["una barra al final", "/inicio/"],
    ["un punto codificado", "/%2e/inicio"],
    ["una barra codificada", "/inicio%2fsitio"],
    ["cualquier porcentaje en la ruta", "/inicio%41"],
    ["un porcentaje suelto en la consulta", "/inicio?a=%zz"],
    ["un punto al inicio de un segmento", "/.oculto"],
    ["un punto al final de un segmento", "/inicio."],
    ["una ruta que no empieza con barra", "inicio"],
    ["solo la barra", "/"],
    ["una arroba", "/inicio@sitio.test"],
    ["dos puntos", "/javascript:alert(1)"],
    ["una letra con acento", "/cursos/meditación"],
    ["un carácter nulo", "/inicio\u0000"],
    ["una consulta con una barra invertida", "/inicio?a=\\"],
  ])("no acepta %s", (_name, input) => {
    expect(resolveReturnPath(input, ALLOWED)).toEqual({ kind: "default", reason: "malformed" });
  });

  it("no acepta una ruta más larga que el máximo", () => {
    const long = `/cursos/${"a".repeat(RETURN_PATH_MAX_LENGTH)}`;
    expect(resolveReturnPath(long, ALLOWED)).toEqual({ kind: "default", reason: "malformed" });
  });

  it.each([
    ["una ruta bien formada fuera de la lista", "/entrar"],
    ["una ruta de sistema", "/api/error-drill"],
    ["una ruta que solo empieza igual que un destino", "/iniciox"],
    ["una ruta de la lista, con otra mayúscula", "/Inicio"],
  ])("no acepta %s", (_name, input) => {
    expect(resolveReturnPath(input, ALLOWED)).toEqual({ kind: "default", reason: "not_allowed" });
  });

  it("sin destinos permitidos no acepta nada", () => {
    expect(resolveReturnPath("/inicio", [])).toEqual({ kind: "default", reason: "not_allowed" });
  });

  // El oráculo es el analizador de direcciones del propio entorno, que es el que usa el
  // navegador: si acepta una ruta, al resolverla contra el sitio el origen no cambia y la
  // ruta queda idéntica, sin que nada se normalice por el camino.
  const hostile = fc.oneof(
    fc.string({ unit: "binary", maxLength: 60 }),
    fc.webUrl({ withQueryParameters: true, withFragments: true }),
    fc
      .array(
        fc.constantFrom(
          "/", "//", "\\", ".", "..", "%2e", "%2f", "%5c", "%09", "\t", "\n", " ", "@", ":", "?", "#",
          "inicio", "cursos", "sitio.test", "https:", "a", "=", "&", "%20",
        ),
        { maxLength: 12 },
      )
      .map((parts) => parts.join("")),
  );

  it("toda ruta que acepta conserva el origen y queda idéntica al resolverla", () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const result = resolveReturnPath(input, ["/inicio", "/cursos", "/a"]);
        if (result.kind !== "path") return;
        const url = new URL(result.path, ORIGIN);
        expect(url.origin).toBe(ORIGIN);
        expect(`${url.pathname}${url.search}`).toBe(result.path);
        expect(url.hash).toBe("");
        expect(result.path.startsWith("//")).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });

  it("toda ruta que acepta cae en un destino permitido", () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const result = resolveReturnPath(input, ["/inicio", "/cursos"]);
        if (result.kind !== "path") return;
        const pathname = result.path.split("?")[0];
        expect(
          ["/inicio", "/cursos"].some((prefix) => pathname === prefix || pathname?.startsWith(`${prefix}/`)),
        ).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("meter un carácter peligroso en una ruta válida la invalida", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("/inicio", "/cursos/yoga/lecciones/3", "/planes"),
        fc.constantFrom("\\", "\t", "\n", "\r", " ", "\u0000", "%", "@", ":", ";", "<", "\"", "'"),
        fc.nat(),
        (path, char, position) => {
          const at = position % (path.length + 1);
          const dirty = `${path.slice(0, at)}${char}${path.slice(at)}`;
          expect(resolveReturnPath(dirty, ALLOWED).kind).toBe("default");
        },
      ),
    );
  });
});
