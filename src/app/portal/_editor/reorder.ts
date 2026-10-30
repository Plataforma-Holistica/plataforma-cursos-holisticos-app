import { editorButton } from "./outcomes";

// Arrastrar en la estructura del editor de curso (diseño, `ReorderList`; PA-43; tercera solicitud de
// T-402). Es puro y viaja al navegador. Arrastrar nunca es la única forma (WCAG 2.5.7): «Subir», «Bajar» y
// «Mover a» siguen ahí, y sin JavaScript son lo único.
//
//   · Con el teclado, la fila tomada se mueve dentro de su lista (Espacio la toma, las flechas la mueven,
//     Espacio la suelta, Escape cancela). A otro módulo, con «Mover a».
//   · Con el ratón, una fila soltada sobre otra toma su lugar; una lección soltada sobre otro módulo va al
//     final de ese módulo.
//   · Lo que se manda al soltar es un botón con lo que se vio, por la misma acción que «Subir»: la base
//     contesta «cambió» si la estructura ya no es la que se arrastró.

export type Dragged = { kind: "module" | "lesson"; id: string };

interface Structure {
  id: string;
  lessons: readonly { id: string }[];
}

/** El lugar siguiente con una flecha, de 1 a `count`. */
export function stepTo(count: number, current: number, key: "up" | "down"): number {
  return key === "up" ? Math.max(1, current - 1) : Math.min(count, current + 1);
}

/** El botón que manda soltar `dragged` sobre `over`, o nulo si no cambia nada. */
export function dropButton(modules: readonly Structure[], dragged: Dragged, over: Dragged): string | null {
  if (dragged.kind === "module") {
    if (over.kind !== "module") return null;
    const from = modules.findIndex((module) => module.id === dragged.id);
    const to = modules.findIndex((module) => module.id === over.id);
    if (from < 0 || to < 0 || from === to) return null;
    return editorButton.moduleTo(dragged.id, from + 1, to + 1);
  }
  const home = modules.find((module) => module.lessons.some((lesson) => lesson.id === dragged.id));
  if (home === undefined) return null;
  const from = home.lessons.findIndex((lesson) => lesson.id === dragged.id) + 1;
  if (over.kind === "module") {
    const target = modules.find((module) => module.id === over.id);
    if (target === undefined || target.id === home.id) return null;
    return editorButton.lessonTo(dragged.id, home.id, from, target.id, target.lessons.length + 1);
  }
  const target = modules.find((module) => module.lessons.some((lesson) => lesson.id === over.id));
  if (target === undefined || over.id === dragged.id) return null;
  const to = target.lessons.findIndex((lesson) => lesson.id === over.id) + 1;
  return editorButton.lessonTo(dragged.id, home.id, from, target.id, to);
}
