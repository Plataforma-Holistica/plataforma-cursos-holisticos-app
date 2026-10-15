"use server";

import { redirect } from "next/navigation";

import { cookieJar } from "@/app/_lib/request-context";
import { rememberCaptions } from "@/services/account/account";
import { lessonPath, ROUTES } from "@/services/account/navigation";
import { getMediaGrant } from "@/services/media/media";

import { watchAnswerOf, type WatchAnswer } from "./outcomes";

// Las acciones del reproductor de la lección (PA-22, T-203). La primera pide la dirección del
// video a la función única de medios, como el alumno (`watch`), después de pintar la página: la
// dirección nunca viaja en el HTML (RF-305). Lo que llega es la lección, nunca un playback id; la
// función la revisa, corre la guarda de sesión y decide. La segunda recuerda en la cuenta si se
// dejaron los subtítulos encendidos (RF-310).

/**
 * La dirección firmada de la lección, con su marca y sus velocidades, o lo que se pinta en su
 * lugar. Si la sesión ya no pasa (suspendida, o sin sesión), vuelve a la página, donde decide
 * la guarda.
 */
export async function watchLessonAction(slug: unknown, lessonId: unknown): Promise<WatchAnswer> {
  const jar = await cookieJar();
  const answer = watchAnswerOf(await getMediaGrant(jar, lessonId, "watch"));
  if (answer.kind === "reload") {
    const back = typeof slug === "string" && typeof lessonId === "string" ? lessonPath(slug, lessonId) : null;
    redirect(back ?? ROUTES.home);
  }
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
