import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// La salida de correo (T-604). De ahí salen direcciones y por ahí se manda dinero al buzón de alguien: las puertas son pocas y se nombran una por una.

const ROOT = join(__dirname, "..", "..");

function filesUnder(folder: string): string[] {
  return readdirSync(join(ROOT, folder)).flatMap((name) => {
    const path = join(folder, name);
    return statSync(join(ROOT, path)).isDirectory() ? filesUnder(path) : [path.replaceAll("\\", "/")];
  });
}

const sources = filesUnder("src")
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));

const naming = (pattern: RegExp) => sources.filter(({ text }) => pattern.test(text)).map(({ file }) => relative(".", file).replaceAll("\\", "/"));

describe("la salida de correo", () => {
  it("las funciones de la base se nombran en un solo archivo", () => {
    expect(naming(/private\.mail_(claim|sent|rejected|health)/)).toEqual(["src/services/mail/records.ts"]);
  });

  it("los adaptadores solo los arma el servicio", () => {
    expect(naming(/adapters\/(resend|mailpit)\//)).toEqual(["src/services/mail/mail.ts"]);
  });

  it("nadie más le habla a Resend", () => {
    expect(naming(/api\.resend\.com/)).toEqual(["src/adapters/resend/send.ts"]);
  });

  it("la llave de Resend no se lee fuera de la salida de correo y la configuración", () => {
    expect(naming(/RESEND_API_KEY/)).toEqual(["src/config/env.ts", "src/services/mail/mail.ts"]);
  });

  it("en local manda el buzón, y lo decide antes de mirar la llave", () => {
    const text = readFileSync(join(ROOT, "src/services/mail/mail.ts"), "utf8");
    expect(text.indexOf('env.APP_ENV === "local"')).toBeGreaterThan(-1);
    expect(text.indexOf('env.APP_ENV === "local"')).toBeLessThan(text.indexOf("env.RESEND_API_KEY"));
  });

  it("el barrido está programado", () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { crons: { path: string }[] };
    expect(vercel.crons.map((cron) => cron.path)).toContain("/api/trabajos/correo");
  });
});
