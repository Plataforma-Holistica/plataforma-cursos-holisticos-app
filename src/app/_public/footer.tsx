import { landing } from "@/messages/es/landing";
import { ROUTES } from "@/services/account/navigation";
import { slugOfDocType } from "@/services/legal/slugs";
import { Disclaimer } from "@/ui/disclaimer";
import { TextLink } from "@/ui/text-link";
import { Wordmark } from "@/ui/wordmark";

// El pie del sitio público (`Footer`, diseño, sección 5; T-614, parte 2): los textos legales que ya
// tienen página, «Entrar» y el deslinde. Comunidad, Reembolsos, Ayuda y Para maestros entran cuando
// existan sus pantallas (T-606).

const text = landing.footer;

const LEGAL = [
  { docType: "terms", label: text.terms },
  { docType: "student_privacy_notice", label: text.privacy },
] as const;

export function PublicFooter() {
  return (
    <footer className="border-t border-border bg-surface-1">
      <div className="mx-auto flex max-w-page flex-col gap-6 px-4 py-10 sm:px-8">
        <Wordmark className="text-h3" />
        <nav aria-label={text.label}>
          <ul className="flex flex-wrap gap-x-6 gap-y-3 text-body-s">
            {LEGAL.map(({ docType, label }) => {
              const slug = slugOfDocType(docType);
              return slug === null ? null : (
                <li key={docType}>
                  <TextLink href={`/legal/${slug}`}>{label}</TextLink>
                </li>
              );
            })}
            <li>
              <TextLink href={ROUTES.signIn}>{landing.header.signIn}</TextLink>
            </li>
          </ul>
        </nav>
        <Disclaimer />
      </div>
    </footer>
  );
}
