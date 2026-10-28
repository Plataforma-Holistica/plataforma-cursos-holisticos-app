import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// Los periodos, el ensayo y el cierre desde la aplicación (T-605): por dónde se le pregunta a la base,
// quién decide y qué no sale de ella. Lo que hace cada respuesta lo prueban `src/services/periods/*.test.ts`
// y `src/app/admin/_periodos/*.test.ts`; aquí, la forma.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const codeOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";
const panel = codeOf("src/services/periods/panel.ts");
const store = codeOf("src/services/periods/store.ts");
const records = codeOf("src/services/periods/records.ts");
const payouts = codeOf("src/services/periods/payouts.ts");

const bodyOf = (name: string, code = panel) => {
  const start = code.indexOf(`  async function ${name}(`);
  const end = code.indexOf("\n  }\n", start);
  return start === -1 || end === -1 ? "" : code.slice(start, end);
};

describe("los periodos pasan por las funciones de la base", () => {
  it("hay archivos que revisar", () => {
    for (const code of [panel, store, records, payouts]) expect(code.length).toBeGreaterThan(0);
  });

  it.each([
    ["finance_periods", 1],
    ["finance_period", 1],
    // La lectura del cierre, y la revisión de «un ensayo por minuto» antes de ensayar.
    ["finance_close", 2],
    ["request_rollup", 1],
    ["rehearse_close", 1],
    ["close_period", 1],
    ["close_export_download", 1],
    // PA-81 (T-605, cuarta solicitud): la lectura, que anular también usa para saber si el bono es del fundador.
    ["finance_payouts", 1],
    ["release_payouts", 1],
    ["hold_payout", 1],
    ["unhold_payout", 1],
    ["confirm_founder_bonus", 1],
    ["void_bonus", 1],
  ] as const)("private.%s() se nombra solo en records.ts, %i veces", (name, times) => {
    const naming = sources.filter((source) => new RegExp(`private\\.${name}\\b`).test(source.text)).map((source) => source.file);
    expect(naming).toEqual(["src/services/periods/records.ts"]);
    expect(records.match(new RegExp(`private\\.${name}\\(`, "g"))).toHaveLength(times);
  });

  it("nada de la aplicación nombra las tablas del cierre: las lee y las escribe la base", () => {
    const naming = sources.filter((source) => /\b(close_exports|close_runs|rollup_requests|payout_periods|close_run_teacher_totals|job_runs)\b/.test(source.text));
    expect(naming.map((source) => source.file)).toEqual([]);
  });

  it("el almacén abre sus transacciones como servidor, y solo así", () => {
    expect(store).toMatch(/import \{ asServer \} from "@\/adapters\/supabase\/db";/);
    expect(store).not.toMatch(/\bas(?:User|System)\b/);
    expect(records).not.toMatch(/\bas(?:Server|User|System)\(/);
  });

  it("el servicio no abre transacciones ni lee la base por su cuenta", () => {
    for (const code of [panel, payouts]) {
      expect(code).not.toMatch(/adapters\/supabase\/db|adapters\/supabase\/auth["']/);
      expect(code).not.toMatch(/\bas(?:User|Server|System)\(/);
    }
  });

  it("nadie de la aplicación calcula las vistas de liberar o soltar, ni captura: eso es de la base y de PA-83", () => {
    const naming = sources.filter((source) => /private\.(release_preview|unhold_preview|capture_bonus|capture_adjustment)\b/.test(source.text));
    expect(naming.map((source) => source.file)).toEqual([]);
  });

  it("en las liquidaciones, la guarda pide finanzas y cada decisión la corre antes que cualquier otra cosa", () => {
    expect(bodyOf("admit", payouts)).toMatch(/const team = await core\.teamStanding\(reader\);[\s\S]*holds\(team\.standing, "finance"\)/);
    for (const name of ["releasePayouts", "holdPayout", "unholdPayout", "confirmFounderBonus", "voidFounderBonus"]) {
      expect(bodyOf(name, payouts), name).toMatch(new RegExp(`^ {2}async function ${name}\\([^)]*\\)[^{]*\\{\\n {4}const admitted = await admit\\(reader\\);`));
    }
  });

  it("el freno de producción se revisa antes de liberar, y lo arma periods.ts con APP_ENV", () => {
    expect(bodyOf("releasePayouts", payouts)).toMatch(/if \(!deps\.releaseEnabled\(\)\) return \{ kind: "not_enabled" \};\n {4}const result = await decide\(\(\) => store\.release\(/);
    expect(codeOf("src/services/periods/periods.ts")).toMatch(/releaseEnabled: \(\) => getEnv\(\)\.APP_ENV !== "production"/);
  });

  it("la guarda pide finanzas, y cada decisión la corre antes que cualquier otra cosa", () => {
    expect(bodyOf("admit")).toMatch(/const team = await core\.teamStanding\(reader\);[\s\S]*holds\(team\.standing, "finance"\)/);
    for (const name of ["requestRollup", "rehearse", "closePeriod", "downloadExport"]) {
      expect(bodyOf(name), name).toMatch(new RegExp(`^ {2}async function ${name}\\([^)]*\\)[^{]*\\{\\n {4}const admitted = await admit\\(reader\\);`));
    }
    expect(bodyOf("givePeriodsCode")).toMatch(/^ {2}async function givePeriodsCode\([^)]*\)[^{]*\{\n {4}const admitted = await admit\(jar\);/);
  });

  it("ni el servicio ni las pantallas reciben un identificador de alumno", () => {
    for (const code of [panel, records, payouts]) expect(code).not.toMatch(/\b(student|profile)(?:_id|Id)\b/);
    const screens = sources.filter((source) => source.file.startsWith("src/app/admin/_periodos/"));
    expect(screens.length).toBeGreaterThan(0);
    for (const source of screens) expect(source.text, source.file).not.toMatch(/\b(student|profile)(?:_id|Id)\b/);
  });

  it("las pantallas llegan por periods.ts, nunca a panel.ts, store.ts ni records.ts", () => {
    const outside = sources.filter((source) => /^src\/(app|jobs)\//.test(source.file) && /services\/periods\/(?!periods\b)/.test(source.text));
    expect(outside.map((source) => source.file)).toEqual([]);
  });

  it("lo que viaja al navegador no importa nada del servidor", () => {
    for (const file of ["outcomes.ts", "failures.ts", "panel-screen.tsx", "close-screen.tsx"]) {
      const code = codeOf(`src/app/admin/_periodos/${file}`);
      expect(code.length, file).toBeGreaterThan(0);
      // Del servicio, solo tipos.
      expect(code, file).not.toMatch(/^import \{[^}]*\} from "@\/services\/periods\/periods";/m);
    }
  });

  it("el servicio y las pantallas tienen dueño en CODEOWNERS", () => {
    const owners = readFileSync(join(src, "..", ".github", "CODEOWNERS"), "utf8");
    expect(owners).toMatch(/^\/src\/services\/periods\/\s+@SerchFGA @plataformaholisticadev$/m);
    expect(owners).toMatch(/^\/src\/app\/admin\/_periodos\/\s+@SerchFGA @plataformaholisticadev$/m);
  });
});
