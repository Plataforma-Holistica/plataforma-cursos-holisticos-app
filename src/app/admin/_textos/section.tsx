import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { longDate } from "@/app/_lib/dates";
import { LegalBody } from "@/app/_lib/legal-body";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import type { VerifiedClaims } from "@/services/account/account";
import { legalVersionPath, ROUTES } from "@/services/account/navigation";
import { NOTICE_MAX_AGE_SECONDS, readNotice } from "@/services/account/notice";
import { legalBlocks, legalDocuments, legalVersion } from "@/services/legal/legal-admin";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { acceptedPublishedNotice, docName, legalView } from "./rows";
import { LegalScreen } from "./screen";

// PA-89 · Los textos legales (`/admin/textos-legales`) y el texto de una versión
// (`/admin/textos-legales/<identificador>`; RF-713, FL-57; T-110). No son páginas: las sirve el comodín de
// administración, que corre la guarda antes y solo llega aquí con alguien del equipo que tiene configuración
// (`src/app/admin/_lib/sections.tsx`).
//
// Se lee con las claims con que la guarda dejó pasar, y la base solo se lo contesta a quien pasa su puerta
// con configuración. Si entre la guarda y la lectura la sesión dejó de pasar, no se supo: «Reintentar» vuelve
// a correr la guarda, que decide.

const text = messages.admin.legal;

export async function LegalSection({ claims }: { claims: VerifiedClaims }) {
  const reader = await cookieReader();
  const read = await legalDocuments(claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.legalTexts} withSession />;
  // Publicar redirige aquí con su aviso, que no dice qué se publicó: se pinta solo si algo se publicó hace un momento.
  const done = readNotice(reader) === "legal_published" && acceptedPublishedNotice(read.documents, new Date().toISOString(), NOTICE_MAX_AGE_SECONDS);
  return <LegalScreen view={legalView(read.documents)} done={done} />;
}

export async function LegalVersionSection({ claims, id }: { claims: VerifiedClaims; id: string }) {
  const read = await legalVersion(claims, id);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={legalVersionPath(id)} withSession />;
  if (read.kind === "not_found") notFound();
  const version = read.text;
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-6 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{t(text.version.title, { name: docName(version.docType), version: version.version })}</h1>
        <p className="text-body-s text-text-2">
          {t(text.version.details, { date: longDate(version.effectiveFrom), published: longDate(version.publishedAt) })}
        </p>
        <p className="text-body-s text-text-2">{t(text.version.fingerprint, { sha: version.bodySha256 })}</p>
      </div>
      {version.version === 0 && <InlineAlert tone="warning">{text.version.draft}</InlineAlert>}
      <p className="text-h2">{version.title}</p>
      <LegalBody title={version.title} blocks={legalBlocks(version.body)} />
      <p className="text-body-s">
        <TextLink href={ROUTES.legalTexts}>{text.version.back}</TextLink>
      </p>
    </main>
  );
}
