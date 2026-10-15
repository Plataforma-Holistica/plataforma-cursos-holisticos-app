import { NextResponse, type NextRequest } from "next/server";

import { proxySignsIn, signInPath } from "@/services/account/navigation";
import { refreshSession, type CookieJar, type CookieOptions, type SessionRefresh } from "@/services/account/session";

// El paso previo (TRD §4.2 y §9.2, fila «Token de acceso»). Next lo corre antes de cada
// petición a su alcance, y hace dos cosas: renovar la sesión cuando a su token le queda
// poco, que es algo que una página no puede hacer porque no escribe cookies, y mandar a
// entrar a quien pide una pantalla con sesión sin tener ninguna.
//
// No es el control. No lee la base y no corre la guarda de sesión: haber pasado por aquí no
// dice que la persona pueda entrar, solo que trae una cookie. La autorización se repite en
// cada acción y en cada página (flujo de la app §6.2).

interface CookieWrite {
  name: string;
  value: string;
  options: CookieOptions;
}

// Una respuesta que escribe la cookie de una persona, o que depende de si la trae, no se
// guarda en ninguna caché.
const NO_STORE = "private, no-cache, no-store, must-revalidate, max-age=0";

// El parámetro con que Next pide una pantalla al navegar dentro de la aplicación. No es
// parte de a dónde quería ir la persona.
const INTERNAL_PARAM = "_rsc";

/**
 * A dónde mandar a quien pide una pantalla con sesión sin tenerla, o nulo si esta petición
 * sigue su camino. Solo en una lectura: un 307 a un envío de formulario lo reenviaría a
 * otra pantalla, y su acción correría ahí. Y solo cuando la renovación dijo que no hay
 * sesión o que se perdió: «no se supo» no es lo mismo, y eso lo resuelve la guarda.
 */
function signInRedirect(request: NextRequest, refresh: SessionRefresh): URL | null {
  if (refresh.kind !== "none" && refresh.kind !== "lost") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname } = request.nextUrl;
  if (!proxySignsIn(pathname)) return null;

  const query = new URLSearchParams(request.nextUrl.search);
  query.delete(INTERNAL_PARAM);
  const search = query.toString();
  const [path = "", returning = ""] = signInPath(search === "" ? pathname : `${pathname}?${search}`).split("?");
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = returning;
  return url;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const writes: CookieWrite[] = [];
  const jar: CookieJar = {
    get: (name) => writes.findLast((write) => write.name === name)?.value ?? request.cookies.get(name)?.value,
    set: (name, value, options) => {
      writes.push({ name, value, options });
    },
  };

  let refresh: SessionRefresh;
  try {
    refresh = await refreshSession(jar);
  } catch {
    // Nunca lanza: un error aquí sería un error en cada página del sitio. La petición
    // sigue con la cookie que traía, y quien necesite la sesión la revisa por su cuenta.
    console.error("El paso previo no pudo revisar la sesión.");
    return NextResponse.next();
  }

  const signIn = signInRedirect(request, refresh);
  if (signIn) {
    const response = NextResponse.redirect(signIn);
    // Lo que la renovación escribió viaja también aquí: si borró la cookie de una sesión
    // perdida, el navegador tiene que enterarse aunque la petición no llegue a su página.
    for (const write of writes) response.cookies.set(write.name, write.value, write.options);
    response.headers.set("Cache-Control", NO_STORE);
    return response;
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
  response.headers.set("Cache-Control", NO_STORE);
  return response;
}

export const config = {
  // Todo menos los archivos estáticos. Es amplio a propósito: una acción de servidor es
  // una petición a la ruta de su página, y fuera de este alcance no pasaría por aquí.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)"],
};
