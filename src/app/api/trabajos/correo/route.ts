import { mailCopy } from "@/app/_lib/mail-copy";
import { bearerToken } from "@/app/_lib/request-context";
import { mailSweepAllowed, sweepMail } from "@/services/mail/mail";

// El barrido de la salida de correo (T-604): el respaldo de lo que no salió detrás de una respuesta. Es la excepción a «las rutas solo atienden lecturas», porque Vercel Cron solo sabe pedir un GET, con
// `CRON_SECRET` en la cabecera. Sin esa llave contesta lo mismo que una ruta que no existe. No recibe nada: solo manda lo que la base dice que toca.

export async function GET(): Promise<Response> {
  if (!mailSweepAllowed(await bearerToken())) return new Response(null, { status: 404 });
  return new Response(null, { status: (await sweepMail(mailCopy)) ? 204 : 503, headers: { "cache-control": "no-store" } });
}
