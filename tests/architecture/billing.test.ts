import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Los avisos de Stripe (T-303). Con la bandeja el servidor registra cobros y da acceso: las puertas son pocas y se nombran una por una.

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

describe("los avisos de Stripe", () => {
  it("las funciones de la bandeja se nombran en un solo archivo", () => {
    expect(naming(/private\.(provider_event_|provider_events_(health|list|count)|billing_apply)/)).toEqual(["src/services/billing/records.ts"]);
  });

  it("ninguna pantalla ni servicio nombra las tablas de la bandeja ni el libro de lo que liquida Stripe", () => {
    expect(naming(/provider_events\b|provider_event_actions|provider_settlements/).filter((file) => file !== "src/services/billing/records.ts")).toEqual([]);
  });

  it("las funciones de la conciliación se nombran en un solo archivo, y sus tablas en ninguno (T-303, cuarta solicitud)", () => {
    expect(naming(/private\.billing_(reconciliation_|settlement)/)).toEqual(["src/services/billing/records.ts"]);
    expect(naming(/billing_reconciliations\b|billing_reconciliation_differences|billing_reconciliation_notes/)).toEqual([]);
  });

  it("el adaptador solo lo arma el servicio", () => {
    expect(naming(/adapters\/stripe\//)).toEqual([
      "src/services/billing/billing.ts",
      "src/services/billing/inbox.ts",
      "src/services/billing/reconcile.ts",
      "src/services/billing/stripe-read.ts",
    ]);
    expect(naming(/createStripeApi\(/).filter((file) => !file.startsWith("src/adapters/"))).toEqual(["src/services/billing/billing.ts"]);
  });

  it("nadie más le habla a Stripe", () => {
    expect(naming(/api\.stripe\.com/)).toEqual(["src/adapters/stripe/api.ts"]);
  });

  it("las llaves de Stripe no se leen fuera de la configuración y el servicio", () => {
    expect(naming(/STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET/)).toEqual(["src/config/env.ts", "src/services/billing/billing.ts"]);
  });

  it("la firma de un aviso se lee en el contexto de la petición, y la verifica el servicio", () => {
    expect(naming(/["'`]stripe-signature["'`]/)).toEqual(["src/app/_lib/request-context.ts"]);
    expect(naming(/checkStripeSignature\(/).filter((file) => file !== "src/services/billing/signature.ts")).toEqual(["src/services/billing/inbox.ts"]);
  });

  it("el barrido está programado", () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { crons: { path: string }[] };
    expect(vercel.crons.map((cron) => cron.path)).toContain("/api/trabajos/avisos");
    expect(vercel.crons.map((cron) => cron.path)).toContain("/api/trabajos/conciliacion");
  });

  it("las tres rutas declaran su duración: el tope de la entrega, lo que sigue detrás de la respuesta, el barrido y la conciliación no dependen de lo que Vercel ponga por omisión", () => {
    for (const file of [
      "src/app/api/webhooks/stripe/route.ts",
      "src/app/api/trabajos/avisos/route.ts",
      "src/app/api/trabajos/conciliacion/route.ts",
      // «Comparar ahora» corre como acción de la página de administración (T-303, cuarta solicitud).
      "src/app/admin/[...resto]/page.tsx",
    ]) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).toMatch(/^export const maxDuration = \d+;$/m);
    }
  });

  it("el proxy deja fuera la ruta de los avisos, y nada más de lo que cuida", () => {
    const source = readFileSync(join(ROOT, "src/proxy.ts"), "utf8");
    const literal = /matcher: \["(.+)"\]/.exec(source)?.[1];
    expect(literal).toBeDefined();
    // El matcher es un texto de TypeScript: sus barras invertidas van dobladas.
    const matcher = new RegExp(`^${literal!.replaceAll("\\\\", "\\")}$`);
    expect(matcher.test("/api/webhooks/stripe")).toBe(false);
    // Otra ruta bajo el mismo prefijo no queda fuera sola: dejarla fuera es decidirlo aquí.
    for (const path of ["/", "/inicio", "/api/trabajos/avisos", "/api/trabajos/conciliacion", "/api/trabajos/correo", "/admin/periodos", "/api/webhooksx", "/api/webhooks/otra", "/api/webhooks/stripe/x", "/api/webhooks/stripex"]) {
      expect(matcher.test(path)).toBe(true);
    }
  });
});
