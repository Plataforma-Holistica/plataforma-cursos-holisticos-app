// El cuerpo de un texto legal, partido en títulos y párrafos para pintarlo.
//
// Los textos se guardan como texto plano con una convención mínima: un renglón que empieza
// con numerales es un título, y un renglón en blanco separa párrafos. Nada más se
// interpreta. Lo que parezca marcado (un enlace, unas negritas, una etiqueta) sale como
// texto, tal cual: quien pinta estos bloques nunca los pinta como HTML.

export type LegalBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string };

const HEADING = /^(#+)\s+(\S.*)$/;

export function legalBlocks(body: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];
  const close = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (const raw of body.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line === "") {
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      close();
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: heading[2] });
      continue;
    }
    paragraph.push(line);
  }
  close();
  return blocks;
}
