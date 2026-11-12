import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { StudentNav } from "@/app/_catalog/nav";
import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { publicViewer } from "@/app/_lib/guard";
import { PublicFooter } from "@/app/_public/footer";
import { PublicHeader } from "@/app/_public/header";
import { plans as text } from "@/messages/es/plans";
import { resolveDestination, signInPath, signUpPath } from "@/services/account/navigation";
import { planOffer, planStanding } from "@/services/billing/checkout-service";
import { slugOfDocType } from "@/services/legal/texts";
import { cx } from "@/ui/cx";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { closedPlansDetour, plansHref, readPlansQuery } from "./outcomes";
import { PlansScreen } from "./screen";
import { plansView, type PlansViewer } from "./view";

// PA-04 · los planes (`/planes`; RF-201, RF-202, FL-04; T-302). Pública, como la ficha de un curso: la guarda nunca redirige
// (`publicViewer`); la página solo manda a entrar al visitante que iba a otra pantalla cuando no se venden planes. Al visitante le
// ofrece crear su cuenta o entrar (con un plan elegido, volviendo aquí; sin él, directo a donde iba); al alumno, la casilla y «Continuar al
// pago»; a quien ya tiene acceso, que ya lo tiene (una PA-26 mínima, hasta T-304); con un pago en confirmación, que no vuelva a pagar.
// Si no se sabe quién mira (una cuenta a medias, suspendida o «no se supo»), va el formulario, y la acción decide con su guarda.
//
// La acción habla con Stripe, que puede tardar: la página le da 60 s.

export const maxDuration = 60;

export const metadata: Metadata = { title: text.pageTitle };

type Search = Record<string, string | string[] | undefined>;

/** Un destino que la lista admite, o nulo: `resolveDestination` da el inicio con lo que no vale, y eso no se pasea por la dirección. */
function returnOf(input: string): string | null {
  const resolved = resolveDestination(input);
  return resolved === input ? resolved : null;
}

function legalHref(doc: "recurring" | "refund", version: number | null): string | null {
  const slug = slugOfDocType(doc === "recurring" ? "recurring_charge_consent" : "refund_policy");
  if (slug === null) return null;
  return version === null ? `/legal/${slug}` : `/legal/${slug}?v=${version}`;
}

export default async function PlansPage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = readPlansQuery(await searchParams, returnOf);
  const [who, offer] = await Promise.all([publicViewer(), planOffer()]);
  // Una falla pasajera se queda aquí, con su «Reintentar».
  if (offer.kind === "unavailable") return <UnavailableScreen retryHref={plansHref(query.plan, query.returnTo)} withSession={who.kind === "student"} />;

  let viewer: PlansViewer;
  if (who.kind === "visitor") viewer = { kind: "visitor", signUp: signUpPath, signIn: signInPath };
  else if (who.kind === "student") {
    const standing = await planStanding(who.claims);
    viewer =
      standing.kind === "ready" && standing.access
        ? { kind: "has_access" }
        : standing.kind === "ready" && standing.blocking
          ? { kind: "in_progress", session: standing.open?.sessionId ?? null }
          : { kind: "pay" };
  } else viewer = { kind: "pay" };

  const view = plansView(offer.offer, query, viewer, legalHref);
  // Si no se venden planes, el visitante que iba a otra pantalla va a entrar con su destino: es lo que sirve a quien ya tiene cuenta.
  const detour = closedPlansDetour(who.kind, query.returnTo);
  if (view.kind === "not_for_sale" && detour !== null) redirect(signInPath(detour));
  return (
    <>
      {who.kind === "student" && <StudentNav />}
      {who.kind === "visitor" && <PublicHeader />}
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={cx("mx-auto flex max-w-page flex-col gap-10 px-4 pt-6 outline-none sm:px-8", who.kind === "student" ? "pb-24 sm:pb-16" : "pb-16")}>
        {view.kind === "not_for_sale" ? (
          <div className="flex max-w-reading flex-col gap-4">
            <h1 className="text-display-l">{text.title}</h1>
            <InlineAlert tone="neutral" action={who.kind === "visitor" ? <TextLink href={signInPath(plansHref(null, null))}>{text.haveAccount}</TextLink> : undefined}>
              {text.notForSale}
            </InlineAlert>
          </div>
        ) : (
          <PlansScreen view={view} />
        )}
      </main>
      {who.kind === "visitor" && <PublicFooter />}
    </>
  );
}
