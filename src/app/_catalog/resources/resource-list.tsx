"use client";

import { useActionState, useEffect, useRef, type FormEvent } from "react";

import { useHydrated } from "@/app/(cuenta)/_lib/hooks";
import { resources as text } from "@/messages/es/resources";
import { t } from "@/messages/format";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";

import { DOWNLOAD_CHANNEL_FIELD, DOWNLOAD_CHANNEL_JS } from "./channel";
import { openFile, reloadPage } from "./open-file";
import { downloadButton, type DownloadState } from "./outcomes";

// La lista de recursos de un curso o de una lección (RF-308; PA-02 y PA-22; T-404). Cada fila es su propio formulario, con su
// estado: lo que contesta un envío se dice junto a ese recurso, y bajar uno no detiene a los otros. El botón no se deshabilita
// mientras va en camino (perdería el foco), y no envía otra vez. Quien no puede descargar ve la lista sin botones.
//
// El campo del canal se pinta cuando la pantalla ya se montó: es lo que le dice a la acción que hay quien abra la dirección.

const IDLE: DownloadState = { kind: "idle" };

export interface ResourceItem {
  id: string;
  title: string;
  /** Su tipo y su tamaño, ya en palabras. */
  detail: string;
}

type DownloadAction = (previous: DownloadState, form: FormData) => Promise<DownloadState>;

export interface ResourceListProps {
  items: ResourceItem[];
  canDownload: boolean;
  action: DownloadAction;
  /** A dónde vuelve el formulario sin JavaScript, si la respuesta no es el archivo. */
  permalink: string;
}

function Details({ item }: { item: ResourceItem }) {
  return (
    <span className="min-w-0 flex-auto">
      <span className="block break-words text-text">{item.title}</span>
      <span className="block text-caption text-text-3">{item.detail}</span>
    </span>
  );
}

function ResourceRow({ item, action, permalink }: { item: ResourceItem; action: DownloadAction; permalink: string }) {
  const [state, formAction, pending] = useActionState(action, IDLE, permalink);
  const hydrated = useHydrated();
  const handled = useRef(0);

  // Una vez por intento: la respuesta vieja sigue en el estado mientras la pantalla se vuelve a pintar.
  useEffect(() => {
    if ((state.kind !== "granted" && state.kind !== "reload") || state.attempt === handled.current) return;
    handled.current = state.attempt;
    if (state.kind === "granted") openFile(state.url);
    else reloadPage();
  }, [state]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (pending) event.preventDefault();
  };
  const answer = pending ? null : state;
  const retrying = answer?.kind === "unavailable";
  let said: string | null = null;
  if (answer?.kind === "granted") said = text.started;
  if (answer?.kind === "gone" || answer?.kind === "throttled" || answer?.kind === "unavailable") said = text[answer.kind];
  if (answer?.kind === "denied") said = `${answer.title}. ${answer.text}`;

  return (
    <li className="flex flex-col gap-2 py-2">
      <form action={formAction} onSubmit={onSubmit} className="flex flex-wrap items-center justify-between gap-2">
        {hydrated && <input type="hidden" name={DOWNLOAD_CHANNEL_FIELD} value={DOWNLOAD_CHANNEL_JS} />}
        <Details item={item} />
        <Button type="submit" name="do" value={downloadButton(item.id)} variant="secondary" size="md" pending={pending} loadingLabel={text.preparing}>
          <span aria-hidden="true">{retrying ? text.retry : text.download}</span>
          <span className="sr-only">{t(retrying ? text.retryNamed : text.downloadNamed, { title: item.title })}</span>
        </Button>
      </form>
      <p role="status" className="sr-only">
        {said}
      </p>
      {answer?.kind === "denied" && (
        <InlineAlert tone="warning">
          <span className="block font-medium">{answer.title}</span>
          <span className="block">{answer.text}</span>
        </InlineAlert>
      )}
      {(answer?.kind === "gone" || answer?.kind === "throttled" || answer?.kind === "unavailable") && <InlineAlert tone="warning">{text[answer.kind]}</InlineAlert>}
    </li>
  );
}

export function ResourceList({ items, canDownload, action, permalink }: ResourceListProps) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {items.map((item) =>
        canDownload ? (
          <ResourceRow key={item.id} item={item} action={action} permalink={permalink} />
        ) : (
          <li key={item.id} className="py-2">
            <Details item={item} />
          </li>
        ),
      )}
    </ul>
  );
}
