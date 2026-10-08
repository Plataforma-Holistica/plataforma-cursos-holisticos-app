"use client";

import "@/ui/theme.css";

import { ServerCrash } from "lucide";
import { useEffect } from "react";

import { states } from "@/messages/es/states";
import { t } from "@/messages/format";
import { reportCaughtError } from "@/services/error-reporting/browser";
import { Button } from "@/ui/button";
import { FullScreenState } from "@/ui/full-screen-state";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

import { displayFont, textFont } from "./fonts";

// El error que rompe hasta el armazón de la página. Next lo pinta en un documento propio,
// sin el `layout.tsx`: por eso trae su `<html>`, su hoja de tokens y sus tipografías.
// Misma pantalla que `error.tsx` (PA-18), sin el enlace al inicio: si falló el armazón,
// lo que sirve es reintentar.

const text = states.error;

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => reportCaughtError(error), [error]);

  return (
    <html lang="es-MX" className={`${displayFont.variable} ${textFont.variable}`}>
      <body>
        <title>{text.title}</title>
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
          <FullScreenState
            icon={ServerCrash}
            title={text.title}
            primaryAction={<Button onClick={() => retry()}>{text.retry}</Button>}
            reference={error.digest ? t(text.reference, { code: error.digest }) : undefined}
          >
            <p>{text.body}</p>
          </FullScreenState>
        </main>
      </body>
    </html>
  );
}
