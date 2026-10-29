import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { longDate } from "@/app/_lib/dates";
import { LegalBody } from "@/app/_lib/legal-body";
import { messages, t } from "@/messages";
import { currentLegalText, docTypeOfSlug, legalBlocks } from "@/services/legal/texts";
import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// PA-07 · Páginas legales (`/legal/[documento]`), en su versión mínima: el texto vigente,
// con su versión y su fecha. Existe ya porque el registro y la pantalla de consentimientos
// enlazan a los textos, y aceptar lo que no se puede leer no vale. La navegación entre
// textos, el índice y la hoja de impresión llegan con las páginas públicas (T-606).
//
// El cuerpo se pinta como texto, bloque por bloque: nunca como HTML.

const text = messages.account.legal;

interface Props {
  params: Promise<{ documento: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * La versión que anuncia el formulario desde el que se llega (`?v=3`), o nada. No elige qué
 * versión se pinta, que es siempre la vigente: le dice al servicio que no se conforme con
 * una más vieja que recuerde, para que nadie lea una versión y acepte otra.
 */
function announcedVersion(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return undefined;
  return Number(value);
}

// Una sola lectura por petición: el título de la pestaña y la página piden lo mismo.
const load = cache(async (slug: string, version: number | undefined) => {
  const docType = docTypeOfSlug(slug);
  if (docType === null) return { kind: "not_found" } as const;
  // La página no se arma al compilar: el servicio decide cuánto recuerda lo leído.
  await connection();
  return currentLegalText(docType, version);
});

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const read = await load((await params).documento, announcedVersion((await searchParams).v));
  return read.kind === "found" ? { title: read.text.title } : {};
}

export default async function LegalPage({ params, searchParams }: Props) {
  const slug = (await params).documento;
  const read = await load(slug, announcedVersion((await searchParams).v));
  if (read.kind === "not_found") notFound();
  // No se supo: no es lo mismo que un texto que no existe. El servicio ya lo reportó.
  const self = `/legal/${slug}`;
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={self} withSession={false} />;

  const found = read.text;
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-6 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{found.title}</h1>
        <p className="text-body-s text-text-2">
          {t(text.details, { version: found.version, date: longDate(found.effectiveFrom) })}
        </p>
      </div>
      {found.version === 0 && <InlineAlert tone="warning">{text.draft}</InlineAlert>}
      <LegalBody title={found.title} blocks={legalBlocks(found.body)} />
    </main>
  );
}
