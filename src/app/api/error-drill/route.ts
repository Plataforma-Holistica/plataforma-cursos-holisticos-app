import { ErrorDrill, errorDrillAllowed } from "@/services/error-reporting/server";

// El simulacro del registro de errores (RNF-16): pedir esta dirección provoca un error a
// propósito, para comprobar que llega a Sentry y que la alerta le llega a una persona.
//
// En producción no existe. En el entorno de pruebas solo la alcanza quien tiene el acceso
// de Vercel, que es lo que protege las vistas previas.

// Sin esto Next podría resolver la ruta al compilar, y el error rompería la compilación.
export const dynamic = "force-dynamic";

export function GET(): Response {
  if (!errorDrillAllowed()) return new Response(null, { status: 404 });

  throw new ErrorDrill();
}
