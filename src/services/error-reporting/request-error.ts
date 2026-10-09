import { captureRequestError } from "@/adapters/sentry/request-error";

// Lo que el arranque le entrega a Next para que lo llame cada vez que falla una petición
// (RNF-16). Sirve en Node y en Edge: no importa nada que sea solo de Node.
export const reportRequestError = captureRequestError;
