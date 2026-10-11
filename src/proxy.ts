import { NextResponse, type NextRequest } from "next/server";

import { refreshSession, type CookieJar, type CookieOptions } from "@/services/account/session";

// El paso previo (TRD §4.2 y §9.2, fila «Token de acceso»). Next lo corre antes de cada
// petición a su alcance, y hace una sola cosa: renovar la sesión cuando a su token le
// queda poco, que es algo que una página no puede hacer porque no escribe cookies.
//
// No es el control. No lee la base, no corre la guarda de sesión y todavía no redirige:
// haber pasado por aquí no dice que la persona tenga sesión, y la autorización se repite
// en cada acción y en cada página.

interface CookieWrite {
  name: string;
  value: string;
  options: CookieOptions;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const writes: CookieWrite[] = [];
  const jar: CookieJar = {
    get: (name) => writes.findLast((write) => write.name === name)?.value ?? request.cookies.get(name)?.value,
    set: (name, value, options) => {
      writes.push({ name, value, options });
    },
  };

  try {
    await refreshSession(jar);
  } catch {
    // Nunca lanza: un error aquí sería un error en cada página del sitio. La petición
    // sigue con la cookie que traía, y quien necesite la sesión la revisa por su cuenta.
    console.error("El paso previo no pudo revisar la sesión.");
    return NextResponse.next();
  }

  if (writes.length === 0) return NextResponse.next();

  // Primero la petición: la página y la acción de esta misma petición ya ven la cookie
  // nueva. La respuesta copia las cabeceras de la petición en el momento en que se crea.
  for (const write of writes) {
    if (write.options.maxAge === 0) request.cookies.delete(write.name);
    else request.cookies.set(write.name, write.value);
  }
  const response = NextResponse.next({ request: { headers: request.headers } });
  // Y después el navegador. Borrar es escribir vacío con sus atributos: con el prefijo
  // `__Host-`, un borrado sin `Secure` y sin `Path=/` el navegador lo ignora.
  for (const write of writes) response.cookies.set(write.name, write.value, write.options);
  // Una respuesta que escribe la cookie de una persona no se guarda en ninguna caché.
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  return response;
}

export const config = {
  // Todo menos los archivos estáticos. Es amplio a propósito: una acción de servidor es
  // una petición a la ruta de su página, y fuera de este alcance no pasaría por aquí.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)"],
};
