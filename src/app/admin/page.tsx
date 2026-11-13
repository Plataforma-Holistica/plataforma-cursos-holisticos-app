import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireAdmin } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { sessionEmail } from "@/services/account/account";
import { billingQueueCount } from "@/services/billing/billing";
import { opensPortal } from "@/services/account/nav-access";
import { ROUTES } from "@/services/account/navigation";
import { CAPABILITIES } from "@/services/account/team";
import { teacherStanding } from "@/services/teachers/teachers";
import { FlowerState } from "@/ui/flower-state";
import { StatTile } from "@/ui/stat-tile";
import { TextLink } from "@/ui/text-link";

import { AdminFrame } from "./_lib/frame";
import { AdminMain } from "./_lib/shell";
import { ForbiddenScreen } from "./_lib/states";

// PA-60 · Inicio de administración (`/admin`), en su versión mínima: el menú lateral (T-614,
// parte 6), el saludo, con qué capacidades entró y las tarjetas que ya existen (llegan con cada
// tarea; decisión de Sergio del 2026-11-05). La primera es la de los avisos de cobro sin procesar
// (T-303), solo para finanzas, con cuántos fallaron. Existe para que quien es del equipo tenga a dónde
// llegar después de dar su código.
//
// Quién es del equipo lo dice la base, por la guarda: una capacidad, su factor atado y una
// sesión que dio ese código hace poco. A quien no lo es se le contesta lo mismo que en una
// ruta que no existe, y por eso esta página no exporta `metadata`: su título no debe poder
// asomarse en esa respuesta.

const text = messages.account;

export default async function AdminHomePage() {
  const step = await requireAdmin(ROUTES.admin);
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.admin} withSession />;
  // Esta pantalla no pide ninguna capacidad, así que la guarda no contesta esto. Si un día
  // pide una, a quien no la tenga se le dice cuál (PA-88).
  if (step.kind === "forbidden") return <ForbiddenScreen capability={step.capability} />;

  const reader = await cookieReader();
  const email = await sessionEmail(reader);
  // Una comodidad, como los demás enlaces: quién acepta lo decide la guarda de esa pantalla.
  const teacher = await teacherStanding(reader);
  const invited = teacher.kind === "teacher" && (teacher.standing.state === "invited" || teacher.standing.state === "invited_unproven");
  // La misma lectura dice si también es maestro, para «Mi portal» del menú: sin leer otra vez.
  const portal = teacher.kind === "teacher" && opensPortal(teacher.standing.state);
  // En el orden de siempre, y solo las que el catálogo sabe nombrar.
  const capabilities = CAPABILITIES.filter((capability) => step.capabilities.includes(capability));
  const billing = await billingQueueCount(step.claims, step.capabilities);
  const pendingWork = billing.kind === "count" && billing.count > 0;

  return (
    <AdminFrame path={ROUTES.admin} capabilities={capabilities} portal={portal}>
      <AdminMain title={text.admin.title} lead={email !== null ? <p>{t(text.home.signedInAs, { email })}</p> : undefined}>
        {/* Lo que espera, por área (T-616, solicitud 6): cada tarjeta bajo el nombre de su capacidad, en la misma
            rejilla que las cifras de un periodo. Las tarjetas llegan con cada tarea; hoy solo hay la de finanzas. */}
        {billing.kind === "none" ? (
          // Sin ninguna tarjeta que le toque: el vacío, con la semilla.
          <FlowerState title={text.admin.noPending} className="surface-raised" />
        ) : (
          <section aria-labelledby="inicio-pendientes" className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 id="inicio-pendientes" className="text-h3">
                {text.admin.pendingTitle}
              </h2>
              {billing.kind !== "unavailable" && !pendingWork && <p className="text-text-2">{text.admin.noPending}</p>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex flex-col gap-2">
                <p className="eyebrow text-accent-muted">{text.admin.capabilities.finance}</p>
                <StatTile
                  label={text.admin.billingCard}
                  value={billing.kind === "count" ? String(billing.count) : null}
                  context={billing.kind === "unavailable" ? text.admin.billingCardUnavailable : undefined}
                  {...(pendingWork ? { tone: "attention" as const } : {})}
                />
                <p className="text-body-s">
                  <TextLink href={ROUTES.billingEvents}>{text.admin.billingCardLink}</TextLink>
                </p>
              </div>
            </div>
          </section>
        )}
        <section className="flex flex-col gap-3">
          <h2 className="text-h3">{text.admin.capabilitiesTitle}</h2>
          <ul className="flex flex-wrap gap-2">
            {capabilities.map((capability) => (
              <li key={capability} className="rounded-md bg-surface-2 px-3 py-1 text-body-s text-text">
                {text.admin.capabilities[capability]}
              </li>
            ))}
          </ul>
        </section>
        {invited && (
          <p>
            <TextLink href={ROUTES.portalInvitation}>{t(text.admin.teacherInvitation)}</TextLink>
          </p>
        )}
      </AdminMain>
    </AdminFrame>
  );
}
