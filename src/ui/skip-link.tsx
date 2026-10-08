import { ui } from "@/messages/es/ui";

// «Saltar al contenido» (diseño, sección 5.2): para que quien usa teclado no recorra el
// menú en cada pantalla. Es el primer elemento enfocable de toda pantalla, e invisible
// hasta que recibe el foco.

/** El `id` del contenido principal. Cada pantalla lo pone en su `<main>`, con `tabIndex={-1}`. */
export const MAIN_CONTENT_ID = "contenido";

export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-4 focus-visible:left-4 focus-visible:z-(--z-skip) focus-visible:rounded-md focus-visible:bg-text focus-visible:px-4 focus-visible:py-3 focus-visible:font-semibold focus-visible:text-bg"
    >
      {ui.skipLink}
    </a>
  );
}
