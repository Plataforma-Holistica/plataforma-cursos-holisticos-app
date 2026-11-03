import { describe, expect, it } from "vitest";

import type { DraftCourse, SubmitPreview } from "@/services/drafts/editor";

import { submitView } from "./rows";

// Lo que PA-44 pinta (T-405): lo que falta enlaza al lugar exacto del editor, los avisos de duración no impiden enviar, y el anexo con la frase solo si no falta nada.

const COURSE = "c0000000-0000-4000-8000-000000000002";
const MODULE = "e0000000-0000-4000-8000-000000000001";
const LESSON = "d0000000-0000-4000-8000-000000000001";
const ANNEX = "a1000000-0000-4000-8000-000000000003";

const draft = {
  id: COURSE,
  state: "draft",
  title: "Respirar",
  modules: [{ id: MODULE, title: "Inicio", position: 1, revision: 1, lessons: [{ id: LESSON, title: "Primera", description: null, position: 1, revision: 1 }] }],
  videos: [{ id: "v1", lessonId: LESSON, state: "ready", isCurrent: true, fileName: "a.mp4", sizeBytes: 1, captionsReady: true, seconds: 1_800, errorCode: null, claimedAt: null, deletesAt: null }],
} as unknown as DraftCourse;
const TOLERANCE = { minSeconds: 15 * 60, maxSeconds: 25 * 60 };
const READY: SubmitPreview = {
  kind: "ready",
  annex: { id: ANNEX, version: 1, title: "Anexo", body: "Texto.", effectiveFrom: "2026-11-01T06:00:00Z" },
  termYears: 10,
  statement: "Acepto el anexo de licencia, versión 1, para el curso «Respirar», versión 1, por 10 años.",
  submissionNo: 1,
  contentSha256: "c".repeat(64),
};

describe("submitView", () => {
  it("listo: lo completo, el anexo, la frase y el botón con lo que se vio", () => {
    const view = submitView(READY, draft, TOLERANCE);
    expect(view.missing).toEqual([]);
    expect(view.done).toHaveLength(3);
    expect(view.annex).toMatchObject({ statement: READY.statement, draft: false, href: `/portal/anexo/${ANNEX}` });
    expect(view.annex?.button).toBe(`submit:${COURSE}:${ANNEX}:${"c".repeat(64)}:10:1`);
    expect(view.self).toBe(`/portal/cursos/${COURSE}/enviar`);
  });

  it("una lección fuera de tolerancia es un aviso, no impide enviar", () => {
    const view = submitView(READY, draft, TOLERANCE);
    expect(view.warnings).toEqual([expect.stringContaining("«Primera» dura 30 min")]);
    expect(view.annex).not.toBeNull();
  });

  it("sin tolerancia leída, sin avisos", () => {
    expect(submitView(READY, draft, null).warnings).toEqual([]);
  });

  it("falta algo: cada línea enlaza a su lugar, sin anexo", () => {
    const view = submitView(
      {
        kind: "not_ready",
        missing: [
          { what: "summary", module: null, lesson: null, resource: null, title: null, revision: null },
          { what: "module_empty", module: MODULE, lesson: null, resource: null, title: "Inicio", revision: null },
          { what: "lesson_no_video", module: MODULE, lesson: LESSON, resource: null, title: "Primera", revision: null },
        ],
      },
      draft,
      TOLERANCE,
    );
    expect(view.annex).toBeNull();
    expect(view.missing.map((line) => line.href)).toEqual([`/portal/cursos/${COURSE}`, `/portal/cursos/${COURSE}?modulo=${MODULE}`, `/portal/cursos/${COURSE}?leccion=${LESSON}`]);
    expect(view.missing[2]?.text).toContain("«Primera»");
  });

  it("un recurso a medio subir se quita desde aquí, con su revisión", () => {
    const view = submitView(
      { kind: "not_ready", missing: [{ what: "resource_pending", module: null, lesson: null, resource: "e0000000-0000-4000-8000-000000000009", title: "Guía", revision: 4 }] },
      draft,
      TOLERANCE,
    );
    expect(view.missing[0]).toMatchObject({ href: null, remove: `remove:${COURSE}:e0000000-0000-4000-8000-000000000009:4` });
  });

  it("sin anexo vigente, o si ya no es borrador, lo dice", () => {
    expect(submitView({ kind: "annex_missing" }, draft, TOLERANCE).blocked).toMatch(/falta el texto vigente del anexo/);
    expect(submitView({ kind: "not_editable" }, draft, TOLERANCE).blocked).toMatch(/ya no es un borrador/);
  });

  it("la versión 0 dice que es un borrador sin validez", () => {
    expect(submitView({ ...READY, annex: { ...READY.annex, version: 0 } }, draft, TOLERANCE).annex?.draft).toBe(true);
  });
});
