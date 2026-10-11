"use server";

import { redirect } from "next/navigation";

import { cookieJar } from "@/app/_lib/request-context";
import { signOut } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";

/**
 * «Salir» y «Cerrar sesión» (FL-05, A1): cierra solo esta sesión y deja a la persona en la
 * portada. No recibe nada del formulario: lo único que usa es la cookie de quien pide.
 * Si Auth no pudo cerrarla, la cookie se borra igual y el servicio lo reporta.
 */
export async function signOutAction(): Promise<void> {
  await signOut(await cookieJar());
  redirect(ROUTES.landing);
}
