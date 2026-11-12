import type { Metadata } from "next";

import { StudentNav } from "@/app/_catalog/nav";
import { studentNavFor } from "@/app/_catalog/nav-facts";
import { requireSession } from "@/app/_lib/guard";
import { messages } from "@/messages";
import { accountProfile, accountSecondFactor, accountSessions } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";

import { SuspendedScreen, UnavailableScreen } from "../_lib/states";

import { sessionRows } from "./rows";
import { AccountScreen } from "./screen";

// PA-25 · Cuenta (`/cuenta`). Pide sesión y cuenta completa. Lo que pinta de la persona se
// lee con las claims con que la guarda la dejó pasar: su nombre, como ella misma, y sus
// sesiones abiertas, que la base solo entrega de quien actúa. Y si la cuenta tiene segundo
// factor, porque entonces su contraseña no se cambia desde aquí. Lleva la barra del alumno (T-616: sin ella,
// había que bajar hasta abajo para volver).

export const metadata: Metadata = { title: messages.account.manage.pageTitle };

export default async function AccountPage() {
  const session = await requireSession(ROUTES.account);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  const profile = await accountProfile(session.claims);
  if (profile.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  const sessions = await accountSessions(session.claims);
  if (sessions.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  const factor = await accountSecondFactor(session.claims);
  if (factor.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  // Al final, ya leído todo lo demás: una cuenta a medias no se pinta, y no se lee de más.
  const nav = await studentNavFor(session.claims);
  return (
    <>
      <StudentNav current={ROUTES.account} {...nav} />
      <AccountScreen name={profile.name ?? ""} email={nav.email} sessions={sessionRows(sessions.sessions)} secondFactor={factor.verified} />
    </>
  );
}
