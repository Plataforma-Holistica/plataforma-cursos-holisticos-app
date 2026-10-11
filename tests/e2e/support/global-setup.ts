import { existsSync } from "node:fs";

import { assertLocalStack } from "../../integration/helpers/local";

import { removeLeftovers } from "./stack";

// Las pruebas de extremo a extremo usan las mismas variables que la aplicación. En local
// salen de `.env.local`; en la integración continua ya vienen en el entorno.
//
// Entran a la base como dueño y usan la llave secreta de Auth para preparar y limpiar:
// antes de la primera, se comprueba que todo lo que van a tocar es la pila local.
export default async function setup(): Promise<() => Promise<void>> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  assertLocalStack();
  if (process.env.NEXT_PUBLIC_SITE_URL !== "http://localhost:3000") {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL debe ser http://localhost:3000: es a donde apuntan los enlaces de los correos del Auth local.",
    );
  }
  // Lo que haya dejado una corrida que se cortó a la mitad.
  await removeLeftovers();
  return removeLeftovers;
}
