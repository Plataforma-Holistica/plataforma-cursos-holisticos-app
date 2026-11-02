"use client";

import { unstable_rethrow } from "next/navigation";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import type { PlayerProps } from "@/app/_video/player";
import { portal } from "@/messages/es/portal";
import { Button } from "@/ui/button";

import { videoPreviewAction } from "./video-actions";
import type { VideoPreviewStep } from "./video-outcomes";

// Ver el video de una lección en el editor (PA-43; FL-33, paso 4). Sin reproducción ni latidos: no genera puntos, y lo dice. La dirección se pide al pulsar «Ver», y el
// reproductor se descarga entonces: nunca van con la página. Si la dirección caduca a media vista se pide otra una vez, y sigue en el segundo en que iba.

const text = portal.editor.videos;

/** Si el reproductor no se pudo descargar: se dice como cualquier otro error. */
function PlayerMissing({ onFailed }: PlayerProps) {
  useEffect(() => onFailed(), [onFailed]);
  return null;
}

// Mux Player pesa: se descarga solo cuando hay algo que reproducir, y nunca en el servidor.
const Player = dynamic(() => import("@/app/_video/player").then((module) => module.Player, () => PlayerMissing), {
  ssr: false,
  loading: () => <p className="text-body-s text-text-2">{text.watchLoading}</p>,
});

type Grant = Extract<VideoPreviewStep, { kind: "granted" }>;
type View =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "playing"; grant: Grant; number: number; startTime: number; renewed: boolean }
  | { kind: "none" }
  | { kind: "failed" };

export function VideoPreview({ course, lesson }: { course: string; lesson: string }) {
  const [view, setView] = useState<View>({ kind: "closed" });
  const ticket = useRef(0);

  async function open(startTime: number, renewed: boolean) {
    ticket.current += 1;
    const mine = ticket.current;
    if (!renewed) setView({ kind: "loading" });
    let answer: VideoPreviewStep;
    try {
      answer = await videoPreviewAction({ course, lesson });
    } catch (error) {
      unstable_rethrow(error);
      answer = { kind: "unavailable" };
    }
    if (mine !== ticket.current) return;
    if (answer.kind === "granted") setView({ kind: "playing", grant: answer, number: mine, startTime, renewed });
    else setView({ kind: answer.kind === "no_video" ? "none" : "failed" });
  }

  function close() {
    // Lo que venga en camino ya no pinta nada.
    ticket.current += 1;
    setView({ kind: "closed" });
  }

  const opened = view.kind === "loading" || view.kind === "playing";

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button type="button" variant="secondary" onClick={() => (opened ? close() : void open(0, false))}>
          {opened ? text.stopWatching : text.watch}
        </Button>
      </div>
      {opened && <p className="text-body-s text-text-2">{text.watchLabel}</p>}
      {view.kind === "playing" && (
        <Player
          grant={view.number}
          playbackId={view.grant.playbackId}
          tokens={view.grant.tokens}
          startTime={view.startTime}
          speeds={view.grant.speeds}
          watermark={view.grant.watermark}
          onExpired={(at) => {
            if (view.renewed) setView({ kind: "failed" });
            else void open(at, true);
          }}
          onFailed={() => {
            ticket.current += 1;
            setView({ kind: "failed" });
          }}
          onPlaying={() => {
            if (view.renewed) setView({ ...view, renewed: false });
          }}
        />
      )}
      {/* Existe desde antes: una región que nace con su texto no siempre se anuncia. */}
      <p role="status" className="text-body-s text-text-2">
        {view.kind === "loading" ? text.watchLoading : view.kind === "none" ? text.watchNone : view.kind === "failed" ? text.watchFailed : null}
      </p>
    </div>
  );
}
