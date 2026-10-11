import "server-only";

import { accountFormFacts, type AccountFormFacts, type CookieJar } from "@/services/account/account";
import { parseEmail } from "@/services/account/field-rules";
import { forgetRegistration, readRegistration, rememberRegistration } from "@/services/account/pending-registration";

import { resendWait, type ResendWait } from "../verificar/outcomes";

// Lo que las pantallas públicas de la cuenta leen de la base: los textos vigentes que se
// aceptan al completar el registro y dos parámetros, cuánto dura un enlace y cuánto hay que
// esperar para pedir otro.
//
// Dos reglas. La primera: una acción lee esto después de pedir el correo, nunca antes. Lo
// que se le contesta a quien pide no puede depender de si ese correo tiene cuenta, y esta
// lectura tarda lo mismo en los dos casos. Si no se supo, la pantalla dice lo mismo sin la
// cifra.
//
// La segunda: se recuerda unos segundos. `/verificar` y `/verificar/[token]` son públicas, y
// sin memoria cada visita abriría una transacción en la misma reserva de conexiones con la
// que la gente entra. Es la razón por la que el servicio de textos legales también recuerda.

/** Cuánto se recuerda lo leído, se haya podido leer o no. */
export const FORM_FACTS_MEMORY_MS = 5_000;

let remembered: { at: number; facts: AccountFormFacts } | null = null;
let reading: Promise<AccountFormFacts> | null = null;

/**
 * Lo que necesita un formulario público de la cuenta, leído de la base a lo más una vez cada
 * `FORM_FACTS_MEMORY_MS`, y una sola vez aunque lo pidan muchos a la vez. También recuerda
 * que no se supo: una base caída no recibe una lectura por visita, ni un reporte por cada una.
 *
 * Lo recordado puede ser de hace unos segundos. No importa para aceptar un texto: el
 * servicio compara lo aceptado con lo vigente al enviar, y si cambió, quien lo llama olvida
 * lo recordado (`forgetFormFacts`) y la pantalla se vuelve a pintar.
 */
export function formFacts(): Promise<AccountFormFacts> {
  const now = Date.now();
  if (remembered !== null && now >= remembered.at && now - remembered.at < FORM_FACTS_MEMORY_MS) {
    return Promise.resolve(remembered.facts);
  }
  reading ??= accountFormFacts()
    .then((facts) => {
      remembered = { at: Date.now(), facts };
      return facts;
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

/** Olvida lo recordado: el servicio acaba de decir que un texto ya no es el vigente. */
export function forgetFormFacts(): void {
  remembered = null;
}

/** Lo que dura un enlace del correo (`VIGENCIA_ENLACE_CONTRASENA`), en segundos, o nulo si no se supo. */
export async function linkLifetimeSeconds(): Promise<number | null> {
  const facts = await formFacts();
  return facts.kind === "ready" ? facts.linkLifetimeMinutes * 60 : null;
}

/**
 * Lo que «Revisa tu correo» dice de un registro anotado: cuánto dura el enlace y cuánto le
 * falta a «Reenviar». Nulo si no se supo: la pantalla lo calla y deja reenviar, porque la
 * espera de verdad la lleva el servicio.
 *
 * @param sentAt Cuándo se pidió el último envío, en milisegundos.
 */
export async function pendingRequestFacts(sentAt: number): Promise<{ lifetimeSeconds: number; wait: ResendWait | null } | null> {
  const facts = await formFacts();
  if (facts.kind !== "ready") return null;
  return { lifetimeSeconds: facts.linkLifetimeMinutes * 60, wait: resendWait(sentAt, facts.resendWaitSeconds, Date.now()) };
}

/**
 * Anota en este navegador a qué correo se le acaba de pedir el enlace de registro, para que
 * «Revisa tu correo» lo diga y deje reenviarlo (diseño, PA-14). La cookie dura lo que el
 * enlace.
 *
 * Si no se supo cuánto dura, no se anota nada. Y si lo que este navegador tenía anotado era
 * otro correo, el de un registro anterior, se olvida: dejarlo diría que el enlace se mandó
 * ahí, y «Reenviar» lo mandaría ahí. La pantalla pinta entonces su texto genérico.
 *
 * @returns La espera que le queda a «Reenviar», o nulo.
 */
export async function rememberRequest(jar: CookieJar, email: string): Promise<ResendWait | null> {
  const facts = await formFacts();
  if (facts.kind !== "ready") {
    const noted = readRegistration(jar);
    const asked = parseEmail(email);
    if (noted !== null && !(asked.ok && asked.email === noted.email)) forgetRegistration(jar);
    return null;
  }
  const sentAt = Date.now();
  rememberRegistration(jar, { email, sentAt }, facts.linkLifetimeMinutes * 60);
  return resendWait(sentAt, facts.resendWaitSeconds, sentAt);
}
