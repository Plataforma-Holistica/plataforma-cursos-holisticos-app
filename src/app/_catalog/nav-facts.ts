import "server-only";

import { cookieReader } from "@/app/_lib/request-context";
import { sessionEmail, type VerifiedClaims } from "@/services/account/account";
import { navAccess, type NavAccess } from "@/services/account/nav";

// Lo que pide la barra del alumno (T-616, solicitud 2): los accesos por rol y el correo con que se entró. Lo
// pide cada pantalla después de su guarda, con sus claims, a la par de lo suyo.

export interface StudentNavFacts {
  access: NavAccess;
  email: string | null;
}

export async function studentNavFor(claims: VerifiedClaims): Promise<StudentNavFacts> {
  const [access, email] = await Promise.all([navAccess(claims), sessionEmail(await cookieReader())]);
  return { access, email };
}
