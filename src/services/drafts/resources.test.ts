import { describe, expect, it, vi } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";
import type { ResourceFiles } from "@/services/media/resource-files";

import { createDraftResources, type ResourcesStore } from "./resources";

vi.mock("server-only", () => ({}));

// El servicio de los recursos con su almacén y sus archivos simulados: qué llega a cada uno, en qué orden, y
// qué se contesta. Contra la base y el Storage de verdad, en tests/integration/90-recursos.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;
const reader = {} as CookieReader;
const COURSE = "c0000000-0000-4000-8000-000000000001";
const LESSON = "e0000000-0000-4000-8000-000000000001";
const RESOURCE = "f0000000-0000-4000-8000-000000000001";
const PATH = `t/${COURSE}/${RESOURCE}`;
const PDF = "application/pdf";
const input = { course: COURSE, lesson: LESSON, title: "Guía", fileName: "guia.pdf", size: 1000 };

function setup(session: SessionCheck = { kind: "pass", claims }) {
  const reported: FailureCode[] = [];
  const store: ResourcesStore = {
    begin: vi.fn(() => Promise.resolve({ answer: "started" as const, resource: RESOURCE, path: PATH })),
    file: vi.fn(() => Promise.resolve({ answer: "found" as const, path: PATH, mime: PDF })),
    confirm: vi.fn(() => Promise.resolve({ answer: "ready" as const, reason: null })),
    move: vi.fn(() => Promise.resolve("moved" as const)),
    remove: vi.fn(() => Promise.resolve("deleted" as const)),
    unused: vi.fn(() => Promise.resolve(["t/c/sobra"])),
  };
  const files: ResourceFiles = {
    signUpload: vi.fn(() => Promise.resolve("https://storage/subir")),
    contentOk: vi.fn(() => Promise.resolve(true)),
    remove: vi.fn(() => Promise.resolve()),
  };
  const checkSession = vi.fn<(reader: CookieReader) => Promise<SessionCheck>>(() => Promise.resolve(session));
  const service = createDraftResources({ store, files, checkSession, report: (code) => (reported.push(code), Promise.resolve()) });
  return { ...service, store, files, checkSession, reported };
}

describe("empezar una subida", () => {
  it("el tipo sale del nombre del archivo; la base reserva y se firma la ruta que ella contestó", async () => {
    const service = setup();
    expect(await service.beginResource(reader, input)).toEqual({ kind: "started", resource: RESOURCE, url: "https://storage/subir", mime: PDF });
    expect(service.store.begin).toHaveBeenCalledExactlyOnceWith(claims, { course: COURSE, lesson: LESSON, title: "Guía", kind: "pdf", mime: PDF, size: 1000 });
    expect(service.files.signUpload).toHaveBeenCalledExactlyOnceWith(PATH);
  });

  it("el título va revisado, y sin lección es del curso", async () => {
    const service = setup();
    await service.beginResource(reader, { ...input, lesson: null, title: "  Guía  " });
    expect(service.store.begin).toHaveBeenCalledExactlyOnceWith(claims, expect.objectContaining({ lesson: null, title: "Guía" }));
  });

  it.each([
    ["un curso sin forma", { course: "x" }],
    ["una lección sin forma", { lesson: "x" }],
    ["un título vacío", { title: "  " }],
    ["un título largo", { title: "a".repeat(121) }],
    ["un archivo que no se admite", { fileName: "programa.exe" }],
    ["un tamaño cero", { size: 0 }],
    ["un tamaño no entero", { size: 1.5 }],
  ])("con %s contesta invalid sin preguntarle a nadie", async (_name, change) => {
    const service = setup();
    expect(await service.beginResource(reader, { ...input, ...change })).toEqual({ kind: "invalid" });
    expect(service.checkSession).not.toHaveBeenCalled();
    expect(service.store.begin).not.toHaveBeenCalled();
  });

  it.each(["too_large", "too_many", "throttled", "unavailable", "not_found", "not_editable", "suspended", "not_teacher"] as const)(
    "si la base contesta %s, no se firma nada",
    async (answer) => {
      const service = setup();
      vi.mocked(service.store.begin).mockResolvedValue({ answer, resource: null, path: null });
      expect(await service.beginResource(reader, input)).toEqual({ kind: answer });
      expect(service.files.signUpload).not.toHaveBeenCalled();
    },
  );

  it("si no se pudo firmar, se cancela la fila: no ocupa lugar por 3 horas", async () => {
    const service = setup();
    vi.mocked(service.files.signUpload).mockResolvedValue(null);
    expect(await service.beginResource(reader, input)).toEqual({ kind: "unknown" });
    expect(service.store.remove).toHaveBeenCalledExactlyOnceWith(claims, { course: COURSE, resource: RESOURCE, seen: 1 });
    expect(service.reported).toEqual(["resource_upload_unavailable"]);
  });

  it("sin sesión que pase, no se le pregunta a nadie", async () => {
    const check = { kind: "no_session" } as unknown as SessionCheck;
    const service = setup(check);
    expect(await service.beginResource(reader, input)).toEqual({ kind: "session", check });
    expect(service.store.begin).not.toHaveBeenCalled();
  });

  it("si la base falla, no se supo", async () => {
    const service = setup();
    vi.mocked(service.store.begin).mockRejectedValue(new Error("x"));
    expect(await service.beginResource(reader, input)).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(["draft_change_unavailable"]);
  });
});

describe("confirmar una subida", () => {
  const confirm = { course: COURSE, resource: RESOURCE };

  it("la ruta y el tipo salen de la base; se lee el contenido y la base decide", async () => {
    const service = setup();
    expect(await service.confirmResource(reader, confirm)).toEqual({ kind: "ready" });
    expect(service.store.file).toHaveBeenCalledExactlyOnceWith(claims, confirm);
    expect(service.files.contentOk).toHaveBeenCalledExactlyOnceWith(PATH, PDF);
    expect(service.store.confirm).toHaveBeenCalledExactlyOnceWith(claims, { ...confirm, contentOk: true });
    expect(service.files.remove).not.toHaveBeenCalled();
  });

  it("si no se pudo leer, la base recibe nulo: no se supo, y la fila se queda", async () => {
    const service = setup();
    vi.mocked(service.files.contentOk).mockResolvedValue(null);
    vi.mocked(service.store.confirm).mockResolvedValue({ answer: "unavailable", reason: null });
    expect(await service.confirmResource(reader, confirm)).toEqual({ kind: "unavailable" });
    expect(service.store.confirm).toHaveBeenCalledExactlyOnceWith(claims, { ...confirm, contentOk: null });
    expect(service.files.remove).not.toHaveBeenCalled();
  });

  it.each(["type", "size", "content"] as const)("rechazado por %s: lo dice, y el objeto que sobra se borra", async (reason) => {
    const service = setup();
    vi.mocked(service.store.confirm).mockResolvedValue({ answer: "rejected", reason });
    expect(await service.confirmResource(reader, confirm)).toEqual({ kind: "rejected", reason });
    expect(service.store.unused).toHaveBeenCalledExactlyOnceWith(claims, COURSE);
    expect(service.files.remove).toHaveBeenCalledExactlyOnceWith(["t/c/sobra"]);
  });

  it("vencido: el objeto que sobra también se borra", async () => {
    const service = setup();
    vi.mocked(service.store.confirm).mockResolvedValue({ answer: "expired", reason: null });
    expect(await service.confirmResource(reader, confirm)).toEqual({ kind: "expired" });
    expect(service.files.remove).toHaveBeenCalledOnce();
  });

  it.each(["not_found", "not_editable", "suspended", "not_teacher"] as const)("si la base no da la ruta (%s), no se lee nada", async (answer) => {
    const service = setup();
    vi.mocked(service.store.file).mockResolvedValue({ answer, path: null, mime: null });
    expect(await service.confirmResource(reader, confirm)).toEqual({ kind: answer });
    expect(service.files.contentOk).not.toHaveBeenCalled();
    expect(service.store.confirm).not.toHaveBeenCalled();
  });

  it("lo que no tiene forma no llega a nadie", async () => {
    const service = setup();
    expect(await service.confirmResource(reader, { course: COURSE, resource: "x" })).toEqual({ kind: "invalid" });
    expect(service.store.file).not.toHaveBeenCalled();
  });
});

describe("quitar y mover", () => {
  it("quitar lleva lo que se vio y borra el objeto que sobra", async () => {
    const service = setup();
    expect(await service.removeResource(reader, { course: COURSE, resource: RESOURCE, seen: 2 })).toEqual({ kind: "deleted" });
    expect(service.store.remove).toHaveBeenCalledExactlyOnceWith(claims, { course: COURSE, resource: RESOURCE, seen: 2 });
    expect(service.files.remove).toHaveBeenCalledExactlyOnceWith(["t/c/sobra"]);
  });

  it("si la base no quitó nada, no se borra ningún objeto", async () => {
    const service = setup();
    vi.mocked(service.store.remove).mockResolvedValue("changed");
    expect(await service.removeResource(reader, { course: COURSE, resource: RESOURCE, seen: 2 })).toEqual({ kind: "changed" });
    expect(service.store.unused).not.toHaveBeenCalled();
  });

  it("una falla al limpiar no tumba lo que ya se hizo: se reporta, y el repaso lo alcanza", async () => {
    const service = setup();
    vi.mocked(service.files.remove).mockRejectedValue(new Error("x"));
    expect(await service.removeResource(reader, { course: COURSE, resource: RESOURCE, seen: 2 })).toEqual({ kind: "deleted" });
    expect(service.reported).toEqual(["resource_cleanup_failed"]);
  });

  it("sin nada que sobre, no se llama a Storage", async () => {
    const service = setup();
    vi.mocked(service.store.unused).mockResolvedValue([]);
    await service.cleanUp(claims, COURSE);
    expect(service.files.remove).not.toHaveBeenCalled();
  });

  it("mover lleva la posición que se vio", async () => {
    const service = setup();
    expect(await service.moveResource(reader, { course: COURSE, resource: RESOURCE, seenPosition: 2, toPosition: 1 })).toEqual({ kind: "moved" });
    expect(service.store.move).toHaveBeenCalledExactlyOnceWith(claims, { course: COURSE, resource: RESOURCE, seenPosition: 2, toPosition: 1 });
  });

  it("una posición sin forma contesta invalid", async () => {
    const service = setup();
    expect(await service.moveResource(reader, { course: COURSE, resource: RESOURCE, seenPosition: 0, toPosition: 1 })).toEqual({ kind: "invalid" });
    expect(service.store.move).not.toHaveBeenCalled();
  });
});
