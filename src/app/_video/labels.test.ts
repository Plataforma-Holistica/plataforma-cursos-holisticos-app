import { describe, expect, it } from "vitest";

import { controlLabels, SEEK_SECONDS } from "./labels";

// Los nombres de los controles (diseño, sección 5.4, tabla de controles), sobre las claves de
// media-chrome: las que dan el nombre accesible van en minúsculas y las que dan la etiqueta,
// con mayúscula. Sin estas, los controles dirían los nombres de fábrica («Retroceder»,
// «Reactivar sonido», «Entrar en modo pantalla completa»).

describe("los nombres de los controles", () => {
  const labels = controlLabels();

  it.each([
    ["play", "Reproducir"],
    ["Play", "Reproducir"],
    ["pause", "Pausar"],
    ["Pause", "Pausar"],
    ["seek back {seekOffset} seconds", `Regresar ${SEEK_SECONDS} segundos`],
    ["Seek backward", `Regresar ${SEEK_SECONDS} segundos`],
    ["seek forward {seekOffset} seconds", `Adelantar ${SEEK_SECONDS} segundos`],
    ["Seek forward", `Adelantar ${SEEK_SECONDS} segundos`],
    ["mute", "Silenciar"],
    ["Mute", "Silenciar"],
    ["unmute", "Activar sonido"],
    ["Unmute", "Activar sonido"],
    ["volume", "Volumen"],
    ["seek", "Avance"],
    ["{currentTime} of {totalTime}", "{currentTime} de {totalTime}"],
    ["Captions", "Subtítulos"],
    ["closed captions", "Subtítulos"],
    ["Enable captions", "Activar subtítulos"],
    ["Disable captions", "Desactivar subtítulos"],
    ["Playback rate", "Velocidad"],
    ["Playback rate {playbackRate}", "Velocidad, {playbackRate}"],
    ["current playback rate", "Velocidad actual"],
    ["enter fullscreen mode", "Pantalla completa"],
    ["Enter fullscreen mode", "Pantalla completa"],
    ["exit fullscreen mode", "Salir de pantalla completa"],
    ["Exit fullscreen mode", "Salir de pantalla completa"],
  ])("%s: «%s»", (key, label) => {
    expect(labels[key]).toBe(label);
  });

  it("deja las llaves que media-chrome sustituye, y ninguna otra", () => {
    for (const [key, label] of Object.entries(labels)) {
      const keyMarkers = [...key.matchAll(/\{(\w+)\}/g)].map((found) => found[1]);
      const labelMarkers = [...label.matchAll(/\{(\w+)\}/g)].map((found) => found[1]);
      // El salto ya lleva su cifra: media-chrome no tiene a quién preguntarle otra.
      if (key.includes("{seekOffset}")) expect(labelMarkers, key).toEqual([]);
      else expect(labelMarkers, key).toEqual(keyMarkers);
    }
  });
});
