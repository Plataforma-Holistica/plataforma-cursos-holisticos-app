import { publicEnv } from "@/config/public-env";

import { buildOptions } from "./options";

// Sentry en el navegador (RNF-16). Lo enciende `src/instrumentation-client.ts`.
//
// El SDK pesa unos 60 KB comprimidos y casi ninguna visita lo necesita, así que no viaja
// con la página: se pide aparte (`import()`), cuando el navegador queda libre o en el
// momento en que hay un error que reportar. Mientras llega, los errores que ocurran se
// guardan aquí y se le entregan en cuanto está listo.
//
// Este archivo viaja al navegador: no importa `@/config/env` ni nada del servidor.

type Sdk = typeof import("./browser-sdk");

// Una página que falla en bucle no debe llenar la memoria mientras el SDK llega.
const MAX_EARLY_ERRORS = 10;

// Si el navegador no avisa cuándo queda libre (Safari tardó años), se espera esto.
const IDLE_FALLBACK_MS = 2000;

let sdk: Promise<Sdk> | undefined;

/** Pide el SDK y lo enciende, una sola vez, lo pida quien lo pida. */
function loadSdk(dsn: string): Promise<Sdk> {
  sdk ??= import("./browser-sdk").then((Sentry) => {
    Sentry.init({
      ...buildOptions({ dsn, environment: publicEnv.appEnv ?? "local" }),
      // Por omisión el navegador le avisa a Sentry de cada visita, haya error o no, para
      // calcular qué porcentaje de visitas falla. Aquí solo salen errores.
      integrations: (defaults) => defaults.filter(({ name }) => name !== "BrowserSession"),
    });
    return Sentry;
  });
  return sdk;
}

// Si el SDK no llega (sin red, o un bloqueador lo detuvo) no hay a quién reportarle.
const ignore = () => {};

function whenIdle(task: () => void): void {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(task);
  else window.setTimeout(task, IDLE_FALLBACK_MS);
}

/** Sin dirección no se enciende, y el navegador no manda ni descarga nada. */
export function startBrowserErrorReporting(): void {
  const dsn = publicEnv.sentryDsn;
  if (!dsn) return;

  const early: unknown[] = [];
  const keep = (error: unknown) => {
    if (early.length < MAX_EARLY_ERRORS) early.push(error);
  };
  const onError = (event: ErrorEvent) => keep(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => keep(event.reason);

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  whenIdle(() => {
    loadSdk(dsn).then((Sentry) => {
      // De aquí en adelante atrapa el SDK, que ya puso sus propios oyentes.
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      for (const error of early) Sentry.captureException(error);
    }, ignore);
  });
}

/**
 * Un error que una pantalla atrapó. Pide el SDK en ese momento, si no había llegado: ya
 * hay una pantalla de error a la vista, y lo que importa es no perderlo.
 */
export function captureBrowserError(error: unknown): void {
  const dsn = publicEnv.sentryDsn;
  if (!dsn) return;

  loadSdk(dsn).then((Sentry) => Sentry.captureException(error), ignore);
}
