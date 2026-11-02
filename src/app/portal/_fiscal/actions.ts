"use server";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar, requestOrigin } from "@/app/_lib/request-context";
import { revealTaxProfile, saveTaxProfile } from "@/services/teachers/tax-data";

import { changedElsewhere, readRevealForm, readTaxForm, revealOutcome, saveOutcome, type RevealState, type SaveState } from "./outcomes";

// PA-48 (T-409). El servicio corre la guarda y comprueba la contraseña que viene en este mismo envío: no hay un estado de «ya la dio». Del estado anterior
// solo se lee el intento, y ninguna respuesta lleva lo escrito. Con lo oculto a la vista no se pide la página otra vez: la lectura ya quedó en la auditoría.

export async function revealTaxDataAction(previous: RevealState, form: FormData): Promise<RevealState> {
  const { password } = readRevealForm(form);
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  const outcome = revealOutcome(await revealTaxProfile(jar, password, await requestOrigin()), attempt);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return outcome.state;
}

export async function saveTaxDataAction(previous: SaveState, form: FormData): Promise<SaveState> {
  const input = readTaxForm(form);
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  // Solo con un formulario armado a mano.
  if (input.seen === null) return leaveFor(jar, changedElsewhere);

  const outcome = saveOutcome(await saveTaxProfile(jar, { ...input, seen: input.seen }, await requestOrigin()), attempt);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return outcome.state;
}
