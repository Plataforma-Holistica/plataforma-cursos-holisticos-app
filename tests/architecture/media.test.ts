import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// La función única de medios (TRD §5.5 y §9.4; RF-305): solo ella firma una dirección de
// video. Lo exige el código, no la buena voluntad: aquí se buscan las firmas.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const sources = sourceFiles(src)
  .filter((path) => !/\.test\.tsx?$/.test(path))
  .map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file).sort();

describe("solo la función única de medios firma", () => {
  it("la firma de Mux se importa en un solo archivo: el que arma la función única", () => {
    expect(naming(/adapters\/mux\b/)).toEqual(["src/services/media/grant.ts", "src/services/media/media.ts"]);
    // grant.ts solo importa sus tipos.
    expect(readFileSync(join(src, "services/media/grant.ts"), "utf8")).toMatch(/^import type \{[^}]*\} from "@\/adapters\/mux\/sign";$/m);
  });

  it("signPlayback se llama solo al armarla", () => {
    expect(naming(/\bsignPlayback\b/)).toEqual(["src/adapters/mux/sign.ts", "src/services/media/media.ts"]);
  });

  it("nadie más arma un JWT ni usa la llave de firma", () => {
    expect(naming(/MUX_SIGNING_PRIVATE_KEY/)).toEqual(["src/config/env.ts", "src/services/media/media.ts"]);
    expect(naming(/["']RSA-SHA256["']|createPrivateKey/)).toEqual(["src/adapters/mux/sign.ts"]);
  });

  it("las pantallas piden la dirección a media.ts, nunca a grant.ts ni al adaptador", () => {
    const fromApp = sources.filter((source) => source.file.startsWith("src/app/") && /services\/media\/(?!media\b)/.test(source.text));
    expect(fromApp.map((source) => source.file)).toEqual([]);
  });

  it("la firma y la función única tienen dueño en CODEOWNERS", () => {
    const owners = readFileSync(join(src, "..", ".github", "CODEOWNERS"), "utf8");
    expect(owners).toMatch(/^\/src\/services\/media\/\s+@SerchFGA @plataformaholisticadev$/m);
    expect(owners).toMatch(/^\/src\/adapters\/mux\/\s+@SerchFGA @plataformaholisticadev$/m);
  });
});
