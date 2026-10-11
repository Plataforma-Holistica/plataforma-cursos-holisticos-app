import "server-only";

// La sesión de una petición, para quien tiene la petición en la mano: el paso previo
// (`src/proxy.ts`) y, cuando existan las pantallas, `src/app/_lib/request-context.ts`.
//
// Es un pasamanos a propósito. Ni el paso previo ni una pantalla importan un adaptador
// (TRD §4.2), y de aquí no cuelga la base: quien renueva la sesión antes de cada petición
// no debe poder abrir una transacción. Una prueba de arquitectura lo exige.
//
// Leer o renovar la sesión no es autorizar: eso lo hace la guarda de sesión, en cada
// acción y en cada página con sesión (TRD §9.2).

export { readSession, refreshSession } from "@/adapters/supabase/auth";
export type { SessionRead, SessionRefresh } from "@/adapters/supabase/auth";
export type { CookieJar, CookieOptions, CookieReader } from "@/adapters/supabase/auth-cookies";
