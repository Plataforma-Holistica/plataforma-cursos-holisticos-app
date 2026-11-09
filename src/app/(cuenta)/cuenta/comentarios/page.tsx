import type { Metadata } from "next";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { commentCursor } from "@/app/_comments/view";
import { requireSession } from "@/app/_lib/guard";
import { comments as text } from "@/messages/es/comments";
import { ROUTES } from "@/services/account/navigation";
import { myComments } from "@/services/comments/comments";

import { myCommentsAction } from "./actions";
import { mineHref } from "./outcomes";
import { MyCommentsScreen } from "./screen";

// PA-24 · «Mis comentarios» (`/cuenta/comentarios`; T-501; decisiones de Sergio del 2026-11-08). Pide sesión y cuenta completa:
// una suspendida ve PA-35. Lee lo propio con las claims con que la guarda la dejó pasar, sin la regla de acceso: es para borrar
// lo suyo también sin acceso a la lección. La página va en la dirección (`?desde=`), sin acumularse.

export const metadata: Metadata = { title: text.mine.pageTitle };

type Search = Record<string, string | string[] | undefined>;

export default async function MyCommentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireSession(ROUTES.myComments);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.myComments} withSession />;

  const from = (await searchParams).desde;
  const cursor = commentCursor(typeof from === "string" ? from : null);
  const page = await myComments(session.claims, typeof from === "string" ? from : null);
  if (page.kind === "unavailable") return <UnavailableScreen retryHref={mineHref(cursor)} withSession />;
  return <MyCommentsScreen items={page.items} next={page.next} cursor={cursor} action={myCommentsAction} />;
}
