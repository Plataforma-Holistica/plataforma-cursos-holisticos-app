import type { ErrorEvent, init } from "@sentry/nextjs";

import { scrubEvent } from "./scrub";

// Cómo se enciende Sentry, igual en el servidor y en el navegador. Solo errores: sin
// trazas, sin registros, sin métricas y sin grabación de sesiones. Cada una de esas cosas
// se decide aparte, con su costo y con lo que recolecta.
//
// «Solo errores» no se consigue con no pedir lo demás: el SDK prende cosas por su cuenta
// (lee variables de entorno, trae integraciones por omisión). Aquí cada una va apagada de
// forma explícita, y además con su puerta cerrada, porque lo que no es un error no pasa
// por `beforeSend`.

type DataCollection = NonNullable<NonNullable<Parameters<typeof init>[0]>["dataCollection"]>;

// Requerido también por dentro: `Required` solo obliga al primer nivel, y una clave nueva
// dentro de `graphQL` o de `genAI` quedaría prendida sin que nada avisara.
type DeepRequired<T> = T extends readonly (infer Item)[]
  ? Item[]
  : T extends object
    ? { [Key in keyof T]-?: DeepRequired<T[Key]> }
    : T;

// Desde la versión 11 del SDK, lo que no se apaga se recolecta. `satisfies` obliga a
// decidir cada categoría: si una versión nueva agrega otra, a cualquier profundidad, esto
// deja de compilar hasta que alguien la apague aquí o explique por qué se queda.
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
} satisfies DeepRequired<Omit<DataCollection, "frameContextLines">>;

// El mismo tope que usa el filtro (`scrub.ts`): el SDK recorta antes, el filtro revisa.
const MAX_VALUE_LENGTH = 2_000;

export function buildOptions({ dsn, environment }: { dsn: string; environment: string }) {
  return {
    dsn,
    environment,
    dataCollection: DATA_COLLECTION,
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
    maxValueLength: MAX_VALUE_LENGTH,

    // Sin trazas. Dicho con un cero, no con una ausencia: si falta, el SDK lee la variable
    // SENTRY_TRACES_SAMPLE_RATE, y alguien podría prenderlas desde el panel de Vercel.
    tracesSampleRate: 0,
    beforeSendTransaction: () => null,
    // Ninguna cabecera de rastreo hacia terceros: ni a la base, ni a cobros, ni al video.
    tracePropagationTargets: [] as string[],

    // Sin registros ni métricas.
    enableLogs: false,
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
  };
}
