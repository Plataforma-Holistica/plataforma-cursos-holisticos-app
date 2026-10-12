import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { BROWSERS, describeUserAgent, SYSTEMS } from "./user-agent";

// De qué navegador y de qué sistema dice ser una sesión (RF-109), para que su dueña la
// reconozca en la lista de sesiones abiertas. No decide nada: es una etiqueta.

const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7)";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)";
const CHROME_OS = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)";
const KIT = "AppleWebKit/537.36 (KHTML, like Gecko)";

describe("describeUserAgent", () => {
  it.each([
    ["Chrome en Windows", `${WIN} ${KIT} Chrome/126.0.0.0 Safari/537.36`, "chrome", "windows"],
    ["Chrome en macOS", `${MAC} ${KIT} Chrome/126.0.0.0 Safari/537.36`, "chrome", "macos"],
    ["Chrome en Linux", `${LINUX} ${KIT} Chrome/126.0.0.0 Safari/537.36`, "chrome", "linux"],
    ["Chrome en Android", `${ANDROID} ${KIT} Chrome/126.0.0.0 Mobile Safari/537.36`, "chrome", "android"],
    ["Chrome en iPhone", `${IPHONE} AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1`, "chrome", "ios"],
    ["Chrome en ChromeOS", `${CHROME_OS} ${KIT} Chrome/126.0.0.0 Safari/537.36`, "chrome", "chromeos"],
    ["Edge en Windows", `${WIN} ${KIT} Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0`, "edge", "windows"],
    ["Edge en Android", `${ANDROID} ${KIT} Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0`, "edge", "android"],
    ["Edge en iPhone", `${IPHONE} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.0.0.0 Mobile/15E148 Safari/605.1.15`, "edge", "ios"],
    ["el Edge de antes", `${WIN} ${KIT} Chrome/64.0.3282.140 Safari/537.36 Edge/18.17763`, "edge", "windows"],
    ["Firefox en Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0", "firefox", "windows"],
    ["Firefox en Linux", "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "firefox", "linux"],
    ["Firefox en iPhone", `${IPHONE} AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15`, "firefox", "ios"],
    ["Safari en macOS", `${MAC} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15`, "safari", "macos"],
    ["Safari en iPhone", `${IPHONE} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1`, "safari", "ios"],
    ["Safari en iPad", `${IPAD} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1`, "safari", "ios"],
    ["Opera en Windows", `${WIN} ${KIT} Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0`, "opera", "windows"],
    ["Opera en iPhone", `${IPHONE} AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/16.0.14 Mobile/15E148 Safari/9537.53`, "opera", "ios"],
    ["el navegador de Samsung", `${ANDROID} ${KIT} SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36`, "samsung", "android"],
  ] as const)("reconoce %s", (_case, userAgent, browser, system) => {
    expect(describeUserAgent(userAgent)).toEqual({ browser, system });
  });

  it.each([
    ["un navegador que no conoce, en un sistema que sí", `${WIN} OtroNavegador/1.0`, null, "windows"],
    ["un navegador que sí, en un sistema que no", "Mozilla/5.0 (PlayStation; PlayStation 5/2.26) Gecko/20100101 Firefox/127.0", "firefox", null],
    ["un programa que no es un navegador", "curl/8.4.0", null, null],
    ["las pruebas de integración", "Pruebas de integración", null, null],
    // WebKit sin «Version/» no es Safari: es otro navegador montado sobre él.
    ["un WebKit que no dice ser Safari", `${MAC} AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15`, null, "macos"],
  ] as const)("dice lo que sabe de %s", (_case, userAgent, browser, system) => {
    expect(describeUserAgent(userAgent)).toEqual({ browser, system });
  });

  it.each([
    ["nulo", null],
    ["vacío", ""],
    ["solo espacios", "   "],
  ])("de un texto %s no dice nada", (_case, userAgent) => {
    expect(describeUserAgent(userAgent)).toEqual({ browser: null, system: null });
  });

  it("lo que un navegador dice ser se busca como palabra, no como trozo de otra", () => {
    // Nombres que contienen a otros: ninguno de estos es Chrome, Edge, Firefox ni Linux.
    expect(describeUserAgent("NoChrome/1.0 MiEdg/2.0 xFirefox/3 UnLinuxito")).toEqual({ browser: null, system: null });
  });

  it("solo mira el principio de un texto desmedido", () => {
    const padding = "x".repeat(600);
    expect(describeUserAgent(`${padding} ${WIN} ${KIT} Chrome/126.0.0.0 Safari/537.36`)).toEqual({ browser: null, system: null });
  });

  const piece = fc.constantFrom(
    WIN, MAC, LINUX, ANDROID, IPHONE, IPAD, CHROME_OS, KIT,
    "Chrome/126.0", "CriOS/126", "Edg/126", "EdgA/1", "EdgiOS/1", "Edge/18", "OPR/111", "OPiOS/16", "SamsungBrowser/25",
    "Firefox/127", "FxiOS/127", "Version/17.5", "Safari/605", "Mobile", " ", "/", "(", ")", "😀", "\u0000",
  );
  const candidate = fc.array(piece, { maxLength: 10 }).map((pieces) => pieces.join(" "));

  it("con cualquier texto contesta algo de sus listas, y lo mismo cada vez", () => {
    fc.assert(
      fc.property(fc.oneof(candidate, fc.string()), (input) => {
        const device = describeUserAgent(input);
        expect([...BROWSERS, null]).toContain(device.browser);
        expect([...SYSTEMS, null]).toContain(device.system);
        expect(describeUserAgent(input)).toEqual(device);
      }),
    );
  });

  it("los generadores sí producen cada navegador y cada sistema", () => {
    const devices = fc.sample(candidate, 3_000).map((input) => describeUserAgent(input));
    expect(new Set(devices.map((device) => device.browser))).toEqual(new Set([...BROWSERS, null]));
    expect(new Set(devices.map((device) => device.system))).toEqual(new Set([...SYSTEMS, null]));
  });
});
