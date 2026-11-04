"use client";

import { useActionState, useEffect, useRef } from "react";

import { portal } from "@/messages/es/portal";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { InlineAlert } from "@/ui/inline-alert";

import { payoutCsvAction } from "./actions";
import { csvButton, DOWNLOAD_BLOCK_ID, type CsvFailure, type CsvState } from "./outcomes";

// «Descargar CSV» de PA-47 (T-604, cuarta solicitud), con el patrón de la exportación del cierre (PA-80): la acción devuelve el archivo como dirección
// de datos en un enlace con `download`, que con JavaScript se pulsa solo una vez por respuesta y queda para guardarlo otra vez. Sin JavaScript, el
// enlace se pinta con la respuesta y se pulsa a mano. Sin PDF: queda fuera de T-604.

const text = portal.payouts;
const IDLE: CsvState = { kind: "idle" };

const FAILURES: Readonly<Record<CsvFailure, string>> = {
  not_found: text.downloadFailed.notFound,
  unavailable: text.downloadFailed.unavailable,
};

export function CsvDownload({ period, page }: { period: string; page: string }) {
  const [state, send, pending] = useActionState(payoutCsvAction, IDLE, `${page}#${DOWNLOAD_BLOCK_ID}`);
  const link = useRef<HTMLAnchorElement>(null);
  const saved = useRef(0);
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  useEffect(() => {
    if (state.kind !== "file" || saved.current === attempt) return;
    saved.current = attempt;
    link.current?.click();
  }, [state.kind, attempt]);

  return (
    <div className="flex flex-col gap-3">
      {!pending && state.kind === "failed" && (
        <InlineAlert key={`descarga-${attempt}`} tone="danger" live>
          {FAILURES[state.reason]}
        </InlineAlert>
      )}
      {!pending && state.kind === "file" && (
        <InlineAlert key={`archivo-${attempt}`} tone="success" live>
          {text.downloadReady}
          {SPACE}
          <a ref={link} href={state.href} download={state.fileName} className="text-accent underline">
            {text.saveFile}
          </a>
        </InlineAlert>
      )}
      <form action={send} noValidate>
        <Button type="submit" variant="secondary" name="do" value={csvButton(period)} loading={pending} loadingLabel={text.downloading}>
          {text.download}
        </Button>
      </form>
    </div>
  );
}
