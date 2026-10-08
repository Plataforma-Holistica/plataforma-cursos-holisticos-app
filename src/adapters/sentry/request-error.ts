import { captureRequestError as capture } from "@sentry/nextjs";

/**
 * Lo que Next llama cuando falla una petición en el servidor: una página, una ruta, una
 * acción o el `proxy`. Si Sentry no está encendido, no hace nada.
 *
 * Vive aparte de `server.ts` porque el arranque lo importa de forma fija, y el arranque se
 * compila también para el entorno Edge: aquí no puede haber nada que sea solo de Node.
 */
export const captureRequestError = capture;
