import type { Metadata } from "next";

import { requireSession } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages } from "@/messages";
import { accountProfile, sessionEmail } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";

import { SuspendedScreen, UnavailableScreen } from "../_lib/states";

import { AccountScreen } from "./screen";

// PA-25 · Cuenta (`/cuenta`). Pide sesión y cuenta completa. Lo que pinta de la persona se
// lee como ella misma, con las claims con que la guarda la dejó pasar.

export const metadata: Metadata = { title: messages.account.manage.pageTitle };

export default async function AccountPage() {
  const session = await requireSession(ROUTES.account);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  const profile = await accountProfile(session.claims);
  if (profile.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.account} withSession />;

  const email = await sessionEmail(await cookieReader());
  return <AccountScreen name={profile.name ?? ""} email={email} />;
}
