"use server";

import { refresh } from "next/cache";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { checkCode, readGiveCodeForm } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { cookieJar } from "@/app/_lib/request-context";
import { addItem, giveCatalogCode, moveItem, renameItem, setItemActive, type CatalogList } from "@/services/catalog/catalog";

import {
  activeOutcome,
  addOutcome,
  catalogCodeOutcome,
  checkName,
  moveOutcome,
  readCatalogForm,
  renameOutcome,
  type CatalogState,
  type CodeState,
} from "./outcomes";

// Las acciones de la pantalla de las prácticas y los niveles (diseño, PA-67; RF-709). Ninguna
// decide quién puede: el servicio corre la guarda y la base vuelve a comprobar que quien pide
// tenga Contenido y un código reciente. Aquí se lee qué botón se pulsó, se llama al servicio
// y se traduce su respuesta con la tabla de la pantalla.
//
// Cada lista tiene su acción, que es la que dice de qué lista se trata: el formulario solo
// dice qué botón y qué fila. Del estado anterior solo se lee el número de intento.

/**
 * Dar el código otra vez, para que un cambio a las listas pase su puerta. Un código sin forma
 * no llega al servicio: no es un intento, y no cuenta en el freno. Verificado, se redirige a
 * esta misma página en vez de pintarla: recargar no reenvía el código.
 */
export async function catalogCodeAction(previous: CodeState, form: FormData): Promise<CodeState> {
  const { code } = readGiveCodeForm(form);
  const attempt = nextAttempt(previous);

  const problem = checkCode(code);
  if (problem) return { kind: "invalid", problem, attempt };

  const jar = await cookieJar();
  const outcome = catalogCodeOutcome(await giveCatalogCode(jar, code));
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  return { kind: "failed", reason: outcome.reason, attempt };
}

/** Las prácticas: agregar, renombrar, ordenar, desactivar y reactivar. */
export async function practicesAction(previous: CatalogState, form: FormData): Promise<CatalogState> {
  return listAction("practices", previous, form);
}

/** Los niveles: lo mismo, en su lista. */
export async function levelsAction(previous: CatalogState, form: FormData): Promise<CatalogState> {
  return listAction("levels", previous, form);
}

/**
 * Un envío a una lista. «Renombrar» y «Cancelar» no llaman a nadie. Un nombre sin forma no
 * llega al servicio: se dice en su campo, con lo escrito. Lo demás le pregunta al servicio y,
 * salvo que se salga de la página, la vuelve a pedir: la lista pudo cambiar, se haya hecho o
 * no lo que se pidió.
 */
async function listAction(list: CatalogList, previous: CatalogState, form: FormData): Promise<CatalogState> {
  const request = readCatalogForm(form);
  if (request.step === "none" || request.step === "cancel") return { kind: "idle" };
  const attempt = nextAttempt(previous);
  if (request.step === "rename") return { kind: "renaming", id: request.id, name: null, problem: null, attempt };

  if (request.step === "add") {
    const problem = checkName(request.name);
    if (problem) return { kind: "add_invalid", name: request.name, problem, attempt };
  }
  if (request.step === "save") {
    const problem = checkName(request.name);
    if (problem) return { kind: "renaming", id: request.id, name: request.name, problem, attempt };
  }

  const jar = await cookieJar();
  let outcome;
  switch (request.step) {
    case "add":
      outcome = addOutcome(await addItem(jar, { list, name: request.name }), request.name);
      break;
    case "save":
      outcome = renameOutcome(await renameItem(jar, { list, id: request.id, name: request.name }), request.id, request.name);
      break;
    case "move":
      outcome = moveOutcome(
        await moveItem(jar, { list, id: request.id, direction: request.direction, position: request.position }),
        request.id,
        request.direction,
      );
      break;
    case "active":
      outcome = activeOutcome(await setItemActive(jar, { list, id: request.id, active: request.active }), request.id);
      break;
  }
  if (outcome.kind === "leave") return leaveFor(jar, outcome);

  refresh();
  return outcome.kind === "idle" ? { kind: "idle" } : { ...outcome, attempt };
}
