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

  it("para revisar, la lección se lee como la persona; para ver, los hechos como servidor; nunca como sistema", () => {
    const store = readFileSync(join(src, "services/media/store.ts"), "utf8");
    // La política de Contenido de la base es la segunda barrera al revisar: con asServer no correría.
    expect(store).toMatch(/lessonVideo: \(claims, lessonId\) => asUser\(claims, \(tx\) => readLessonVideo\(tx, lessonId\)\),/);
    // Al ver, la segunda barrera es private.lesson_playback(), y quien actúa sale de las claims verificadas.
    expect(store).toMatch(/watchFacts: \(claims, lessonId\) => asServer\(\{ claims, reason: "media_grant" \}, \(tx\) => readWatchFacts\(tx, lessonId\)\),/);
    // Las velocidades son parámetros, que una cuenta no lee.
    expect(store).toMatch(/playbackSpeeds: \(claims\) => asServer\(\{ claims, reason: "media_grant" \}, \(tx\) => readPlaybackSpeeds\(tx\)\),/);
    expect(store).not.toMatch(/asSystem/);
    expect(store.match(/\basUser\(/g)).toHaveLength(1);
    expect(store.match(/\basServer\(/g)).toHaveLength(2);
  });

  it("el playback id sale de la base solo en las lecturas de la función única", () => {
    // Al ver, la lectura de los hechos y del video va en la misma consulta: lo que se decide y
    // lo que se firma salen de la misma foto.
    expect(naming(/provider_playback_id|lesson_playback/)).toEqual(["src/services/media/records.ts"]);
    expect(readFileSync(join(src, "services/media/records.ts"), "utf8")).toMatch(
      /sql`select private\.media_facts\(\$\{id\}::uuid\) as facts, private\.lesson_playback\(\$\{id\}::uuid\) as playback_id`/,
    );
  });

  it("nadie firma un archivo por fuera: los recursos (RF-308) pasarán por la misma función", () => {
    expect(naming(/createSignedUrl|createSignedUploadUrl|getSignedUrl/)).toEqual([]);
  });

  it("ver pasa por la guarda de sesión; revisar, por la del equipo", () => {
    const grant = withoutComments(readFileSync(join(src, "services/media/grant.ts"), "utf8"));
    // Ver y decidir al cargar comparten la decisión, que empieza por la guarda de sesión.
    expect(grant).toMatch(/async function decideWatch\([^)]*\)[^{]*\{\n\s+const session = await core\.checkSession\(reader\);/);
    expect(grant).toMatch(/async function watch\([^)]*\)[^{]*\{\n\s+const decided = await decideWatch\(reader, lessonId\);/);
    expect(grant).toMatch(/async function lessonAccess\([^)]*\)[^{]*\{\n\s+const decided = await decideWatch\(reader, lessonId\);/);
    expect(grant).toMatch(/async function review\([^)]*\)[^{]*\{\n\s+const team = await core\.teamStanding\(reader\);/);
    // La pantalla de revisión pide siempre como revisión.
    const actions = readFileSync(join(src, "app/admin/_revision/actions.ts"), "utf8");
    expect(actions).toMatch(/getMediaGrant\(jar, lessonId, "review"\)/);
  });

  it("decidir al cargar no firma: solo revisar y ver llegan a la firma", () => {
    const grant = withoutComments(readFileSync(join(src, "services/media/grant.ts"), "utf8"));
    // La definición y sus dos llamadas, una en cada camino que firma.
    expect(grant.match(/\bsignFor\(/g)).toHaveLength(3);
    expect(grant.match(/\bcore\.sign\(/g)).toHaveLength(1);
    const body = (name: string) => grant.slice(grant.indexOf(`async function ${name}(`)).split(/\n {2}(?:async )?function /)[0] ?? "";
    // Ni directo ni a través de los caminos que firman.
    expect(body("lessonAccess")).not.toMatch(/signFor|core\.sign|playbackSpeeds|playbackId|\bwatch\(|\breview\(|getMediaGrant\(/);
    expect(body("review")).toMatch(/return signFor\(/);
    expect(body("watch")).toMatch(/await signFor\(/);
  });

  it("la base de acceso y si cuenta para el reparto no llegan a ninguna pantalla: son de T-204 y T-205", () => {
    // Una acción que devolviera la respuesta de ver tal cual le mandaría al navegador la base y
    // el fin del acceso. Las pantallas solo toman de ella lo que pintan.
    expect(naming(/\bcountsForPayout\b|\bbasis\b/).filter((file) => file.startsWith("src/app/"))).toEqual([]);
  });

  it("en las pantallas, solo la acción del reproductor pide un video: nada lo pinta en el HTML", () => {
    expect(naming(/\bgetMediaGrant\b/).filter((file) => file.startsWith("src/app/"))).toEqual([
      "src/app/admin/_revision/actions.ts",
      "src/app/cursos/[slug]/lecciones/[leccion]/actions.ts",
    ]);
    // La lección pide como el alumno; la página, antes de pintar, solo decide (no firma).
    const lessonActions = readFileSync(join(src, "app/cursos/[slug]/lecciones/[leccion]/actions.ts"), "utf8");
    expect(lessonActions).toMatch(/getMediaGrant\(jar, lessonId, "watch"\)/);
    expect(naming(/\blessonAccess\b/).filter((file) => file.startsWith("src/app/"))).toEqual(["src/app/cursos/[slug]/lecciones/[leccion]/page.tsx"]);
  });

  it("Mux Player se importa en un solo archivo, el reproductor compartido, y las pantallas lo cargan con next/dynamic", () => {
    // Cualquier manera de cargarlo: `import`, `import()` y `require`, con o sin `next/dynamic`.
    const loads = /["'](@mux\/mux-player(-react)?|media-chrome|hls\.js)(\/[^"']*)?["']/;
    expect(naming(loads)).toEqual(["src/app/_video/player.tsx"]);
    // Su entrada `/lazy` inyecta estilos en línea: no se usa.
    expect(naming(/mux-player-react\/lazy|mux-player-react\/dist\/lazy/)).toEqual([]);
    // Solo las pantallas con video nombran al reproductor, y lo cargan con `next/dynamic`, sin
    // servidor. De él importan en estático solo un tipo, que no viaja.
    const screens = ["src/app/admin/_revision/screen.tsx", "src/app/cursos/[slug]/lecciones/[leccion]/screen.tsx"];
    expect(naming(/["'][^"']*_video\/player["']|["']\.\/player["']/)).toEqual(screens);
    for (const file of screens) {
      const screen = readFileSync(join(src, "..", file), "utf8");
      expect(screen, file).toMatch(
        /const Player = dynamic\(\(\) => import\("@\/app\/_video\/player"\)\.then\(\(module\) => module\.Player, \(\) => PlayerMissing\), \{\n\s+ssr: false,/,
      );
      expect([...screen.matchAll(/^import ([^;]*)["']@\/app\/_video\/player["'];$/gm)].map((found) => found[1]), file).toEqual(["type { PlayerProps } from "]);
    }
    // Sin analítica, sin cookies y sin imagen dentro de imagen.
    const player = withoutComments(readFileSync(join(src, "app/_video/player.tsx"), "utf8"));
    // Cada una como atributo propio del reproductor, en su línea: no basta que el nombre aparezca.
    // Los subtítulos, apagados salvo que la cuenta los haya dejado encendidos (RF-310).
    for (const prop of ["disableTracking", "disableCookies", "noVolumePref", "noMutedPref", "defaultHiddenCaptions={!captions}", "ref={attach}"]) {
      expect(player, prop).toMatch(new RegExp(`^ {10}${prop.replace(/[{}!]/g, "\\$&")}$`, "m"));
    }
    expect(player).not.toMatch(/envKey|metadata|beaconCollectionDomain/);
    // Lo que no tiene prop se apaga en el video interno, al conectarse el elemento.
    expect(player).toMatch(/function attach\(element: MuxPlayerRefAttributes \| null\) \{\n\s+lockDown\(element\);/);
    expect(player).toMatch(/media\.nativeEl\.disableRemotePlayback = true;/);
    expect(player).toMatch(/media\.nativeEl\.disablePictureInPicture = true;/);
    // El selector de calidad no se ofrece: la calidad es automática (RF-312).
    expect(player).toMatch(/className="player-mux /);
    const theme = readFileSync(join(src, "ui/theme.css"), "utf8");
    expect(theme).toMatch(/@utility player-mux \{[^}]*--rendition-menu-button: none;/);
  });

  it("la firma y la función única tienen dueño en CODEOWNERS", () => {
    const owners = readFileSync(join(src, "..", ".github", "CODEOWNERS"), "utf8");
    expect(owners).toMatch(/^\/src\/services\/media\/\s+@SerchFGA @plataformaholisticadev$/m);
    expect(owners).toMatch(/^\/src\/adapters\/mux\/\s+@SerchFGA @plataformaholisticadev$/m);
    // El reproductor: la marca de agua y lo que se le apaga.
    expect(owners).toMatch(/^\/src\/app\/_video\/\s+@SerchFGA @plataformaholisticadev$/m);
  });
});
