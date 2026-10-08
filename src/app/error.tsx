"use client";

import { ServerCrash } from "lucide";

import { meta } from "@/messages/es/meta";
import { states } from "@/messages/es/states";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { FullScreenState } from "@/ui/full-screen-state";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// PA-18 · Error. Dice que algo falló, sin detalles técnicos: nunca se muestra el mensaje
// del error. Lo único que sale es el código que Next le pone a un error del servidor,
// para dictarlo a soporte.
//
// Corre en el navegador (Next lo exige), así que importa solo su bloque de textos y no el
// catálogo entero. Falta la salida a ayuda, que todavía no tiene a dónde llevar.

const text = states.error;

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
      {/* Esta página no puede declarar su título como las demás: se arma aquí, igual. */}
      <title>{t(meta.titleTemplate, { page: text.title })}</title>
      <FullScreenState
        icon={ServerCrash}
        title={text.title}
        primaryAction={<Button onClick={() => retry()}>{text.retry}</Button>}
        secondaryActions={
          <Button href="/" variant="secondary">
            {text.home}
          </Button>
        }
        reference={error.digest ? t(text.reference, { code: error.digest }) : undefined}
      >
        <p>{text.body}</p>
      </FullScreenState>
    </main>
  );
}
