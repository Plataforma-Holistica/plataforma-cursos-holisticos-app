import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { posix, sourceFiles, src } from "./sources";

// Las alertas de anomalía y las decisiones de finanzas (T-208): por dónde se le pregunta a la base,
// quién decide y qué no sale de ella. Lo que hace cada respuesta lo prueban
// `src/services/anomalies/*.test.ts` y `src/app/admin/_alertas/*.test.ts`; aquí, la forma.

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: withoutComments(readFileSync(path, "utf8")) }));
const codeOf = (file: string) => sources.find((source) => source.file === file)?.text ?? "";
const alerts = codeOf("src/services/anomalies/alerts.ts");
const store = codeOf("src/services/anomalies/store.ts");
const records = codeOf("src/services/anomalies/records.ts");

const bodyOf = (name: string) => {
  const start = alerts.indexOf(`  async function ${name}(`);
  const end = alerts.indexOf("\n  }\n", start);
  return start === -1 || end === -1 ? "" : alerts.slice(start, end);
};

describe("las alertas pasan por las funciones de la base", () => {
  it("hay archivos que revisar", () => {
    for (const code of [alerts, store, records]) expect(code.length).toBeGreaterThan(0);
  });

  it.each(["finance_alerts", "review_alert", "exclude_alert_account", "revoke_exclusion"])("private.%s() se nombra en un solo archivo, una vez", (name) => {
    const naming = sources.filter((source) => new RegExp(`private\\.${name}\\b`).test(source.text)).map((source) => source.file);
    expect(naming).toEqual(["src/services/anomalies/records.ts"]);
    expect(records.match(new RegExp(`private\\.${name}\\(`, "g"))).toHaveLength(1);
  });

  it("la aplicación no excluye por identificador de cuenta, ni detecta, ni marca pares: solo la base", () => {
    const naming = sources.filter((source) => /private\.(exclude_consumption|detect_anomalies|mark_pairs_for|alert_account_token)\b/.test(source.text));
    expect(naming.map((source) => source.file)).toEqual([]);
  });

  it("nada de la aplicación nombra las tablas: las lee y las escribe la base", () => {
    const naming = sources.filter((source) => /\b(anomaly_alerts|consumption_exclusions|suspended_for_fraud)\b/.test(source.text));
    expect(naming.map((source) => source.file)).toEqual([]);
  });

  it("el almacén abre sus transacciones como servidor, y solo así", () => {
    expect(store).toMatch(/import \{ asServer \} from "@\/adapters\/supabase\/db";/);
    expect(store).not.toMatch(/\bas(?:User|System)\b/);
    expect(records).not.toMatch(/\bas(?:Server|User|System)\(/);
  });

  it("el servicio no abre transacciones ni lee la base por su cuenta", () => {
    expect(alerts).not.toMatch(/adapters\/supabase\/db|adapters\/supabase\/auth["']/);
    expect(alerts).not.toMatch(/\bas(?:User|Server|System)\(/);
  });

  it("la guarda pide Finanzas, y cada decisión la corre antes que cualquier otra cosa", () => {
    expect(bodyOf("admit")).toMatch(/const team = await core\.teamStanding\(reader\);[\s\S]*holds\(team\.standing, "finance"\)/);
    for (const name of ["reviewAlert", "decideFraud", "excludeAccount", "revokeExclusion"]) {
      expect(bodyOf(name), name).toMatch(new RegExp(`^ {2}async function ${name}\\([^)]*\\)[^{]*\\{\\n {4}const admitted = await admit\\(reader\\);`));
    }
    expect(bodyOf("giveFinanceCode")).toMatch(/^ {2}async function giveFinanceCode\([^)]*\)[^{]*\{\n {4}const admitted = await admit\(jar\);/);
  });

  it("de una cuenta solo viaja su huella: el servicio no recibe ni pasa un identificador de cuenta", () => {
    expect(alerts).not.toMatch(/\bprofile(?:_id|Id)\b/);
    expect(records).not.toMatch(/\bprofile(?:_id|Id)\b/);
    const screen = sources.filter((source) => source.file.startsWith("src/app/admin/_alertas/"));
    expect(screen.length).toBeGreaterThan(0);
    for (const source of screen) expect(source.text, source.file).not.toMatch(/\bprofile(?:_id|Id)\b/);
  });

  it("las pantallas llegan por anomalies.ts, nunca a alerts.ts, store.ts ni records.ts", () => {
    const outside = sources.filter((source) => /^src\/(app|jobs)\//.test(source.file) && /services\/anomalies\/(?!anomalies\b)/.test(source.text));
    expect(outside.map((source) => source.file)).toEqual([]);
  });
});
