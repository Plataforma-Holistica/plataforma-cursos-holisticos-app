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
      "src/services/billing/checkout-service.ts",
      "src/services/billing/checkout-test-stripe.ts",
      "src/services/billing/checkout.ts",
      "src/services/billing/inbox.ts",
      "src/services/billing/reconcile.ts",
      "src/services/billing/stripe-read.ts",
    ]);
    expect(naming(/createStripeApi\(/).filter((file) => !file.startsWith("src/adapters/"))).toEqual(["src/services/billing/billing.ts", "src/services/billing/checkout-service.ts"]);
  });

  // La salida a pagar (T-302): la única que escribe en Stripe, con su propia llave; sus funciones de la base en un archivo; sus tablas en ninguno; y el Stripe de
  // prueba de local, solo detrás de `BILLING_CHECKOUT=test`.
  it("solo la salida a pagar escribe en Stripe, y con su propia llave", () => {
    expect(naming(/createStripeWriter\(/).filter((file) => !file.startsWith("src/adapters/"))).toEqual(["src/services/billing/checkout-service.ts"]);
    expect(naming(/STRIPE_CHECKOUT_KEY/)).toEqual(["src/config/env.ts", "src/services/billing/checkout-service.ts"]);
    expect(naming(/BILLING_CHECKOUT\b/)).toEqual(["src/config/env.ts", "src/services/billing/checkout-service.ts"]);
    expect(naming(/checkout-test-stripe/)).toEqual(["src/services/billing/checkout-service.ts"]);
  });

  it("las funciones de la salida a pagar se nombran en un solo archivo, y sus tablas en ninguno", () => {
    expect(naming(/private\.checkout_/)).toEqual(["src/services/billing/checkout-records.ts"]);
    expect(naming(/checkout_sessions\b|billing_customers\b/)).toEqual([]);
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

// Los precios de la portada (T-616, solicitud 4b): una memoria de un minuto, solo para la portada. Lo que acepta la persona (PA-04 y la
// salida a pagar) se lee fresco: si `/planes` leyera de la memoria, un precio que cambió daría `changed` y la pantalla volvería a
// mostrar el de antes.
describe("los precios de la portada", () => {
  it("la vitrina se nombra solo en su servicio y en la portada", () => {
    expect(naming(/\bplanShowcase\b/)).toEqual(["src/app/page.tsx", "src/services/billing/showcase-service.ts", "src/services/billing/showcase.ts"]);
    expect(naming(/\bcreatePlanShowcase\b/)).toEqual(["src/services/billing/showcase-service.ts", "src/services/billing/showcase.ts"]);
  });

  it("ni los planes, ni la confirmación, ni ninguna acción la tocan; y la portada no lee la oferta fresca", () => {
    const showcase = /showcase-service|\bplanShowcase\b/;
    const touching = sources.filter(({ file, text }) => (file.startsWith("src/app/planes/") || file.startsWith("src/app/suscripcion/") || /\/actions\.tsx?$/.test(file)) && showcase.test(text));
    expect(touching.map(({ file }) => file)).toEqual([]);
    expect(readFileSync(join(ROOT, "src/app/page.tsx"), "utf8")).not.toMatch(/\bplanOffer\b|checkout-service/);
  });

  it("la vitrina no sabe de Stripe ni del modo de prueba del cobro", () => {
    for (const file of ["src/services/billing/showcase.ts", "src/services/billing/showcase-service.ts"]) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/BILLING_CHECKOUT|STRIPE_|adapters\/stripe/);
    }
  });

  it("ningún texto escribe una cifra de precio: las pone la base", () => {
    const messages = filesUnder("src/messages").filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file));
    const priced = messages.filter((file) => /\$\s?\d/.test(readFileSync(join(ROOT, file), "utf8")));
    expect(priced).toEqual([]);
  });
});
