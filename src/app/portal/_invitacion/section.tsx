import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { longDate } from "@/app/_lib/dates";
import { LegalBody } from "@/app/_lib/legal-body";
import { messages, t } from "@/messages";
import type { VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { legalBlocks } from "@/services/legal/blocks";
import { teacherTexts, type TeacherText } from "@/services/teachers/teachers";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { InvitationForm } from "./screen";

// PA-40 · Aceptar la invitación (`/portal/invitacion`; T-401, FL-30). La sirve el comodín después de la guarda,
// que ya dijo si esta persona tiene una invitación y si su resguardo vale. Nada en la dirección ni en el
// formulario dice de qué invitación se trata: la base la busca por el correo de la cuenta. Sin el resguardo del
// buzón no hay nada que leer: que recupere su contraseña en este navegador.

const text = messages.portal.invitation;

function TextBlock({ item }: { item: TeacherText }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-4">
      <LegalBody title={item.title} blocks={legalBlocks(item.body)} />
      <p className="text-small text-text-2">{t(text.version, { version: item.version, date: longDate(item.effectiveFrom) })}</p>
    </section>
  );
}

export async function InvitationSection({ proven, name, claims }: { proven: boolean; name: string | null; claims: VerifiedClaims }) {
  const main = "mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none";
  if (!proven) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={main}>
        <h1 className="text-h1">{text.proofTitle}</h1>
        <p className="text-text-2">{text.proofBody}</p>
        <p>
          <TextLink href={ROUTES.recover}>{text.proofAction}</TextLink>
        </p>
        <p>
          <TextLink href={ROUTES.home}>{messages.portal.nav.platform}</TextLink>
        </p>
      </main>
    );
  }

  const texts = await teacherTexts(claims);
  if (texts === null) return <UnavailableScreen retryHref={ROUTES.portalInvitation} withSession />;
  const { agreement, notice } = texts;
  if (agreement === null || notice === null) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={main}>
        <h1 className="text-h1">{name === null ? text.title : t(text.titleNamed, { name })}</h1>
        <InlineAlert tone="warning">{text.noTexts}</InlineAlert>
      </main>
    );
  }
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={main}>
      <h1 className="text-h1">{name === null ? text.title : t(text.titleNamed, { name })}</h1>
      <p className="text-body-l text-text-2">{t(text.intro)}</p>
      <TextBlock item={agreement} />
      <TextBlock item={notice} />
      <InvitationForm agreement={agreement.documentId} notice={notice.documentId} />
      <p>
        <TextLink href={ROUTES.home}>{messages.portal.nav.platform}</TextLink>
      </p>
    </main>
  );
}
