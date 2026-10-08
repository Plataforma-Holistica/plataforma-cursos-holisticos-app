import { describe, expect, it } from "vitest";

import { isVerifiedClaims, parseClaims } from "./claims";

const issuer = "http://127.0.0.1:54321/auth/v1";

const valid = {
  sub: "a0000000-0000-4000-8000-000000000001",
  role: "authenticated",
  aal: "aal1",
  iss: issuer,
  aud: "authenticated",
  exp: 4_102_444_800,
  session_id: "b0000000-0000-4000-8000-000000000002",
  email: "ana@prueba.test",
};

describe("validación propia de las claims", () => {
  it("acepta las de una persona con sesión", () => {
    expect(parseClaims(valid, { issuer })).toMatchObject({
      sub: valid.sub,
      role: "authenticated",
      aal: "aal1",
    });
  });

  it("acepta la audiencia como lista y el segundo factor", () => {
    expect(parseClaims({ ...valid, aud: ["authenticated"], aal: "aal2" }, { issuer })).not.toBeNull();
  });

  it("el emisor se compara sin importar la diagonal final", () => {
    expect(parseClaims(valid, { issuer: `${issuer}/` })).not.toBeNull();
  });

  // `getClaims()` solo mira la firma y la vigencia. Todo esto lo tiene que rechazar el
  // adaptador, o un token bien firmado para otra cosa pasaría por una persona.
  it.each([
    ["otro rol", { role: "service_role" }],
    ["el rol del visitante", { role: "anon" }],
    ["otro emisor", { iss: "https://otro-proyecto.supabase.co/auth/v1" }],
    ["otra audiencia", { aud: "otra" }],
    ["una audiencia vacía", { aud: [] }],
    ["una sesión anónima", { is_anonymous: true }],
    ["un sujeto que no es un identificador", { sub: "ana" }],
    ["sin sujeto", { sub: undefined }],
    ["un nivel de autenticación desconocido", { aal: "aal3" }],
    ["sin nivel de autenticación", { aal: undefined }],
  ])("rechaza %s", (_name, change) => {
    expect(parseClaims({ ...valid, ...change }, { issuer })).toBeNull();
  });

  it.each([null, undefined, "texto", 7, []])("rechaza lo que no es un objeto: %j", (payload) => {
    expect(parseClaims(payload, { issuer })).toBeNull();
  });

  it("parsear no es verificar: el resultado no sirve para asUser", () => {
    const parsed = parseClaims(valid, { issuer });
    expect(isVerifiedClaims(parsed)).toBe(false);
    expect(isVerifiedClaims({ userId: valid.sub, aal: "aal2", sessionId: null })).toBe(false);
  });
});
