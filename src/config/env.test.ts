import { describe, expect, it } from "vitest";

import { EnvError, parseEnv } from "./env";

// La verificación de T-102: la aplicación se niega a iniciar si falta una variable.

// La dirección de prueba se arma por partes: escrita de corrido, el escaneo de secretos la
// toma por una credencial real.
const fakeDatabaseUrl = (password: string) =>
  ["postgresql://postgres", `${password}@127.0.0.1:54322/postgres`].join(":");

const valid = {
  APP_ENV: "local",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "clave-publicable-de-prueba",
  SUPABASE_SECRET_KEY: "clave-secreta-de-prueba",
  DATABASE_URL: fakeDatabaseUrl("contrasena-de-prueba"),
  DATABASE_URL_DIRECT: fakeDatabaseUrl("contrasena-de-prueba"),
  RATE_LIMIT_HMAC_SECRET: "secreto-de-prueba-para-las-huellas-0123",
};

function problemsOf(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.problems;
    throw error;
  }
  throw new Error("parseEnv aceptó un entorno que debía rechazar");
}

describe("parseEnv", () => {
  it("acepta un entorno completo y devuelve los valores", () => {
    expect(parseEnv(valid)).toEqual(valid);
  });

  it("ignora las variables que no conoce", () => {
    expect(parseEnv({ ...valid, PATH: "/usr/bin" })).toEqual(valid);
  });

  it.each(Object.keys(valid))("rechaza el entorno si falta %s", (name) => {
    expect(problemsOf({ ...valid, [name]: undefined })).toEqual([`${name}: falta`]);
  });

  it("trata una variable vacía como si faltara", () => {
    expect(problemsOf({ ...valid, SUPABASE_SECRET_KEY: "" })).toEqual([
      "SUPABASE_SECRET_KEY: falta",
    ]);
  });

  it("reporta todas las que faltan, no solo la primera", () => {
    expect(problemsOf({})).toEqual(Object.keys(valid).map((name) => `${name}: falta`));
  });

  it("rechaza un APP_ENV que no es local, staging ni production", () => {
    expect(problemsOf({ ...valid, APP_ENV: "desarrollo" })).toEqual([
      "APP_ENV: tiene un valor inválido",
    ]);
  });

  it.each(["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_SUPABASE_URL"])(
    "rechaza %s si no es una dirección http",
    (name) => {
      expect(problemsOf({ ...valid, [name]: "localhost" })).toEqual([
        `${name}: tiene un valor inválido`,
      ]);
      expect(problemsOf({ ...valid, [name]: "ftp://localhost" })).toEqual([
        `${name}: tiene un valor inválido`,
      ]);
    },
  );

  it.each(["DATABASE_URL", "DATABASE_URL_DIRECT"])(
    "rechaza %s si no es una dirección de Postgres",
    (name) => {
      expect(problemsOf({ ...valid, [name]: "http://127.0.0.1:54322" })).toEqual([
        `${name}: tiene un valor inválido`,
      ]);
    },
  );

  // Con este secreto se calculan las huellas del correo y de la dirección para el freno y
  // los topes (TRD §9.9). Uno corto se adivina probando: se rechaza.
  // La llave de firma de Mux (T-108): opcional, en pareja, y con la forma de una llave.
  describe("MUX_SIGNING_KEY_ID y MUX_SIGNING_PRIVATE_KEY", () => {
    // Una llave privada de prueba, armada por partes: escrita de corrido, el escaneo de
    // secretos la tomaría por una real.
    const pem = ["-----BEGIN", "RSA PRIVATE KEY-----\nAAAA\n-----END RSA", "PRIVATE KEY-----"].join(" ");
    const mux = { MUX_SIGNING_KEY_ID: "LlaveDePrueba01", MUX_SIGNING_PRIVATE_KEY: btoa(pem) };

    it("son opcionales: sin ellas no hay video", () => {
      expect(parseEnv(valid)).not.toHaveProperty("MUX_SIGNING_KEY_ID");
    });

    it("se aceptan juntas, en base64 o en PEM", () => {
      expect(parseEnv({ ...valid, ...mux }).MUX_SIGNING_KEY_ID).toBe("LlaveDePrueba01");
      expect(parseEnv({ ...valid, ...mux, MUX_SIGNING_PRIVATE_KEY: pem }).MUX_SIGNING_PRIVATE_KEY).toBe(pem);
    });

    it("una sin la otra no arranca", () => {
      expect(problemsOf({ ...valid, MUX_SIGNING_KEY_ID: mux.MUX_SIGNING_KEY_ID })).toEqual(["MUX_SIGNING_PRIVATE_KEY: falta"]);
      expect(problemsOf({ ...valid, MUX_SIGNING_PRIVATE_KEY: mux.MUX_SIGNING_PRIVATE_KEY })).toEqual(["MUX_SIGNING_KEY_ID: falta"]);
    });

    it.each([
      ["un texto que no es una llave", { ...mux, MUX_SIGNING_PRIVATE_KEY: "no-es-una-llave" }, "MUX_SIGNING_PRIVATE_KEY"],
      ["una llave pública", { ...mux, MUX_SIGNING_PRIVATE_KEY: btoa(pem.replaceAll("RSA PRIVATE", "PUBLIC")) }, "MUX_SIGNING_PRIVATE_KEY"],
      ["un identificador con signos", { ...mux, MUX_SIGNING_KEY_ID: "llave/../otra" }, "MUX_SIGNING_KEY_ID"],
    ])("se rechaza %s, sin decir su valor", (_what, values, name) => {
      expect(problemsOf({ ...valid, ...values })).toEqual([`${name}: tiene un valor inválido`]);
    });
  });

  describe("RATE_LIMIT_HMAC_SECRET", () => {
    it("pide 32 caracteres o más", () => {
      expect(problemsOf({ ...valid, RATE_LIMIT_HMAC_SECRET: "x".repeat(31) })).toEqual([
        "RATE_LIMIT_HMAC_SECRET: tiene un valor inválido",
      ]);
      expect(parseEnv({ ...valid, RATE_LIMIT_HMAC_SECRET: "x".repeat(32) }).RATE_LIMIT_HMAC_SECRET).toHaveLength(32);
    });

    it.each(["local", "staging", "production"])("es obligatoria también en %s", (appEnv) => {
      const fakeDsn = ["https://0123456789abcdef", "o1.ingest.sentry.example/1"].join("@");
      expect(problemsOf({ ...valid, APP_ENV: appEnv, SENTRY_DSN: fakeDsn, RATE_LIMIT_HMAC_SECRET: undefined })).toEqual([
        "RATE_LIMIT_HMAC_SECRET: falta",
      ]);
    });
  });

  // El registro de errores (RNF-16). En local no se manda nada si no se pide; en los
  // entornos que atienden a personas, arrancar sin él sería quedarse a ciegas.
  describe("SENTRY_DSN", () => {
    // Por partes, por la misma razón que la dirección de la base.
    const fakeDsn = ["https://0123456789abcdef", "o1.ingest.sentry.example/1"].join("@");

    it("es opcional en local", () => {
      expect(parseEnv(valid)).not.toHaveProperty("SENTRY_DSN");
      expect(parseEnv({ ...valid, SENTRY_DSN: fakeDsn }).SENTRY_DSN).toBe(fakeDsn);
    });

    it.each(["staging", "production"])("es obligatoria en %s", (appEnv) => {
      expect(problemsOf({ ...valid, APP_ENV: appEnv })).toEqual(["SENTRY_DSN: falta"]);
      expect(parseEnv({ ...valid, APP_ENV: appEnv, SENTRY_DSN: fakeDsn }).SENTRY_DSN).toBe(
        fakeDsn,
      );
    });

    it("se rechaza si no es una dirección http", () => {
      expect(problemsOf({ ...valid, SENTRY_DSN: "clave-suelta" })).toEqual([
        "SENTRY_DSN: tiene un valor inválido",
      ]);
    });

    // El SDK no falla con una dirección mal formada: avisa en la consola y se queda sin
    // mandar nada. La aplicación arrancaría «con» registro de errores y sin él. Aquí se
    // exige la forma que el SDK acepta: llave, servidor y número de proyecto.
    it.each([
      ["sin llave", "https://o1.ingest.sentry.example/1"],
      ["sin proyecto", ["https://0123456789abcdef", "o1.ingest.sentry.example"].join("@")],
      ["con una llave que no es de letras y números", ["https://0123-4567", "o1.ingest.sentry.example/1"].join("@")],
      ["que es cualquier otra dirección", "https://example.com"],
    ])("se rechaza una dirección %s, que el SDK descartaría en silencio", (_name, dsn) => {
      expect(problemsOf({ ...valid, APP_ENV: "staging", SENTRY_DSN: dsn })).toEqual([
        "SENTRY_DSN: tiene un valor inválido",
      ]);
    });

    it.each(["staging", "production"])("en %s tiene que ir cifrada", (appEnv) => {
      const plain = ["http://0123456789abcdef", "o1.ingest.sentry.example/1"].join("@");

      expect(problemsOf({ ...valid, APP_ENV: appEnv, SENTRY_DSN: plain })).toEqual([
        "SENTRY_DSN: tiene un valor inválido",
      ]);
      // En local sí: sirve para probar contra un receptor en la propia máquina.
      expect(parseEnv({ ...valid, SENTRY_DSN: plain }).SENTRY_DSN).toBe(plain);
    });

    it("falta junto con las demás, en su lugar de la lista", () => {
      expect(problemsOf({ APP_ENV: "staging" })).toEqual([
        ...Object.keys(valid)
          .filter((name) => name !== "APP_ENV")
          .map((name) => `${name}: falta`),
        "SENTRY_DSN: falta",
      ]);
    });
  });

  // Cada rama tiene su propia vista previa, con su propia dirección. Una variable fija no
  // sirve: habría que ponerla a mano en Vercel rama por rama, y la vista previa de una
  // rama nueva no podría arrancar. En una vista previa la dirección se deduce de la que
  // Vercel le da a la rama.
  describe("NEXT_PUBLIC_SITE_URL en una vista previa", () => {
    const withoutSiteUrl = { ...valid, NEXT_PUBLIC_SITE_URL: undefined };
    const branchHost = "plataforma-git-una-rama-equipo.vercel.app";
    const preview = { ...withoutSiteUrl, VERCEL_ENV: "preview", VERCEL_BRANCH_URL: branchHost };

    it("se deduce de la dirección que Vercel le da a la rama", () => {
      expect(parseEnv(preview).NEXT_PUBLIC_SITE_URL).toBe(`https://${branchHost}`);
    });

    it("si está puesta a mano, manda la que está puesta", () => {
      const explicit = "https://pruebas.plataforma.example";

      expect(parseEnv({ ...preview, NEXT_PUBLIC_SITE_URL: explicit }).NEXT_PUBLIC_SITE_URL).toBe(
        explicit,
      );
    });

    // Producción tiene una sola dirección, la del dominio, y se escribe: una deducida
    // cambiaría con cada despliegue, y de ella salen los enlaces de los correos.
    it.each(["production", "development", undefined])(
      "fuera de una vista previa no se deduce (VERCEL_ENV: %s)",
      (vercelEnv) => {
        expect(problemsOf({ ...preview, VERCEL_ENV: vercelEnv })).toEqual([
          "NEXT_PUBLIC_SITE_URL: falta",
        ]);
      },
    );

    it("sin la dirección de la rama, falta", () => {
      expect(problemsOf({ ...preview, VERCEL_BRANCH_URL: undefined })).toEqual([
        "NEXT_PUBLIC_SITE_URL: falta",
      ]);
    });

    it.each([
      ["con protocolo", "https://plataforma-git-una-rama.vercel.app"],
      ["con ruta", "plataforma-git-una-rama.vercel.app/entrar"],
      ["con usuario", "alguien@plataforma-git-una-rama.vercel.app"],
      ["con espacios", "plataforma git.vercel.app"],
    ])("no se deduce de algo que no es el nombre de un servidor (%s)", (_name, host) => {
      expect(problemsOf({ ...preview, VERCEL_BRANCH_URL: host })).toEqual([
        "NEXT_PUBLIC_SITE_URL: falta",
      ]);
    });
  });

  // El SDK de Sentry lee esta variable por su cuenta, sin pasar por aquí, y con ella
  // prende las trazas: otra recolección, que no pasa por el filtro de los errores. Las
  // trazas se deciden en el código y con su revisión, no desde el panel de Vercel.
  describe("SENTRY_TRACES_SAMPLE_RATE", () => {
    it.each(["1", "0.1", "0"])("no se admite, valga lo que valga (%s)", (value) => {
      expect(problemsOf({ ...valid, SENTRY_TRACES_SAMPLE_RATE: value })).toEqual([
        "SENTRY_TRACES_SAMPLE_RATE: no se admite",
      ]);
    });

    it("vacía cuenta como ausente", () => {
      expect(parseEnv({ ...valid, SENTRY_TRACES_SAMPLE_RATE: "" })).toEqual(valid);
    });

    it("se reporta junto con las que faltan", () => {
      expect(
        problemsOf({ ...valid, DATABASE_URL: undefined, SENTRY_TRACES_SAMPLE_RATE: "1" }),
      ).toEqual(["DATABASE_URL: falta", "SENTRY_TRACES_SAMPLE_RATE: no se admite"]);
    });
  });

  it("nunca escribe el valor de una variable en el error", () => {
    const secret = `${fakeDatabaseUrl("no-debe-aparecer")} y z`;
    try {
      parseEnv({ ...valid, APP_ENV: "no-debe-aparecer", DATABASE_URL: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect(String((error as Error).message)).not.toContain("no-debe-aparecer");
      return;
    }
    throw new Error("parseEnv aceptó un entorno que debía rechazar");
  });
});
