import type { Metadata } from "next";

import { longDate } from "@/app/_lib/dates";
import { requireIncompleteSession } from "@/app/_lib/guard";
import { messages } from "@/messages";
import { accountFormFacts } from "@/services/account/account";
import { RETURN_PARAM, ROUTES } from "@/services/account/navigation";
import { slugOfDocType } from "@/services/legal/texts";

import { NoCurrentTextScreen, SuspendedScreen, UnavailableScreen } from "../_lib/states";

import { consentsView } from "./outcomes";
import { ConsentsScreen } from "./screen";

// PA-15 · Consentimientos actualizados (`/consentimientos`). La guarda de sesión manda aquí
// a toda cuenta a la que le falte nombre, edad declarada o un texto vigente, antes que a
// cualquier otra pantalla con sesión. Pide sesión, pero no cuenta completa: aquí se completa.

export const metadata: Metadata = { title: messages.account.consents.pageTitle };

type Params = Record<string, string | string[] | undefined>;

export default async function ConsentsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = (await searchParams)[RETURN_PARAM];
  const returnTo = typeof raw === "string" ? raw : "";

  const session = await requireIncompleteSession(returnTo);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.consents} withSession />;

  const facts = await accountFormFacts();
  if (facts.kind === "no_current_text") return <NoCurrentTextScreen withSession />;
  if (facts.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.consents} withSession />;

  const view = consentsView(session.pending, facts, { slugOf: slugOfDocType, formatDate: longDate });
  return <ConsentsScreen view={view} returnTo={returnTo} />;
}
