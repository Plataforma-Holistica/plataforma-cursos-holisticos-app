"use client";

import { useEffect, useRef, useState } from "react";

import { useHydrated } from "@/app/(cuenta)/_lib/hooks";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { VIDEO_EXTENSIONS, videoMimeOf } from "@/services/drafts/field-rules";
import { Button } from "@/ui/button";
import { FileUpload } from "@/ui/file-upload";
import { InlineAlert } from "@/ui/inline-alert";
import { ProgressBar } from "@/ui/progress-bar";

import { progressStep } from "./resource-outcomes";
import type { VideoRow } from "./rows";
import { checkVideoFile, type VideoProblem } from "./video-outcomes";
import { useVideoUploads } from "./video-uploads";

// El video de una lección en PA-43 (T-403; RF-604, FL-33). Lo que está subiendo vive arriba (`video-uploads.tsx`), y lo que ya llegó,
// en la base. Procesar y ver llegan con las solicitudes que siguen: por ahora la historia termina en «Recibido».
//
//   · Pausar y Reanudar son el mismo botón: el foco se queda en él.
//   · Cancelar y quitar preguntan antes: una subida puede llevar horas. Seguir devuelve el foco al botón que preguntó.
//   · Un botón que se va con el foco puesto (terminó de subir) lo deja en el bloque, y solo si no se fue a otra cosa.
//   · El avance se anuncia cada 25 % (diseño, `FileUpload`), y no con cada evento; la barra sí va exacta.

const text = portal.editor.videos;
const percentOf = (loaded: number, total: number) => (total > 0 ? Math.floor((Math.min(loaded, total) / total) * 100) : 0);

interface Props {
  lesson: string;
  row: VideoRow | null;
  editable: boolean;
  maxBytes: number | null;
  maxText: string;
}

function VideoQuestion({ question, stay, go, onStay, onGo }: { question: string; stay: string; go: string; onStay: () => void; onGo: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div ref={box} tabIndex={-1} className="flex flex-col gap-3 rounded-md border border-danger p-4 outline-none">
      <p className="text-body">{question}</p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={onStay}>
          {stay}
        </Button>
        <Button type="button" variant="danger" onClick={onGo}>
          {go}
        </Button>
      </div>
    </div>
  );
}

export function VideoBlock({ lesson, row, editable, maxBytes, maxText }: Props) {
  const hydrated = useHydrated();
  const { uploads, notices, start, pause, resume, retryConfirm, remove } = useVideoUploads();
  const [localProblem, setLocalProblem] = useState<{ problem: VideoProblem; attempt: number } | null>(null);
  const [asking, setAsking] = useState(false);
  const upload = uploads.get(lesson);
  const notice = notices.get(lesson);
  const section = useRef<HTMLElement>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const wasAsking = useRef(false);
  const hadUpload = useRef(false);
  const hasUpload = upload !== undefined;
  useEffect(() => {
    // El último de la fila es el que preguntó. Si se fue con la respuesta, el foco queda en el bloque.
    if (wasAsking.current && !asking) (buttons.current?.querySelector<HTMLElement>("button:last-child") ?? section.current)?.focus();
    wasAsking.current = asking;
  }, [asking]);
  useEffect(() => {
    if (hadUpload.current && !hasUpload && document.activeElement === document.body) section.current?.focus();
    hadUpload.current = hasUpload;
  }, [hasUpload]);

  function onFile(file: File) {
    const problem = checkVideoFile(file, videoMimeOf(file.name) !== null, maxBytes);
    if (problem !== null) {
      setLocalProblem((current) => ({ problem, attempt: (current?.attempt ?? 0) + 1 }));
      return;
    }
    setLocalProblem(null);
    start(lesson, file);
  }

  const video = upload !== undefined && "video" in upload ? upload.video : (row?.id ?? null);
  const moving = upload !== undefined && (upload.phase === "sending" || upload.phase === "paused" || upload.phase === "cut") ? upload : null;
  const percent = moving === null ? 0 : percentOf(moving.loaded, moving.total);
  const step = moving === null ? 0 : progressStep(moving.loaded, moving.total);
  // Lo que se quita ya llegó; lo que se cancela, todavía no.
  const received = upload === undefined && row !== null && row.state !== "uploading";
  const canPick = editable && upload === undefined && !received;
  const fileName = upload?.fileName ?? row?.fileName ?? "";

  return (
    <section ref={section} tabIndex={-1} aria-labelledby={`video-${lesson}`} className="flex flex-col gap-3 outline-none">
      <h3 id={`video-${lesson}`} className="text-h3">
        {text.title}
      </h3>

      {upload === undefined && row === null && !editable && <p className="text-body-s text-text-2">{text.none}</p>}
      {upload === undefined && row?.state === "uploading" && <InlineAlert tone="neutral">{t(editable ? text.halfway : text.halfwayReadOnly, { file: row.fileName })}</InlineAlert>}
      {received && (
        <div className="flex flex-col gap-1">
          <p className="text-body break-words">{row.fileName}</p>
          <p className="text-body-s text-text-2">{t(text.states[row.state], { size: row.size })}</p>
        </div>
      )}

      {canPick && !hydrated && <p className="text-body-s text-text-2">{text.needsJavascript}</p>}
      {canPick && hydrated && (
        <FileUpload
          label={row?.state === "uploading" ? text.pickSame : text.pick}
          hint={maxText === "" ? text.hintNoLimit : t(text.hint, { max: maxText })}
          accept={VIDEO_EXTENSIONS.join(",")}
          onFile={onFile}
        />
      )}

      {upload?.phase === "starting" && <p className="text-body-s text-text-2">{text.starting}</p>}
      {moving !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-body-s break-words text-text-2">{fileName}</p>
          <ProgressBar value={moving.loaded} max={moving.total} label={text.progressLabel} text={t(moving.phase === "paused" ? text.paused : text.progress, { percent: String(percent) })} />
          {moving.phase === "cut" && (
            <InlineAlert tone="warning" live>
              {text.cut}
            </InlineAlert>
          )}
        </div>
      )}
      {upload?.phase === "checking" && <p className="text-body-s text-text-2">{text.checking}</p>}
      {upload?.phase === "removing" && <p className="text-body-s text-text-2">{text.removing}</p>}

      {/* Existe desde antes: una región que nace con su texto no siempre se anuncia. El avance, en pasos y sin verse: la barra ya lo dice. */}
      <p role="status" className="text-body-s text-text-2">
        {moving?.phase === "sending" ? <span className="sr-only">{t(text.progress, { percent: String(step) })}</span> : notice !== undefined && "done" in notice ? text.received : null}
      </p>
      {localProblem !== null && (
        <InlineAlert key={`local-${localProblem.attempt}`} tone="danger" live>
          {text.problems[localProblem.problem]}
        </InlineAlert>
      )}
      {notice !== undefined && "problem" in notice && (
        <InlineAlert key={`aviso-${notice.attempt}`} tone="danger" live>
          {text.problems[notice.problem]}
        </InlineAlert>
      )}
      {notice !== undefined && "pendingFile" in notice && (
        <InlineAlert key={`aviso-${notice.attempt}`} tone="warning" live>
          {t(text.pendingOther, { file: notice.pendingFile })}
        </InlineAlert>
      )}

      {editable && asking && video !== null ? (
        <VideoQuestion
          question={received ? t(text.confirmRemove, { file: fileName }) : t(text.confirmCancel, { file: fileName })}
          stay={received ? text.keep : text.keepUploading}
          go={received ? text.remove : text.cancel}
          onStay={() => setAsking(false)}
          onGo={() => {
            setAsking(false);
            remove(lesson, video);
          }}
        />
      ) : (
        editable &&
        video !== null && (
          <div ref={buttons} className="flex flex-wrap gap-3">
            {moving !== null && (
              <Button type="button" variant="secondary" onClick={() => (moving.phase === "sending" ? pause(lesson) : resume(lesson))}>
                {moving.phase === "sending" ? text.pause : text.resume}
              </Button>
            )}
            {upload?.phase === "unchecked" && (
              <Button type="button" variant="secondary" onClick={() => retryConfirm(lesson)}>
                {text.retry}
              </Button>
            )}
            {upload?.phase !== "checking" && upload?.phase !== "starting" && upload?.phase !== "removing" && (
              <Button type="button" variant="danger" onClick={() => setAsking(true)}>
                {received ? text.remove : text.cancel}
              </Button>
            )}
          </div>
        )
      )}
    </section>
  );
}
