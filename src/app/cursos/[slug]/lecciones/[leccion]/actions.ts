"use server";

import { redirect } from "next/navigation";

import { cookieJar } from "@/app/_lib/request-context";
import { rememberCaptions } from "@/services/account/account";
import { lessonPath, ROUTES } from "@/services/account/navigation";
import { getMediaGrant, playbackPresence } from "@/services/media/media";

import { presenceReplyOf, watchAnswerOf, type PresenceReply, type WatchAnswer } from "./outcomes";

// Las acciones del reproductor de la lección (PA-22, T-203). La primera pide la dirección del
// video a la función única de medios, como el alumno (`watch`), después de pintar la página: la
// dirección nunca viaja en el HTML (RF-305). Lo que llega es la lección, nunca un playback id; la
// función la revisa, corre la guarda de sesión y decide. La segunda recuerda en la cuenta si se
// dejaron los subtítulos encendidos (RF-310). La tercera es el latido de presencia de la
// reproducción abierta (T-204, RF-107).

/** A la página de la lección, donde decide la guarda; o al inicio, si no se sabe cuál. */
function backTo(slug: unknown, lessonId: unknown): never {
  const back = typeof slug === "string" && typeof lessonId === "string" ? lessonPath(slug, lessonId) : null;
  redirect(back ?? ROUTES.home);
}

/**
 * La dirección firmada de la lección, con su marca y sus velocidades, o lo que se pinta en su
 * lugar. Si la sesión ya no pasa (suspendida, o sin sesión), vuelve a la página, donde decide
 * la guarda. `closing` es la reproducción que la persona pide cerrar en el mismo paso (PA-34,
 * o «Reproducir aquí»): la función solo cierra una de la misma cuenta.
 */
export async function watchLessonAction(slug: unknown, lessonId: unknown, closing?: unknown): Promise<WatchAnswer> {
  const jar = await cookieJar();
  const answer = watchAnswerOf(await getMediaGrant(jar, lessonId, "watch", { closing }));
  if (answer.kind === "reload") backTo(slug, lessonId);
  return answer;
}

/**
 * El latido de presencia de la reproducción abierta, mientras el video avanza: si sigue, si se
 * cerró y desde dónde, o si había vencido y el lugar está ocupado. Si la sesión ya no pasa o
 * se cerró, vuelve a la página.
 */
export async function playbackPresenceAction(slug: unknown, lessonId: unknown, sessionId: unknown): Promise<PresenceReply> {
  const answer = presenceReplyOf(await playbackPresence(await cookieJar(), sessionId));
  if (answer.kind === "reload") backTo(slug, lessonId);
  return answer;
}

/**
 * Recordar en la cuenta de la sesión que pide si deja los subtítulos encendidos: el
 * reproductor la llama cuando la persona los enciende o los apaga. Lo que no es encendido o
 * apagado no se guarda. No contesta nada: es una preferencia, y si no se guardó, el servicio
 * ya lo reportó y el video sigue igual.
 */
export async function rememberCaptionsAction(on: unknown): Promise<void> {
  if (typeof on !== "boolean") return;
  await rememberCaptions(await cookieJar(), on);
}
