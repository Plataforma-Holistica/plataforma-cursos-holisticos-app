import type { Metadata } from "next";

import { requireSession } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages } from "@/messages";
import { accountProfile, accountSessions, sessionEmail } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";

import { SuspendedScreen, UnavailableScreen } from "../_lib/states";

import { sessionRows } from "./rows";
import { AccountScreen } from "./screen";

// PA-25 · Cuenta (`/cuenta`). Pide sesión y cuenta completa. Lo que pinta de la persona se
// lee con las claims con que la guarda la dejó pasar: su nombre, como ella misma, y sus
// sesiones abiertas, que la base solo entrega de quien actúa.

export const metadata: Metadata = { title: messages.account.manage.pageTitle };

export default async function AccountPage() {
  const session = await requireSession(ROUTES.account);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  const profile = await accountProfile(session.claims);
  if (profile.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  const sessions = await accountSessions(session.claims);
  if (sessions.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  const email = await sessionEmail(await cookieReader());
  return <AccountScreen name={profile.name ?? ""} email={email} sessions={sessionRows(sessions.sessions)} />;
}
