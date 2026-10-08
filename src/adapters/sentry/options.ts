import type { ErrorEvent, init } from "@sentry/nextjs";

import { scrubEvent } from "./scrub";

// Cómo se enciende Sentry, igual en el servidor y en el navegador. Solo errores: sin
// trazas, sin registros y sin grabación de sesiones. Cada una de esas cosas se decide
// aparte, con su costo y con lo que recolecta.

type DataCollection = NonNullable<NonNullable<Parameters<typeof init>[0]>["dataCollection"]>;

// Desde la versión 11 del SDK, lo que no se apaga se recolecta. `satisfies` obliga a
// decidir cada categoría: si una versión nueva agrega otra, esto deja de compilar hasta
// que alguien la apague aquí o explique por qué se queda.
//
// `frameContextLines` se queda en su valor: son líneas de nuestro código, no datos.
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
} satisfies Required<Omit<DataCollection, "frameContextLines">>;

export function buildOptions({ dsn, environment }: { dsn: string; environment: string }) {
  return {
    dsn,
    environment,
    dataCollection: DATA_COLLECTION,
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
  };
}
