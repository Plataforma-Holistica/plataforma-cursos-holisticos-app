import "server-only";

import { cookies, headers } from "next/headers";

import type { CookieJar, CookieReader, RequestOrigin } from "@/services/account/account";

// La petición, leída en un solo lugar (TRD §4.2). Es el único archivo que llama a
// `cookies()` y a `headers()`: las páginas, las acciones y las rutas piden aquí lo que
// necesitan, y los servicios reciben un tarro o un origen sin conocer a Next.
//
// Nada de lo que sale de aquí es de fiar por venir de aquí: las cookies y las cabeceras
// las manda quien pide. Qué se les cree lo deciden los servicios.

/** Las cookies de la petición, para una página: se leen, no se escriben. */
export async function cookieReader(): Promise<CookieReader> {
  const store = await cookies();
  return { get: (name) => store.get(name)?.value };
}

/**
 * Las cookies de la petición, para una acción de servidor o una ruta, que son las que
 * pueden escribirlas. En una página, escribir lanza: ahí se usa `cookieReader`.
 */
export async function cookieJar(): Promise<CookieJar> {
  const store = await cookies();
  return {
    get: (name) => store.get(name)?.value,
    set: (name, value, options) => {
      store.set(name, value, options);
    },
  };
}

/**
 * De dónde viene la petición, tal como llegó: la cabecera de la dirección y la del
 * navegador, sin tocar. El servicio decide si a la dirección se le cree (`origin.ts`).
 */
export async function requestOrigin(): Promise<RequestOrigin> {
  const list = await headers();
  return { realIp: list.get("x-real-ip"), userAgent: list.get("user-agent") };
}

/** La llave que trae la petición en `Authorization: Bearer`, tal como llegó, o nulo. Si vale lo decide el servicio. */
export async function bearerToken(): Promise<string | null> {
  const value = (await headers()).get("authorization");
  return value?.startsWith("Bearer ") === true ? value.slice("Bearer ".length) : null;
}

/** La firma de un aviso de Stripe (`Stripe-Signature`), tal como llegó, o nulo. Si vale lo decide el servicio. */
export async function stripeSignature(): Promise<string | null> {
  return (await headers()).get("stripe-signature");
}
