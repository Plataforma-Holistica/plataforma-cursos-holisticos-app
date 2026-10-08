import { X509Certificate } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SUPABASE_ROOT_CA } from "./root-ca";

describe("certificado raíz de Supabase", () => {
  const certificate = new X509Certificate(SUPABASE_ROOT_CA);

  it("es el que Supabase publica: su huella no cambió", () => {
    expect(certificate.fingerprint256).toBe(
      "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
    );
    expect(certificate.subject).toContain("CN=Supabase Root 2021 CA");
    expect(certificate.ca).toBe(true);
  });

  it("avisa con un año de margen antes de vencer", () => {
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    expect(new Date(certificate.validTo).getTime() - Date.now()).toBeGreaterThan(yearMs);
  });
});
