import { signOutAction } from "@/app/(cuenta)/_lib/session-actions";
import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireAdmin } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { sessionEmail } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { CAPABILITIES } from "@/services/account/team";
import { Button } from "@/ui/button";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { ForbiddenScreen } from "./_lib/states";

// PA-60 · Inicio de administración (`/admin`), en su versión mínima: ninguna de sus tareas
// existe todavía, así que no hay tarjetas ni menú. Existe para que quien es del equipo tenga
// a dónde llegar después de dar su código, y vea con qué capacidades entró.
//
// Quién es del equipo lo dice la base, por la guarda: una capacidad, su factor atado y una
// sesión que dio ese código hace poco. A quien no lo es se le contesta lo mismo que en una
// ruta que no existe, y por eso esta página no exporta `metadata`: su título no debe poder
// asomarse en esa respuesta.

const text = messages.account;

export default async function AdminHomePage() {
  const step = await requireAdmin(ROUTES.admin);
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.admin} withSession />;
  // Esta pantalla no pide ninguna capacidad, así que la guarda no contesta esto. Si un día
  // pide una, a quien no la tenga se le dice cuál (PA-88).
  if (step.kind === "forbidden") return <ForbiddenScreen capability={step.capability} />;

  const email = await sessionEmail(await cookieReader());
  // En el orden de siempre, y solo las que el catálogo sabe nombrar.
  const capabilities = CAPABILITIES.filter((capability) => step.capabilities.includes(capability));

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.admin.title}</h1>
      <div className="flex flex-col gap-2 text-text-2">
        {email !== null && <p>{t(text.home.signedInAs, { email })}</p>}
        <p>{text.admin.noPending}</p>
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-h3">{text.admin.capabilitiesTitle}</h2>
        <ul className="list-disc pl-6">
          {capabilities.map((capability) => (
            <li key={capability}>{text.admin.capabilities[capability]}</li>
          ))}
        </ul>
      </section>
      <p>
        <TextLink href={ROUTES.account}>{text.admin.account}</TextLink>
      </p>
      <form action={signOutAction}>
        <Button type="submit" variant="secondary">
          {text.common.signOut}
        </Button>
      </form>
    </main>
  );
}
