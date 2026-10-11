import { NextResponse, type NextRequest } from "next/server";

import { requestOrigin } from "@/app/_lib/request-context";
import { drillOrigin } from "@/services/account/origin";
import { errorDrillAllowed } from "@/services/error-reporting/server";

// La medición de la cabecera de la dirección (TRD §9.2, fila «Dirección de quien pide»):
// el freno de intentos, los topes y el dispositivo de confianza dependen de `x-real-ip`,
// que solo se cree detrás de un despliegue de Vercel. Esta ruta sirve para comprobar, en
// una vista previa, que un cliente no puede falsificarla: se le manda una petición con la
// cabecera falsificada y esa misma dirección como sonda, y contesta si lo que llegó al
// servidor es lo falsificado.
//
// Lee la petición por el mismo camino que una acción. Contesta banderas, nunca una
// dirección. En producción no existe, igual que el simulacro del registro de errores.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  if (!errorDrillAllowed()) return new Response(null, { status: 404 });

  const result = drillOrigin(await requestOrigin(), request.nextUrl.searchParams.get("probe") ?? "");
  if (result === null) return new Response(null, { status: 400 });

  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
