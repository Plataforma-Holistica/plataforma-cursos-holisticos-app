import { describe, expect, it, vi } from "vitest";

import type { ResourceStorage } from "@/adapters/supabase/storage";

import { createResourceFiles } from "./resource-files";

vi.mock("server-only", () => ({}));

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function storage(overrides: Partial<ResourceStorage> = {}): ResourceStorage {
  return {
    signUpload: vi.fn(() => Promise.resolve("https://storage/subir")),
    readStart: vi.fn(() => Promise.resolve(ascii("%PDF-1.7"))),
    readEnd: vi.fn(() => Promise.resolve(null)),
    remove: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("el contenido de un recurso", () => {
  it("lo que se leyó y corresponde: sí", async () => {
    await expect(createResourceFiles(storage()).contentOk("a/b/c", PDF)).resolves.toBe(true);
  });

  it("lo que se leyó y no corresponde: no, y eso destruye la fila", async () => {
    const files = createResourceFiles(storage({ readStart: () => Promise.resolve(ascii("<html>")) }));
    await expect(files.contentOk("a/b/c", PDF)).resolves.toBe(false);
  });

  it("si no se pudo leer no se sabe: nulo, nunca `false`", async () => {
    const files = createResourceFiles(storage({ readStart: () => Promise.resolve(null) }));
    await expect(files.contentOk("a/b/c", PDF)).resolves.toBeNull();
  });

  it("de un PDF lee el principio y nada más", async () => {
    const adapter = storage();
    await createResourceFiles(adapter).contentOk("a/b/c", PDF);
    expect(adapter.readEnd).not.toHaveBeenCalled();
  });

  it("de un Word lee también el final; si eso falla, tampoco se sabe", async () => {
    const adapter = storage({ readStart: () => Promise.resolve(ascii("PK\x03\x04")) });
    await expect(createResourceFiles(adapter).contentOk("a/b/c", DOCX)).resolves.toBeNull();
    expect(adapter.readEnd).toHaveBeenCalledWith("a/b/c", 65_557);
  });

  it("un Word de verdad, con su directorio", async () => {
    const adapter = storage({
      readStart: () => Promise.resolve(ascii("PK\x03\x04")),
      readEnd: () => Promise.resolve(ascii("[Content_Types].xml word/document.xml PK\x05\x06")),
    });
    await expect(createResourceFiles(adapter).contentOk("a/b/c", DOCX)).resolves.toBe(true);
  });
});
