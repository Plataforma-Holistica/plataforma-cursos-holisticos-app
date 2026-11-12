"use client";

import { useActionState, useEffect, useRef } from "react";

import { plans as text } from "@/messages/es/plans";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { cx } from "@/ui/cx";
import { InlineAlert } from "@/ui/inline-alert";
import { TextLink } from "@/ui/text-link";

import { startCheckoutAction } from "./actions";
import { PlanIncludes } from "./includes";
import { ACCEPT_FIELD, AMOUNT_FIELD, DOCUMENT_FIELD, PLAN_FIELD, RETURN_FIELD, type PlansAnswer, type PlansProblem, type PlansState } from "./outcomes";
import { PAY_BLOCK_ID, type PlanCard, type PlanSummary, type PlansView } from "./view";

// PA-04 · los planes (`/planes`; RF-201, RF-202, FL-04; T-302). Dos planes sin elegir; elegir uno es un enlace, y entonces «Antes de
// pagar» dice el total, la periodicidad, el siguiente cobro y la casilla de ese plan. «Continuar al pago» manda el plan, el monto y el
// texto que se vieron; lo que sale bien lleva a la página de Stripe. Sin JavaScript funciona igual: es un formulario.

const IDLE: PlansState = { kind: "idle" };

const PROBLEMS: Record<PlansProblem, string> = { choose_plan: text.choosePlan, must_accept: text.mustAccept };
const ANSWERS: Record<PlansAnswer, string> = {
  changed: text.changed,
  in_progress: text.inProgress,
  has_access: text.hasAccess,
  unavailable: text.unavailable,
  email_unverified: text.emailUnverified,
  suspended: text.suspended,
  invalid: text.unavailable,
};

type Ready = Extract<PlansView, { kind: "ready" }>;

export function PlansScreen({ view }: { view: Ready }) {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex max-w-reading flex-col gap-3">
        <h1 className="text-display-l text-balance">{text.title}</h1>
        <PlanIncludes />
      </div>
      {view.canceled && <InlineAlert tone="neutral">{text.canceled}</InlineAlert>}
      <section aria-labelledby="planes-elige" className="flex flex-col gap-4">
        <h2 id="planes-elige" className="sr-only">
          {text.choose}
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {view.cards.map((card) => (
            <PlanOption key={card.plan} card={card} />
          ))}
        </ul>
      </section>
      <Who view={view} />
    </div>
  );
}

function PlanOption({ card }: { card: PlanCard }) {
  return (
    <li className={cx("flex flex-col gap-3 rounded-md border p-6", card.chosen ? "border-accent bg-surface-2" : "border-border bg-surface-1")}>
      <h3 className="text-h3">{card.name}</h3>
      <p className="text-h2">{card.price}</p>
      <p className="text-body-s text-text-2">{card.repeat}</p>
      {card.equivalent !== null && <p className="text-body-s text-text-2">{card.equivalent}</p>}
      <div className="mt-auto pt-2">
        {card.chosen ? (
          <p aria-current="true" className="font-semibold">
            {text.chosen}
          </p>
        ) : (
          <Button href={card.href} variant="secondary" size="md">
            {card.chooseLabel}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Con acceso: a donde iba (`volver`), o al inicio. */
function HasAccessLink({ returnTo }: { returnTo: string | null }) {
  return <TextLink href={returnTo ?? ROUTES.home}>{returnTo === null ? text.hasAccessLink : text.hasAccessContinue}</TextLink>;
}

function Who({ view }: { view: Ready }) {
  switch (view.who.kind) {
    case "has_access":
      return (
        <InlineAlert tone="success" action={<HasAccessLink returnTo={view.returnTo} />}>
          {text.hasAccess}
        </InlineAlert>
      );
    case "in_progress":
      return (
        <InlineAlert tone="neutral" action={view.who.href === null ? undefined : <TextLink href={view.who.href}>{text.inProgressLink}</TextLink>}>
          {text.inProgress}
        </InlineAlert>
      );
    case "visitor":
      // Sin plan elegido, quien ya tiene cuenta puede entrar desde aquí, y vuelve a los planes con su destino.
      return view.summary === null ? (
        <p>
          <TextLink href={view.who.signIn}>{text.haveAccount}</TextLink>
        </p>
      ) : (
        <Summary summary={view.summary}>
          <div className="flex flex-wrap gap-3">
            <Button href={view.who.signUp}>{text.signUpFirst}</Button>
            <Button href={view.who.signIn} variant="secondary">
              {text.haveAccount}
            </Button>
          </div>
        </Summary>
      );
    case "pay":
      return view.summary === null ? null : <PayForm view={view} summary={view.summary} />;
  }
}

function Summary({ summary, children }: { summary: PlanSummary; children: React.ReactNode }) {
  return (
    <section id={PAY_BLOCK_ID} aria-labelledby="planes-antes" className="flex max-w-reading flex-col gap-5">
      <h2 id="planes-antes" className="text-h2">
        {text.beforePaying}
      </h2>
      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
          <dt className="text-text-2 sm:w-40">{text.todayYouPay}</dt>
          <dd className="font-semibold">{summary.price}</dd>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
          <dt className="text-text-2 sm:w-40">{text.repeats}</dt>
          <dd>{summary.repeats}</dd>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
          <dt className="text-text-2 sm:w-40">{text.nextCharge}</dt>
          <dd>{summary.nextCharge}</dd>
        </div>
      </dl>
      {summary.draft && <p className="text-body-s text-text-2">{text.draftNotice}</p>}
      {children}
      <p className="text-body-s text-text-2">{text.providerNote}</p>
    </section>
  );
}

function PayForm({ view, summary }: { view: Ready; summary: PlanSummary }) {
  const [state, action, pending] = useActionState(startCheckoutAction, IDLE, `${view.self}#${PAY_BLOCK_ID}`);
  const answer = useRef<HTMLDivElement>(null);
  const answered = !pending && state.kind !== "idle" ? state : null;

  // La respuesta toma el foco, también la segunda vez que dice lo mismo (`attempt`).
  useEffect(() => {
    if (answered !== null) answer.current?.focus();
  }, [answered]);

  return (
    <Summary summary={summary}>
      {answered !== null && (
        <div ref={answer} tabIndex={-1} className="outline-none">
          <InlineAlert
            tone={answered.kind === "problem" ? "warning" : answered.answer === "has_access" ? "success" : answered.answer === "unavailable" || answered.answer === "invalid" ? "danger" : "warning"}
            action={answered.kind === "answer" && answered.answer === "has_access" ? <HasAccessLink returnTo={view.returnTo} /> : undefined}
          >
            {answered.kind === "problem" ? PROBLEMS[answered.problem] : ANSWERS[answered.answer]}
          </InlineAlert>
        </div>
      )}
      <form action={action} noValidate className="flex flex-col gap-5">
        <input type="hidden" name={PLAN_FIELD} value={summary.plan} />
        <input type="hidden" name={AMOUNT_FIELD} value={String(summary.amount)} />
        <input type="hidden" name={DOCUMENT_FIELD} value={summary.document} />
        {view.returnTo !== null && <input type="hidden" name={RETURN_FIELD} value={view.returnTo} />}
        <ConsentCheckbox
          name={ACCEPT_FIELD}
          invalid={answered?.kind === "problem" && answered.problem === "must_accept"}
          label={
            <>
              {summary.consent}{" "}
              <TextLink href={summary.consentHref} external>
                {text.consentText}
              </TextLink>
            </>
          }
        />
        {summary.refund !== null && (
          <p className="text-body-s">
            {summary.refund}{" "}
            {summary.refundHref !== null && (
              <TextLink href={summary.refundHref} external>
                {text.refundLink}
              </TextLink>
            )}
          </p>
        )}
        <div>
          <Button type="submit" loading={pending} loadingLabel={text.continuing}>
            {text.continue}
          </Button>
        </div>
      </form>
    </Summary>
  );
}
