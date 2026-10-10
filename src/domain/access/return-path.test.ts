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

  it("un signo de consulta sin nada detrás se quita", () => {
    expect(resolveReturnPath("/inicio?", ALLOWED)).toEqual({ kind: "path", path: "/inicio" });
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

  it.each([
    ["vacío", ""],
    ["que es solo la barra", "/"],
    ["terminado en barra", "/inicio/"],
    ["sin barra inicial", "inicio"],
  ])("un destino %s en la lista no abre ninguna ruta", (_name, prefix) => {
    expect(resolveReturnPath("/inicio", [prefix])).toEqual({ kind: "default", reason: "not_allowed" });
    expect(resolveReturnPath("/inicio/algo", [prefix])).toEqual({ kind: "default", reason: "not_allowed" });
  });

  it("el largo máximo se acepta, y un carácter más no", () => {
    const atLimit = `/cursos/${"a".repeat(RETURN_PATH_MAX_LENGTH - "/cursos/".length)}`;
    expect(atLimit.length).toBe(RETURN_PATH_MAX_LENGTH);
    expect(resolveReturnPath(atLimit, ALLOWED)).toEqual({ kind: "path", path: atLimit });
    expect(resolveReturnPath(`${atLimit}a`, ALLOWED)).toEqual({ kind: "default", reason: "malformed" });
  });

  it("una barra en la consulta no se acepta", () => {
    expect(resolveReturnPath("/inicio?a=/x", ALLOWED)).toEqual({ kind: "default", reason: "malformed" });
  });

  it("no tarda con entradas largas y hostiles", () => {
    const hostileInputs = [`/${"a.".repeat(500)}`, `/${"a".repeat(1000)}!`, `/inicio?${"%4".repeat(500)}`, "/".repeat(1024)];
    for (const input of hostileInputs) {
      expect(resolveReturnPath(input, ALLOWED).kind).toBe("default");
    }
  });

  // El oráculo es el analizador de direcciones del propio entorno, que es el que usa el
  // navegador: si acepta una ruta, al resolverla contra el sitio el origen no cambia y la
  // ruta queda idéntica, sin que nada se normalice por el camino.
  // Las entradas se arman desde un destino permitido y se les cuelgan fichas, la mayoría
  // inocuas y algunas hostiles: así buena parte se acepta y la propiedad tiene qué mirar.
  // Con texto al azar casi ninguna pasaría de la primera revisión.
  const token = fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom("/a", "/yoga-1", "/lecciones", "/3", "/v1.2", "/x_y~z", "?a=1", "&b=c%20d", "=", "#frag") },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "/", "//", "/.", "/..", "\\", ".", "..", "%2e", "%2f", "%5c", "%09", "\t", "\n", " ", "@", ":", ";",
        "//sitio.test", "https://sitio.test", "/%2e%2e", "?", "#", "%",
      ),
    },
  );
  const candidate = fc
    .tuple(fc.constantFrom("/inicio", "/cursos", "/a", "", "/otro"), fc.array(token, { maxLength: 6 }))
    .map(([start, tokens]) => `${start}${tokens.join("")}`);
  const PREFIXES = ["/inicio", "/cursos", "/a"];

  it("toda ruta que acepta conserva el origen, queda idéntica al resolverla y cae en un destino permitido", () => {
    fc.assert(
      fc.property(candidate, (input) => {
        const result = resolveReturnPath(input, PREFIXES);
        if (result.kind !== "path") return;
        const url = new URL(result.path, ORIGIN);
        expect(url.origin).toBe(ORIGIN);
        expect(`${url.pathname}${url.search}`).toBe(result.path);
        expect(url.hash).toBe("");
        expect(PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))).toBe(true);
        // Y es la entrada misma, sin el fragmento ni un signo de consulta vacío al final:
        // nada más se reescribió por el camino.
        expect(result.path).toBe(input.split("#")[0]?.replace(/\?$/, ""));
      }),
      { numRuns: 3000 },
    );
  });

  it("los generadores sí producen rutas aceptadas y rechazadas, por cada motivo", () => {
    const results = fc.sample(candidate, 3000).map((input) => resolveReturnPath(input, PREFIXES));
    const accepted = results.filter((result) => result.kind === "path").length;
    expect(accepted).toBeGreaterThan(300);
    const reasons = new Set(results.flatMap((result) => (result.kind === "default" ? [result.reason] : [])));
    expect([...reasons].sort()).toEqual(["absent", "malformed", "not_allowed"]);
  });

  it("ningún texto, por raro que sea, produce una ruta que salga del sitio", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: "binary", maxLength: 60 }), fc.webUrl({ withQueryParameters: true })), (input) => {
        const result = resolveReturnPath(input, PREFIXES);
        if (result.kind !== "path") return;
        expect(new URL(result.path, ORIGIN).origin).toBe(ORIGIN);
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
