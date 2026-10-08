import { SearchX } from "lucide";
import type { Metadata } from "next";

import { messages } from "@/messages";
import { Button } from "@/ui/button";
import { FullScreenState } from "@/ui/full-screen-state";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// PA-19 · No encontrado. Faltan dos cosas que el diseño pide y todavía no tienen a dónde
// llevar: la acción «Explorar cursos» (llega con el catálogo) y la salida a ayuda.

const text = messages.states.notFound;

export const metadata: Metadata = { title: text.title };

export default function NotFound() {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      <FullScreenState
        icon={SearchX}
        title={text.title}
        primaryAction={<Button href="/">{text.home}</Button>}
      >
        <p>{text.body}</p>
      </FullScreenState>
    </main>
  );
}
