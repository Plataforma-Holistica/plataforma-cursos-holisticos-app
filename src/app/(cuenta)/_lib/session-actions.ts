"use server";

import { redirect } from "next/navigation";

import { cookieJar } from "@/app/_lib/request-context";
import { forgetBrowserProofs, signOut } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";

/**
 * «Salir» y «Cerrar sesión» (FL-05, A1): cierra solo esta sesión y deja a la persona en la
 * portada. No recibe nada del formulario: lo único que usa es la cookie de quien pide.
 * Si Auth no pudo cerrarla, la cookie se borra igual y el servicio lo reporta.
 *
 * Se lleva también el resguardo del buzón y el factor a medias de ese navegador: quien sale
 * ya no está ahí. Si tenía una invitación sin aceptar, prueba su buzón otra vez.
 */
export async function signOutAction(): Promise<void> {
  const jar = await cookieJar();
  await signOut(jar);
  forgetBrowserProofs(jar);
  redirect(ROUTES.landing);
}
