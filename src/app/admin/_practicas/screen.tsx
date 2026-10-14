"use client";

import { useActionState } from "react";

import { admin } from "@/messages/es/admin";
import { ROUTES } from "@/services/account/navigation";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { CodeBlock } from "../_lib/code-block";
import { catalogCodeAction, levelsAction, practicesAction } from "./actions";
import { ListBlock, type ListBlockIds } from "./list-block";
import type { CatalogState, CodeState } from "./outcomes";
import type { CatalogView } from "./rows";

// PA-67 · Las prácticas y los niveles del catálogo. Va por bloques, cada uno con su acción y
// su estado, y su resultado se dice en el bloque. Funciona sin JavaScript.
//
// Diferencias con la ficha del diseño, decididas el 2026-10-14: ordenar con «Subir» y «Bajar»
// en lugar de arrastrar, desactivar sin confirmar (se reactiva en la misma fila) y las
// desactivadas en su lugar de la lista. El tono de portada se muestra y no se cambia (D-05).
//
// Los cambios se ofrecen solo cuando la página leyó que el código de quien mira es reciente.
// Si no lo es, arriba va el bloque para darlo otra vez: lo decide el dato de la página.

const text = admin.catalog;
const CODE_IDLE: CodeState = { kind: "idle" };
const LIST_IDLE: CatalogState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa. Si una acción redirige, el
// navegador sin JavaScript se lleva el ancla a la pantalla de destino, y allá no debe
// apuntar a nada.
const CODE_BLOCK_ID = "bloque-catalogo-codigo";
const CODE_TITLE_ID = "catalogo-codigo-titulo";
const CODE_FIELD_ID = "catalogo-codigo";
const PRACTICES_HEADING_ID = "catalogo-practicas-titulo";
const LEVELS_HEADING_ID = "catalogo-niveles-titulo";
const PRACTICES: ListBlockIds = {
  block: "bloque-catalogo-practicas",
  heading: PRACTICES_HEADING_ID,
  addField: "catalogo-practica-nueva",
  renameField: "catalogo-practica-nombre",
};
const LEVELS: ListBlockIds = {
  block: "bloque-catalogo-niveles",
  heading: LEVELS_HEADING_ID,
  addField: "catalogo-nivel-nuevo",
  renameField: "catalogo-nivel-nombre",
};
// A dónde vuelve el navegador cuando un formulario se envía sin JavaScript: a esta misma
// pantalla, parado en el bloque que envió.
const CODE_PERMALINK = `${ROUTES.catalog}#${CODE_BLOCK_ID}`;
const PRACTICES_PERMALINK = `${ROUTES.catalog}#${PRACTICES.block}`;
const LEVELS_PERMALINK = `${ROUTES.catalog}#${LEVELS.block}`;

export interface CatalogScreenProps {
  /** Las dos listas, ya puestas en palabras por la página. */
  view: CatalogView;
}

export function CatalogScreen({ view }: CatalogScreenProps) {
  const [code, codeAction, codePending] = useActionState(catalogCodeAction, CODE_IDLE, CODE_PERMALINK);
  const [practices, sendPractices, practicesPending] = useActionState(practicesAction, LIST_IDLE, PRACTICES_PERMALINK);
  const [levels, sendLevels, levelsPending] = useActionState(levelsAction, LIST_IDLE, LEVELS_PERMALINK);

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.intro}</p>
      </div>
      {!view.canChange && (
        <CodeBlock
          blockId={CODE_BLOCK_ID}
          titleId={CODE_TITLE_ID}
          fieldId={CODE_FIELD_ID}
          body={text.codeBody}
          notAvailable={text.codeNotAvailable}
          state={code}
          action={codeAction}
          pending={codePending}
        />
      )}
      <ListBlock
        list="practices"
        ids={PRACTICES}
        view={view.practices}
        canChange={view.canChange}
        state={practices}
        action={sendPractices}
        pending={practicesPending}
      />
      <ListBlock list="levels" ids={LEVELS} view={view.levels} canChange={view.canChange} state={levels} action={sendLevels} pending={levelsPending} />
      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}
