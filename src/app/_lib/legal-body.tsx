import type { LegalBlock } from "@/services/legal/blocks";

// El cuerpo de un texto legal, pintado bloque por bloque: el de la página pública (PA-07) y el de la vista
// previa y las versiones de PA-89 (T-110), para que lo que se revisa antes de publicar se vea como se
// leerá. Nunca como HTML. Si el cuerpo abre repitiendo su título, ese título ya es el de la página.
//
// Viaja al navegador con la vista previa de PA-89: del servicio, solo el tipo.

const HEADINGS = { 1: "text-h2", 2: "text-h3", 3: "text-body-l font-semibold" } as const;

function Block({ block }: { block: LegalBlock }) {
  if (block.kind === "paragraph") return <p>{block.text}</p>;
  // El título de la página es el del texto: los del cuerpo empiezan un nivel abajo.
  if (block.level === 1) return <h2 className={HEADINGS[1]}>{block.text}</h2>;
  if (block.level === 2) return <h3 className={HEADINGS[2]}>{block.text}</h3>;
  return <h4 className={HEADINGS[3]}>{block.text}</h4>;
}

export function LegalBody({ title, blocks }: { title: string; blocks: readonly LegalBlock[] }) {
  const shown = blocks.filter((block, index) => !(index === 0 && block.kind === "heading" && block.level === 1 && block.text === title));
  return (
    <div className="flex flex-col gap-4 text-body-l text-text">
      {shown.map((block, index) => (
        // Los bloques de un texto no cambian de orden: su posición los identifica.
        <Block key={`${index}-${block.kind}`} block={block} />
      ))}
    </div>
  );
}
