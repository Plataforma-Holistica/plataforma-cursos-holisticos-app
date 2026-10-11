import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { longDate } from "@/app/_lib/dates";
import { messages, t } from "@/messages";
import { currentLegalText, docTypeOfSlug, legalBlocks, type LegalBlock } from "@/services/legal/texts";
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
}

async function load(slug: string) {
  const docType = docTypeOfSlug(slug);
  if (docType === null) return { kind: "not_found" } as const;
  // Se lee de la base en cada petición: un texto recién publicado se ve de inmediato.
  await connection();
  return currentLegalText(docType);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const read = await load((await params).documento);
  return read.kind === "found" ? { title: read.text.title } : {};
}

const HEADINGS = { 1: "text-h2", 2: "text-h3", 3: "text-body-l font-semibold" } as const;

function Block({ block }: { block: LegalBlock }) {
  if (block.kind === "paragraph") return <p>{block.text}</p>;
  // El título de la página es el del texto: los del cuerpo empiezan un nivel abajo.
  if (block.level === 1) return <h2 className={HEADINGS[1]}>{block.text}</h2>;
  if (block.level === 2) return <h3 className={HEADINGS[2]}>{block.text}</h3>;
  return <h4 className={HEADINGS[3]}>{block.text}</h4>;
}

export default async function LegalPage({ params }: Props) {
  const slug = (await params).documento;
  const read = await load(slug);
  if (read.kind === "not_found") notFound();
  // No se supo: no es lo mismo que un texto que no existe. El servicio ya lo reportó.
  const self = `/legal/${slug}`;
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={self} withSession={false} />;

  const found = read.text;
  // Si el cuerpo abre repitiendo su título, ese título ya es el de la página.
  const blocks = legalBlocks(found.body).filter(
    (block, index) => !(index === 0 && block.kind === "heading" && block.level === 1 && block.text === found.title),
  );
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-reading flex-col gap-6 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{found.title}</h1>
        <p className="text-body-s text-text-2">
          {t(text.details, { version: found.version, date: longDate(found.effectiveFrom) })}
        </p>
      </div>
      {found.version === 0 && <InlineAlert tone="warning">{text.draft}</InlineAlert>}
      <div className="flex flex-col gap-4 text-body-l text-text">
        {blocks.map((block, index) => (
          // Los bloques de un texto no cambian de orden: su posición los identifica.
          <Block key={`${index}-${block.kind}`} block={block} />
        ))}
      </div>
    </main>
  );
}
