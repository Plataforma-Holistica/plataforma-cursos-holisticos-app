import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// La función única de medios (TRD §5.5 y §9.4; RF-305): solo ella firma una dirección de
// video. Lo exige el código, no la buena voluntad: aquí se buscan las firmas.

// Solo los comentarios de línea entera: un `//` dentro de un texto («https://…») no esconde
// lo que sigue en la misma línea.
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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
    expect(naming(/MUX_SIGNING_KEY_ID/)).toEqual(["src/config/env.ts", "src/services/media/media.ts"]);
    // Las maneras de firmar que hay a mano en Node y en el navegador, y los paquetes de JWT.
    expect(naming(/RSA-SHA256|createPrivateKey|createSign|subtle\.sign|\bimportKey\b|jsonwebtoken|["']jose["']/i)).toEqual([
      "src/adapters/mux/sign.ts",
    ]);
  });

  it("las pantallas y los trabajos piden la dirección a media.ts, nunca a grant.ts ni al adaptador", () => {
    const outside = sources.filter((source) => /^src\/(app|jobs)\//.test(source.file) && /services\/media\/(?!media\b)/.test(source.text));
    expect(outside.map((source) => source.file)).toEqual([]);
  });

  it("la lección se lee como la persona y la velocidad como servidor, nunca como sistema", () => {
    const store = readFileSync(join(src, "services/media/store.ts"), "utf8");
    // La política de Contenido de la base es la segunda barrera: con asServer no correría.
    expect(store).toMatch(/lessonVideo: \(claims, lessonId\) => asUser\(claims, \(tx\) => readLessonVideo\(tx, lessonId\)\),/);
    expect(store).toMatch(/minimumSpeed: \(claims\) => asServer\(\{ claims, reason: "media_grant" \}, \(tx\) => readMinimumSpeed\(tx\)\),/);
    expect(store).not.toMatch(/asSystem/);
    expect(store.match(/\basUser\(/g)).toHaveLength(1);
  });

  it("en las pantallas, solo la acción del reproductor pide un video: nada lo pinta en el HTML", () => {
    expect(naming(/\bgetMediaGrant\b/).filter((file) => file.startsWith("src/app/"))).toEqual(["src/app/admin/_revision/actions.ts"]);
  });

  it("Mux Player se importa en un solo archivo, y la pantalla lo carga con next/dynamic", () => {
    // Cualquier manera de cargarlo: `import`, `import()` y `require`, con o sin `next/dynamic`.
    const loads = /["'](@mux\/mux-player(-react)?|media-chrome|hls\.js)(\/[^"']*)?["']/;
    expect(naming(loads)).toEqual(["src/app/admin/_revision/player.tsx"]);
    // Su entrada `/lazy` inyecta estilos en línea: no se usa.
    expect(naming(/mux-player-react\/lazy|mux-player-react\/dist\/lazy/)).toEqual([]);
    // Solo la pantalla nombra al reproductor, y lo carga con `next/dynamic`, sin servidor. De él
    // importa en estático solo un tipo, que no viaja.
    expect(naming(/["']\.\/player["']|_revision\/player["']/)).toEqual(["src/app/admin/_revision/screen.tsx"]);
    const screen = readFileSync(join(src, "app/admin/_revision/screen.tsx"), "utf8");
    expect(screen).toMatch(/const Player = dynamic\(\(\) => import\("\.\/player"\)\.then\(\(module\) => module\.Player, \(\) => PlayerMissing\), \{\n\s+ssr: false,/);
    expect([...screen.matchAll(/^import ([^;]*)["']\.\/player["'];$/gm)].map((found) => found[1])).toEqual(["type { PlayerProps } from "]);
    // Sin analítica, sin cookies y sin imagen dentro de imagen.
    const player = withoutComments(readFileSync(join(src, "app/admin/_revision/player.tsx"), "utf8"));
    // Cada una como atributo propio del reproductor, en su línea: no basta que el nombre aparezca.
    for (const prop of ["disableTracking", "disableCookies", "noVolumePref", "noMutedPref", "ref={lockDown}"]) {
      expect(player, prop).toMatch(new RegExp(`^ {6}${prop.replace(/[{}]/g, "\\$&")}$`, "m"));
    }
    expect(player).not.toMatch(/envKey|metadata|beaconCollectionDomain/);
    // Lo que no tiene prop se apaga en el video interno.
    expect(player).toMatch(/media\.nativeEl\.disableRemotePlayback = true;/);
    expect(player).toMatch(/media\.nativeEl\.disablePictureInPicture = true;/);
  });

  it("la firma y la función única tienen dueño en CODEOWNERS", () => {
    const owners = readFileSync(join(src, "..", ".github", "CODEOWNERS"), "utf8");
    expect(owners).toMatch(/^\/src\/services\/media\/\s+@SerchFGA @plataformaholisticadev$/m);
    expect(owners).toMatch(/^\/src\/adapters\/mux\/\s+@SerchFGA @plataformaholisticadev$/m);
  });
});
