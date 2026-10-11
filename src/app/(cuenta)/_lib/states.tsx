import { Ban, FileX, ServerCrash } from "lucide";

import { account } from "@/messages/es/account";
import { states } from "@/messages/es/states";
import { ROUTES } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { FullScreenState } from "@/ui/full-screen-state";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

import { signOutAction } from "./session-actions";

// Los estados que sustituyen a una pantalla de la cuenta. Los usan páginas del servidor y
// pantallas del navegador: por eso importan su bloque de textos y no el catálogo entero.

function CloseSession() {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="secondary">
        {account.common.closeSession}
      </Button>
    </form>
  );
}

/**
 * PA-35 · Cuenta suspendida. No dice el motivo. Con sesión lleva «Cerrar sesión»; quien
 * llega aquí al intentar entrar no tiene ninguna.
 *
 * Faltan dos cosas que el diseño pide: «Escribir al equipo», que no tiene a dónde llevar
 * hasta que exista la página de ayuda (PA-06), y la frase sobre la renovación cancelada,
 * que entra con la tarea que la cancele.
 */
export function SuspendedScreen({ withSession }: { withSession: boolean }) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      <FullScreenState
        icon={Ban}
        title={account.suspended.title}
        primaryAction={withSession ? <CloseSession /> : <Button href={ROUTES.landing}>{account.common.goHome}</Button>}
      >
        <p>{account.suspended.body}</p>
      </FullScreenState>
    </main>
  );
}

/**
 * No se supo (PA-18): la base no contestó lo que la pantalla necesita. Cuando lo que no se
 * supo es si la sesión vale, no es «sin sesión»: a nadie se le manda a entrar por una
 * falla nuestra. El servicio ya lo reportó; aquí solo se ofrece reintentar.
 */
export function UnavailableScreen({ retryHref, withSession }: { retryHref: string; withSession: boolean }) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      <FullScreenState
        icon={ServerCrash}
        title={states.error.title}
        primaryAction={<Button href={retryHref}>{states.error.retry}</Button>}
        secondaryActions={withSession ? <CloseSession /> : undefined}
      >
        <p>{states.error.body}</p>
      </FullScreenState>
    </main>
  );
}

/**
 * Falta el texto vigente de un documento obligatorio: no hay qué aceptar, y la cuenta no se
 * puede completar (diseño, PA-14 y PA-15). El enlace a ayuda llega con PA-06.
 */
export function NoCurrentTextScreen({ withSession }: { withSession: boolean }) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      <FullScreenState
        icon={FileX}
        title={account.consents.noCurrentTextTitle}
        primaryAction={withSession ? <CloseSession /> : <Button href={ROUTES.landing}>{account.common.goHome}</Button>}
      >
        <p>{account.consents.noCurrentText}</p>
      </FullScreenState>
    </main>
  );
}
