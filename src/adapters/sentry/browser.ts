import { publicEnv } from "@/config/public-env";

import { buildOptions } from "./options";
import { onlyErrors } from "./transport";

// Sentry en el navegador (RNF-16). Lo enciende `src/instrumentation-client.ts`.
//
// El SDK pesa unos 60 KB comprimidos y casi ninguna visita lo necesita, así que no viaja
// con la página: se pide aparte (`import()`), cuando el navegador queda libre o en el
// momento en que hay un error que reportar. Mientras llega, los errores que ocurran se
// guardan aquí y se le entregan en cuanto está listo.
//
// Este archivo viaja al navegador: no importa `@/config/env` ni nada del servidor.

type Sdk = typeof import("./browser-sdk");

/**
 * Cómo llegó un error: es lo que Sentry muestra como «atrapado» o «sin atrapar». Los dos
 * primeros son los nombres que les pone el SDK cuando los atrapa él: el mismo error no
 * debe verse distinto según si llegó antes o después de que el SDK cargara.
 */
const ON_ERROR = "auto.browser.global_handlers.onerror";
const ON_REJECTION = "auto.browser.global_handlers.onunhandledrejection";
const CAUGHT = "generic";
type Mechanism = typeof ON_ERROR | typeof ON_REJECTION | typeof CAUGHT;

interface Early {
  error: unknown;
  type: Mechanism;
}

// Una página que falla en bucle no debe llenar la memoria mientras el SDK llega.
const MAX_EARLY_ERRORS = 10;

// Ni pedirlo a la red una vez por cada error: con un bloqueador, no va a llegar nunca.
const MAX_LOAD_ATTEMPTS = 3;

// Cuánto se espera, como mucho, a que el navegador quede libre. En una pestaña de fondo
// el reposo puede no llegar nunca.
const IDLE_TIMEOUT_MS = 2000;

// Las integraciones que se quedan. Una lista de permitidas y no de prohibidas: cada
// versión del SDK agrega alguna, que con una lista de prohibidas entraría prendida sin
// que nadie la viera. Las que no están aquí mandan algo más que errores: el aviso de
// cada visita, la medición de la navegación, lo escrito en la consola, el idioma y la
// zona horaria de la persona. El rastro (Breadcrumbs) se vuelve a poner abajo, recortado.
//
// Una integración nueva se agrega aquí después de leer qué recolecta.
const ALLOWED = new Set([
  // Descarta lo que no vale la pena mandar y evita repetir el mismo error.
  "EventFilters",
  "Dedupe",
  // Arman bien el error: su causa encadenada y el nombre de las funciones.
  "FunctionToString",
  "LinkedErrors",
  // Atrapan lo que nadie atrapó.
  "BrowserApiErrors",
  "GlobalHandlers",
  // En qué página pasó. El filtro deja la dirección sin sus parámetros.
  "HttpContext",
  // De Next: traduce las rutas de los pedazos para que la pila se lea.
  "NextjsClientStackFrameNormalization",
]);

let sdk: Promise<Sdk> | undefined;
let failures = 0;
let listening = false;
const early: Early[] = [];

// Si el SDK no llega (sin red, o un bloqueador lo detuvo) no hay a quién reportarle.
const ignore = () => {};

function keep(error: unknown, type: Mechanism): void {
  if (early.length < MAX_EARLY_ERRORS) early.push({ error, type });
}

const onError = (event: ErrorEvent) => {
  keep(event.error ?? event.message, ON_ERROR);
  loadNow();
};
const onRejection = (event: PromiseRejectionEvent) => {
  keep(event.reason, ON_REJECTION);
  loadNow();
};

function stopListening(): void {
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  listening = false;
}

/** Ya no se va a pedir más: ni se escucha ni se guarda, porque nadie lo va a recoger. */
function giveUp(): void {
  stopListening();
  early.length = 0;
}

/** Pide el SDK y lo enciende, una sola vez, lo pida quien lo pida. */
function loadSdk(dsn: string): Promise<Sdk> {
  if (failures >= MAX_LOAD_ATTEMPTS) return Promise.reject(new Error("SDK no disponible"));

  sdk ??= import("./browser-sdk")
    .then((Sentry) => {
      Sentry.init({
        ...buildOptions({ dsn, environment: publicEnv.appEnv ?? "local" }),
        integrations: (defaults) => [
          ...defaults.filter(({ name }) => ALLOWED.has(name)),
          // El rastro de lo que pasó antes del error: por dónde se navegó y qué se pidió.
          // Sin los clics, que llevan el `aria-label` y el `title` de lo que se pulsó (el
          // nombre de un curso es un dato de quien lo toma), y sin la lista de eventos
          // anteriores, que repite sus mensajes.
          Sentry.breadcrumbsIntegration({ dom: false, sentry: false }),
        ],
        transport: onlyErrors(Sentry.makeFetchTransport),
      });
      // De aquí en adelante atrapa el SDK, que ya puso sus propios oyentes. Lo guardado
      // se le entrega una vez, diciendo cómo llegó: nadie atrapó un error de ventana.
      stopListening();
      for (const { error, type } of early.splice(0)) {
        Sentry.captureException(error, { mechanism: { type, handled: type === CAUGHT } });
      }
      return Sentry;
    })
    .catch((error: unknown) => {
      // Un fallo no se recuerda: una pestaña abierta durante un despliegue pide un pedazo
      // que ya no existe, y el intento siguiente puede sí encontrarlo. Pero se cuenta.
      sdk = undefined;
      failures += 1;
      if (failures >= MAX_LOAD_ATTEMPTS) giveUp();
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
    // Si el SDK no llegó, se guarda para el intento siguiente, mientras quede alguno.
    () => {
      if (failures < MAX_LOAD_ATTEMPTS) keep(error, CAUGHT);
    },
  );
}
