import { longDate } from "@/app/_lib/dates";
import { lesson as text } from "@/messages/es/lesson";
import { t } from "@/messages/format";
import type { MediaGrant } from "@/services/media/media";

// Lo que dice PA-33: por qué una cuenta no tiene acceso. Lo comparten el lugar del reproductor (T-203) y un recurso (T-404). Es puro.

type AccountRefusal = Extract<MediaGrant, { kind: "denied" }>["account"];

/** El motivo de PA-33, con la fecha ya en palabras, en la zona del producto. */
export type Denial = { reason: "never_subscribed" } | { reason: "expired" | "grace_ended" | "refunded"; date: string };

/**
 * El motivo de PA-33, o nulo si es una cuenta suspendida: viene en el tipo del rechazo, pero
 * es PA-35, y la regla nunca la contesta así (la suspensión va antes).
 */
export function denialOf(account: AccountRefusal): Denial | null {
  switch (account.reason) {
    case "never_subscribed":
      return { reason: "never_subscribed" };
    case "suspended":
      return null;
    default:
      return { reason: account.reason, date: longDate(account.endedAt.toISOString()) };
  }
}

/** La acción (T-302): quien tuvo acceso y lo perdió por el tiempo o el cobro vuelve a suscribirse; los demás ven los planes. */
export function paywallAction(denial: Denial): string {
  return denial.reason === "expired" || denial.reason === "grace_ended" ? text.denied.resubscribe : text.denied.seePlans;
}

/** El título y el texto. */
export function paywallCopy(denial: Denial): [string, string] {
  const copy = text.denied;
  if (denial.reason === "never_subscribed") return [copy.neverSubscribed, copy.neverSubscribedText];
  if (denial.reason === "refunded") return [copy.refunded, copy.refundedText];
  return [t(copy.ended, { date: denial.date }), denial.reason === "expired" ? copy.expiredText : copy.graceEndedText];
}
