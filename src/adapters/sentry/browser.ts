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

/** Cómo llegó un error: es lo que Sentry muestra como «atrapado» o «sin atrapar». */
type Mechanism = "onerror" | "onunhandledrejection" | "generic";

interface Early {
  error: unknown;
  type: Mechanism;
}

// Una página que falla en bucle no debe llenar la memoria mientras el SDK llega.
const MAX_EARLY_ERRORS = 10;

// Cuánto se espera, como mucho, a que el navegador quede libre. En una pestaña de fondo
// el reposo puede no llegar nunca.
const IDLE_TIMEOUT_MS = 2000;

// Lo que el SDK trae prendido y manda algo más que errores:
//   - BrowserSession le avisa a Sentry de cada visita, haya error o no;
//   - BrowserTracing mide la navegación y parchea `fetch` y el historial;
//   - Console guarda como contexto de cada error lo que se haya escrito en la consola;
//   - Breadcrumbs se vuelve a poner abajo, sin los clics.
const DROPPED = new Set(["BrowserSession", "BrowserTracing", "Console", "Breadcrumbs"]);

let sdk: Promise<Sdk> | undefined;
let listening = false;
const early: Early[] = [];

// Si el SDK no llega (sin red, o un bloqueador lo detuvo) no hay a quién reportarle.
const ignore = () => {};

function keep(error: unknown, type: Mechanism): void {
  if (early.length < MAX_EARLY_ERRORS) early.push({ error, type });
}

const onError = (event: ErrorEvent) => {
  keep(event.error ?? event.message, "onerror");
  loadNow();
};
const onRejection = (event: PromiseRejectionEvent) => {
  keep(event.reason, "onunhandledrejection");
  loadNow();
};

function stopListening(): void {
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  listening = false;
}

/** Pide el SDK y lo enciende, una sola vez, lo pida quien lo pida. */
function loadSdk(dsn: string): Promise<Sdk> {
  sdk ??= import("./browser-sdk")
    .then((Sentry) => {
      Sentry.init({
        ...buildOptions({ dsn, environment: publicEnv.appEnv ?? "local" }),
        integrations: (defaults) => [
          ...defaults.filter(({ name }) => !DROPPED.has(name)),
          // El rastro de lo que pasó antes del error (navegación y peticiones), sin los
          // clics: llevan el `aria-label` y el `title` de lo que se pulsó, y el nombre de
          // un curso es un dato de quien lo toma.
          Sentry.breadcrumbsIntegration({ dom: false }),
        ],
      });
      // De aquí en adelante atrapa el SDK, que ya puso sus propios oyentes. Lo guardado
      // se le entrega una vez, diciendo cómo llegó: nadie atrapó un error de ventana.
      stopListening();
      for (const { error, type } of early.splice(0)) {
        Sentry.captureException(error, { mechanism: { type, handled: type === "generic" } });
      }
      return Sentry;
    })
    .catch((error: unknown) => {
      // Un fallo no se recuerda: una pestaña abierta durante un despliegue pide un pedazo
      // que ya no existe, y el intento siguiente puede sí encontrarlo.
      sdk = undefined;
      throw error;
    });
  return sdk;
}

function loadNow(): void {
  const dsn = publicEnv.sentryDsn;
  if (dsn) loadSdk(dsn).catch(ignore);
}

function whenIdle(task: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
  } else {
    window.setTimeout(task, IDLE_TIMEOUT_MS);
  }
}

/** Sin dirección no se enciende, y el navegador no manda ni descarga nada. */
export function startBrowserErrorReporting(): void {
  if (!publicEnv.sentryDsn) return;

  // Un error temprano se guarda y además pide el SDK en ese momento: quien ve fallar la
  // página suele irse, y esperar el reposo sería perder el error con la pestaña.
  if (!listening) {
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    listening = true;
  }

  whenIdle(loadNow);
}

/**
 * Un error que una pantalla atrapó. Pide el SDK en ese momento, si no había llegado: ya
 * hay una pantalla de error a la vista, y lo que importa es no perderlo.
 */
export function captureBrowserError(error: unknown): void {
  const dsn = publicEnv.sentryDsn;
  if (!dsn) return;

  loadSdk(dsn).then(
    (Sentry) => Sentry.captureException(error),
    // Si el SDK no llegó, se guarda para el intento siguiente.
    () => keep(error, "generic"),
  );
}
