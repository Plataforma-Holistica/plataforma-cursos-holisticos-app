import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { StudentNav } from "@/app/_catalog/nav";
import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { confirmingHref } from "@/app/planes/outcomes";
import { requireSession } from "@/app/_lib/guard";
import { plans as text } from "@/messages/es/plans";
import { resolveDestination, ROUTES } from "@/services/account/navigation";
import { checkoutProgress, SESSION_ID } from "@/services/billing/checkout-service";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

import { ConfirmingPoller } from "./poller";

// PA-32 · «Estamos confirmando tu pago» (`/suscripcion/confirmando?sesion=cs_…`; RF-202, FL-04; T-302). A donde vuelve Stripe después
// de cobrar. Pide sesión, y solo muestra la sesión de pago de quien mira: la de otra persona, o una sin forma, da lo mismo que una que no
// existe. La primera vez le pregunta a Stripe por la sesión y anota su suscripción; después solo a la base. **Nunca da acceso:** el
// acceso llega con el aviso de Stripe, y esta pantalla solo dice si ya llegó. Si Stripe dice que la sesión sigue abierta, no se pagó (se
// llegó aquí a mano o con el historial): se dice, y no se espera un aviso que no va a llegar.

export const metadata: Metadata = { title: text.confirmingTitle };

type Search = Record<string, string | string[] | undefined>;

export default async function ConfirmingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const asked = (await searchParams).sesion;
  const session = typeof asked === "string" && SESSION_ID.test(asked) ? asked : null;
  const self = session === null ? ROUTES.checkoutConfirming : confirmingHref(session);
  const guard = await requireSession(self);
  if (guard.kind === "suspended") return <SuspendedScreen withSession />;
  if (guard.kind === "unavailable") return <UnavailableScreen retryHref={self} withSession />;
  if (session === null) notFound();

  const progress = await checkoutProgress(guard.claims, session);
  if (progress.kind === "not_found") notFound();

  return (
    <>
      <StudentNav />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-6 px-4 pt-10 pb-24 outline-none sm:px-8 sm:pb-16">
        {/* Una sola región de estado para todas las respuestas: al pasar de la espera a «Listo», el lector de pantalla lo anuncia. */}
        <div role="status" className="flex flex-col gap-6">
          {progress.kind === "waiting" && <ConfirmingPoller self={self} />}
          {progress.kind === "live" && (
            <>
              <h1 className="text-h1">{text.readyTitle}</h1>
              <div>
                <Button href={resolveDestination(progress.returnTo)}>{text.readyContinue}</Button>
              </div>
            </>
          )}
          {(progress.kind === "expired" || progress.kind === "not_paid") && (
            <>
              <h1 className="text-h1">{progress.kind === "expired" ? text.expiredTitle : text.notPaidTitle}</h1>
              <p className="text-body-l text-text-2">{progress.kind === "expired" ? text.expiredBody : text.notPaidBody}</p>
              <div>
                <Button href={ROUTES.plans}>{text.backToPlans}</Button>
              </div>
            </>
          )}
          {progress.kind === "unavailable" && (
            <>
              <h1 className="text-h1">{text.confirmingTitle}</h1>
              <InlineAlert tone="warning">{text.progressUnavailable}</InlineAlert>
              <div>
                <Button href={self} variant="secondary" size="md">
                  {text.refresh}
                </Button>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
