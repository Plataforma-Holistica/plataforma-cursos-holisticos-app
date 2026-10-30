import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { longDate } from "@/app/_lib/dates";
import { LegalBody } from "@/app/_lib/legal-body";
import { messages, t } from "@/messages";
import type { VerifiedClaims } from "@/services/account/account";
import { RETURN_PARAM, ROUTES } from "@/services/account/navigation";
import { legalBlocks } from "@/services/legal/blocks";
import { teacherTexts } from "@/services/teachers/teachers";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

import { NoticeForm } from "./screen";

// El aviso de privacidad del maestro, vuelto a pedir (`/portal/aviso`; T-401). Lo sirve el comodín, solo a un
// maestro activo al que le falta: toda otra ruta del portal lo manda aquí, y sin aceptarlo la base no lo deja
// escribir (decisión de Sergio del 2026-10-30).

const text = messages.portal.notice;

export async function NoticeSection({
  claims,
  search,
}: {
  claims: VerifiedClaims;
  search: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const raw = search[RETURN_PARAM];
  const returnTo = typeof raw === "string" ? raw : "";
  const texts = await teacherTexts(claims);
  if (texts === null) return <UnavailableScreen retryHref={ROUTES.portalNotice} withSession />;
  const { notice } = texts;
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.title}</h1>
      {notice === null ? (
        <InlineAlert tone="warning">{text.noText}</InlineAlert>
      ) : (
        <>
          <p className="text-body-l text-text-2">{text.intro}</p>
          <section className="flex flex-col gap-2 rounded-md border border-border p-4">
            <LegalBody title={notice.title} blocks={legalBlocks(notice.body)} />
            <p className="text-small text-text-2">{t(text.version, { version: notice.version, date: longDate(notice.effectiveFrom) })}</p>
          </section>
          <NoticeForm notice={notice.documentId} returnTo={returnTo} />
        </>
      )}
    </main>
  );
}
