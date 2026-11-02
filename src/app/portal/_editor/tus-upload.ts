import type { DetailedError, UploadOptions } from "tus-js-client";

// Cómo sube un video por TUS (T-403, medido contra el Storage local). Es puro, y lo usa tal cual la integración 92 contra Storage de verdad.
//
//   · Trozos de 6 MB: Storage no acepta otro tamaño en su carga resumible.
//   · La huella lleva el id del video: reanudar nunca se confunde con otra lección que suba el mismo archivo. Se olvida al terminar.
//   · La firma va en cada petición, porque se valida en cada una: una subida larga pasa por varias.
//   · `upsert` no se manda: con el objeto ya confirmado, crear sí contesta, y es el `PATCH` el que contesta 409 con «already exists»
//     (medido). Eso no se reintenta: toca confirmar. Otro 409 es el de un avance que no coincide, y ese sí, como hace la biblioteca.

export const VIDEO_CHUNK_BYTES = 6 * 1024 * 1024;
export const VIDEO_RETRY_DELAYS = [0, 3000, 5000, 10_000, 20_000];

export interface VideoTarget {
  video: string;
  path: string;
  mime: string;
  bucket: string;
  endpoint: string;
}

export interface VideoTusHooks {
  /** La firma vigente: se pide antes de cada petición, y quien la da decide cuándo renovarla. */
  token: () => Promise<string>;
  onProgress: (sent: number, total: number) => void;
  onSuccess: () => void;
  onError: (error: Error | DetailedError) => void;
}

/** El objeto ya estaba: lo subió otra pestaña, o una respuesta se perdió. No hay nada que subir: falta confirmarlo. */
export function isObjectAlreadyThere(error: Error | DetailedError): boolean {
  if (!("originalResponse" in error)) return false;
  const response = error.originalResponse;
  return response?.getStatus() === 409 && (response.getBody() ?? "").toLowerCase().includes("already exists");
}

function shouldRetry(error: Error | DetailedError): boolean {
  if (isObjectAlreadyThere(error)) return false;
  const status = "originalResponse" in error ? (error.originalResponse?.getStatus() ?? 0) : 0;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  // Lo mismo que hace la biblioteca por omisión: un 4xx no cambia reintentando, salvo los dos que dicen «ahorita no».
  return !offline && (status < 400 || status >= 500 || status === 409 || status === 423);
}

export function videoTusOptions(target: VideoTarget, hooks: VideoTusHooks): UploadOptions {
  return {
    endpoint: target.endpoint,
    chunkSize: VIDEO_CHUNK_BYTES,
    retryDelays: VIDEO_RETRY_DELAYS,
    removeFingerprintOnSuccess: true,
    fingerprint: (file) => {
      const stamp = typeof File !== "undefined" && file instanceof File ? `${file.name}:${file.size}:${file.lastModified}` : "";
      return Promise.resolve(`video-upload:${target.video}:${stamp}`);
    },
    metadata: { bucketName: target.bucket, objectName: target.path, contentType: target.mime },
    onBeforeRequest: async (request) => {
      request.setHeader("x-signature", await hooks.token());
    },
    onShouldRetry: shouldRetry,
    onProgress: hooks.onProgress,
    onSuccess: hooks.onSuccess,
    onError: hooks.onError,
  };
}
