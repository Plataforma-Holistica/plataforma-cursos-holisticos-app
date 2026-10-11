import { NextResponse, type NextRequest } from "next/server";

import { closedSessionRoute } from "@/app/_lib/guard-steps";
import { cookieJar } from "@/app/_lib/request-context";
import { closeRejectedSession } from "@/services/account/account";
import { leaveNotice } from "@/services/account/notice";

// La ruta que cierra una sesión que la guarda rechazó (flujo de la app §6.2). Existe porque
// una página no puede borrar una cookie: cuando la guarda le contesta «esta sesión no
// vale», la página manda aquí.
//
// No recibe parámetros y no le cree nada a quien llega: el servicio vuelve a correr la
// guarda y solo cierra si ella lo dice. Con una sesión que sí vale no pasa nada, así que un
// enlace a esta ruta puesto en otro sitio no le cierra la sesión a nadie. «Salir», que sí
// es decisión de la persona, es una acción de servidor.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const jar = await cookieJar();
  const { to, notice } = closedSessionRoute(await closeRejectedSession(jar));
  if (notice) leaveNotice(jar, notice);
  const response = NextResponse.redirect(new URL(to, request.nextUrl));
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  return response;
}

// Sin esto Next contestaría una petición HEAD corriendo el GET, con sus efectos.
export function HEAD(): Response {
  return new Response(null, { status: 405, headers: { Allow: "GET" } });
}
