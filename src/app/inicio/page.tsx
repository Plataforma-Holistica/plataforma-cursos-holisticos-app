import type { Metadata } from "next";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { signOutAction } from "@/app/(cuenta)/_lib/session-actions";
import { requireSession } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { sessionEmail } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

// El inicio de quien entró, provisional: el del alumno (PA-20) llega con el catálogo
// (T-210). Existe para que haya a dónde llegar después de entrar, y dónde salir. Mientras
// no haya menú de la cuenta, de aquí sale también el enlace a PA-25.
//
// Dice con qué correo se entró. No es un adorno: es lo que le avisa a alguien que completó
// una cuenta desde un enlace que le mandó otra persona, y cuyo buzón no controla.

const text = messages.account;

export const metadata: Metadata = { title: text.home.pageTitle };

export default async function HomePage() {
  const session = await requireSession(ROUTES.home);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.home} withSession />;

  const email = await sessionEmail(await cookieReader());

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.home.title}</h1>
      <div className="flex flex-col gap-2 text-text-2">
        {email !== null && <p>{t(text.home.signedInAs, { email })}</p>}
        <p>{text.home.status}</p>
      </div>
      <p>
        <TextLink href={ROUTES.account}>{text.home.account}</TextLink>
      </p>
      <form action={signOutAction}>
        <Button type="submit" variant="secondary">
          {text.common.signOut}
        </Button>
      </form>
    </main>
  );
}
