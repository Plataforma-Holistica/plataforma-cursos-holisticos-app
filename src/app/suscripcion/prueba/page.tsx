import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { confirmingHref } from "@/app/planes/outcomes";
import { requireSession } from "@/app/_lib/guard";
import { plans as text } from "@/messages/es/plans";
import { ROUTES } from "@/services/account/navigation";
import { checkoutTestMode } from "@/services/billing/checkout-service";
import { Button } from "@/ui/button";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// La página de pago de prueba (`/suscripcion/prueba?sesion=cs_test_local…`; T-302), solo con el pago de prueba de local, que `env.ts`
// no admite fuera de local. Hace de la página de Stripe para el extremo a extremo: «Pagar» lleva
// a PA-32 como si Stripe hubiera cobrado, y «Cancelar» a PA-04 como su `cancel_url`. No cobra ni anota nada. Sin el pago de prueba,
// contesta lo mismo que una ruta que no existe.

export const metadata: Metadata = { title: text.testTitle };

const LOCAL_SESSION = /^cs_test_local[0-9a-f]{1,64}$/;

type Search = Record<string, string | string[] | undefined>;

export default async function TestPaymentPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (!checkoutTestMode()) notFound();
  const asked = (await searchParams).sesion;
  const session = typeof asked === "string" && LOCAL_SESSION.test(asked) ? asked : null;
  const guard = await requireSession(session === null ? ROUTES.checkoutTest : `${ROUTES.checkoutTest}?sesion=${session}`);
  if (guard.kind === "suspended") return <SuspendedScreen withSession />;
  if (guard.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.plans} withSession />;
  if (session === null) notFound();

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-6 px-4 pt-10 pb-16 outline-none sm:px-8">
      <h1 className="text-h1">{text.testTitle}</h1>
      <p className="text-body-l text-text-2">{text.testBody}</p>
      <div className="flex flex-wrap gap-3">
        <Button href={confirmingHref(session)}>{text.testPay}</Button>
        <Button href={`${ROUTES.plans}?cancelado=1`} variant="secondary">
          {text.testCancel}
        </Button>
      </div>
    </main>
  );
}
