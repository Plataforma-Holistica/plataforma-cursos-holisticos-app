import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { longDate } from "@/app/_lib/dates";
import { LegalBody } from "@/app/_lib/legal-body";
import { portal } from "@/messages/es/portal";
import { plural, t } from "@/messages/format";
import type { VerifiedClaims } from "@/services/account/account";
import { portalAnnexPath, ROUTES } from "@/services/account/navigation";
import { acceptedAnnexes, annexText } from "@/services/drafts/editor";
import { legalBlocks } from "@/services/legal/texts";
import { BackLink } from "@/ui/back-link";
import { FlowerState } from "@/ui/flower-state";
import { TextLink } from "@/ui/text-link";

import { PortalFrame } from "../_lib/frame";
import { PortalMain } from "../_lib/shell";

// PA-50, lo mínimo (`/portal/cuenta`; T-405): «Lo que aceptaste», cada anexo de licencia con su curso, su versión, su fecha y el enlace al texto. La contraseña, el segundo factor y
// las sesiones ya están en `/cuenta`, la cuenta de toda persona (decisión mía sin confirmar). Lo sirve el comodín del portal, después de la guarda; el maestro suspendido también lo ve.
//
// El texto de una versión (`/portal/anexo/<id>`) se abre aquí y no en `/legal`: el anexo no es un texto público. Solo la vigente, o una que ese maestro aceptó.

const text = portal.account;

export async function AccountSection({ claims, readOnly }: { claims: VerifiedClaims; readOnly: boolean }) {
  const read = await acceptedAnnexes(claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.portalAccount} withSession />;

  return (
    <PortalFrame current={ROUTES.portalAccount} readOnly={readOnly}>
      <PortalMain
        title={text.title}
        section
        measure="reading"
        lead={
          <>
            <p>{text.intro}</p>
            <p className="text-body-s">
              <TextLink href={ROUTES.account}>{text.accountLink}</TextLink>
            </p>
          </>
        }
      >
        <section aria-labelledby="aceptado-titulo" className="flex flex-col gap-4">
          <h2 id="aceptado-titulo" className="text-h3">
            {text.acceptedTitle}
          </h2>
          {read.value.length === 0 ? (
            <FlowerState title={text.empty} className="surface-raised" />
          ) : (
            <ul className="surface-raised divide-y divide-border">
              {read.value.map((each) => (
                <li key={`${each.courseId}:${each.submissionNo}`} className="flex flex-col gap-1 p-4 sm:px-5">
                  <p className="font-semibold break-words">{each.courseTitle}</p>
                  <p className="text-body-s text-text-2">
                    {t(plural(each.termYears, text.line), { version: each.annex.version, date: longDate(each.acceptedAt), years: each.termYears })}
                  </p>
                  <p className="text-body-s break-words text-text-2">{each.statement}</p>
                  <p className="text-body-s">
                    <TextLink href={portalAnnexPath(each.annex.id) ?? ROUTES.portalAccount}>
                      <span aria-hidden="true">{text.read}</span>
                      <span className="sr-only">{t(text.readNamed, { title: each.courseTitle, version: each.annex.version })}</span>
                    </TextLink>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PortalMain>
    </PortalFrame>
  );
}

export async function AnnexSection({ claims, document, readOnly }: { claims: VerifiedClaims; document: string; readOnly: boolean }) {
  const path = portalAnnexPath(document);
  if (path === null) notFound();
  const read = await annexText(claims, document);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={path} withSession />;
  if (read.value === null) notFound();

  return (
    <PortalFrame current={ROUTES.portalAccount} readOnly={readOnly}>
      <PortalMain
        title={read.value.title}
        above={<BackLink href={ROUTES.portalAccount}>{text.back}</BackLink>}
        measure="reading"
        lead={
          <>
            <p className="text-body-s">{t(text.annexMeta, { version: read.value.version, date: longDate(read.value.effectiveFrom) })}</p>
            {read.value.version === 0 && <p className="text-body-s">{portal.submit.draftAnnex}</p>}
          </>
        }
      >
        <div className="surface-raised p-4 sm:p-5">
          <LegalBody title={read.value.title} blocks={legalBlocks(read.value.body)} />
        </div>
      </PortalMain>
    </PortalFrame>
  );
}
