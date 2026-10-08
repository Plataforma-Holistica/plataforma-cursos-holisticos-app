import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

// Las capas del TRD §4.2. Quién puede importar a quién se decide aquí y en ningún otro
// lado. `tests/architecture/layers.test.ts` comprueba cada regla: si se afloja una, esa
// prueba falla.

// El cliente de base y el SDK de Supabase no salen de src/adapters/supabase/ (ADR-31, TRD
// §8.10): el servidor entra a la base con un rol que salta la seguridad por fila, y solo
// ese adaptador sabe bajar al rol de la persona.
const DATABASE_CLIENTS = ["pg", "pg-*", "postgres", "@supabase/*"];

const noDatabaseClient = {
  group: DATABASE_CLIENTS,
  message:
    "El cliente de base y el SDK de Supabase viven solo en src/adapters/supabase/: usa asUser, asServer o asSystem (TRD §8.10).",
};

// Lo mismo cuando el paquete se carga con import() o con require, que la regla de
// arriba no ve.
const DATABASE_CLIENT_SOURCE = "/^(pg|pg-.+|postgres|@supabase\\u002F.+)$/";

const noDatabaseClientLoading = [
  {
    selector: `ImportExpression[source.value=${DATABASE_CLIENT_SOURCE}]`,
    message: noDatabaseClient.message,
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=${DATABASE_CLIENT_SOURCE}]`,
    message: noDatabaseClient.message,
  },
];

// SDK de proveedores. Solo su adaptador los toca.
const PROVIDER_SDKS = [
  ...DATABASE_CLIENTS,
  "@mux/mux-node",
  "stripe",
  "facturapi",
  "resend",
  "@sentry/*",
];

const noProviderSdks = {
  group: PROVIDER_SDKS,
  message:
    "Esta capa no habla con proveedores ni con la base: pídeselo a un servicio (TRD §4.2).",
};

// Ningún texto visible se escribe fuera del catálogo de src/messages/ (RNF-15). El texto
// entre etiquetas lo cuida `react/jsx-no-literals`; esto cuida los atributos que también
// se leen o se ven, sin estorbar a `className`, `type` o `role`.
const TEXT_ATTRIBUTES =
  "/^(aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext|title|placeholder|alt|label|legend|hint|description)$/";

const noLiteralTextMessage =
  "Los textos visibles salen del catálogo de src/messages/, nunca escritos aquí (RNF-15).";

const noLiteralTextAttributes = [
  {
    selector: `JSXAttribute[name.name=${TEXT_ATTRIBUTES}] > Literal`,
    message: noLiteralTextMessage,
  },
  {
    selector: `JSXAttribute[name.name=${TEXT_ATTRIBUTES}] > JSXExpressionContainer > :matches(Literal, TemplateLiteral)`,
    message: noLiteralTextMessage,
  },
];

// Un componente que corre en el navegador se lleva todo lo que importa. El catálogo
// entero no debe viajar: cada componente importa solo su bloque.
// Por nombre exacto y no por patrón: un patrón `@/messages` también atraparía
// `@/messages/es/ui`, que es justo lo que sí se importa.
const noWholeCatalog = ["@/messages", "@/messages/index"].map((name) => ({
  name,
  message:
    "Un componente base importa solo su bloque de textos (@/messages/es/ui), no el catálogo entero.",
}));

// En el dominio solo se importa código del propio dominio.
const DOMAIN_ONLY_LOCAL = "^(?!\\.{1,2}/|@/)";
const DOMAIN_TEST_ONLY_LOCAL = "^(?!\\.{1,2}/|@/|vitest$|fast-check$)";

// Las variables de entorno se leen en src/config/ y en ningún otro lado (TRD §11.4).
const noProcessEnv = {
  object: "process",
  property: "env",
  message: "Las variables de entorno se leen en src/config/env.ts: usa getEnv() (TRD §11.4).",
};

const domainImports = (regex) => [
  "error",
  {
    patterns: [
      {
        regex,
        message:
          "El dominio no importa paquetes ni módulos de Node: solo código de src/domain/ (principio P1).",
      },
    ],
  },
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "dist/**",
    "coverage/**",
    "next-env.d.ts",
    // Archivos de muestra que violan las capas a propósito. Los revisa la prueba de capas.
    "tests/architecture/fixtures/**",
  ]),
  {
    files: ["**/src/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "domain", pattern: "src/domain" },
        { type: "adapter", pattern: "src/adapters/*", capture: ["provider"] },
        { type: "service", pattern: "src/services" },
        // Componentes base, compartidos por las cuatro superficies. No conocen datos.
        { type: "ui", pattern: "src/ui" },
        { type: "app", pattern: "src/app" },
        { type: "job", pattern: "src/jobs" },
        { type: "payload", pattern: "src/payload" },
        { type: "messages", pattern: "src/messages" },
        { type: "config", pattern: "src/config" },
      ],
      // Los archivos de arranque de Next no viven en ninguna carpeta de capa: el del
      // servidor y el del navegador.
      "boundaries/files": [
        { category: "startup", pattern: "**/src/instrumentation.ts" },
        { category: "startup", pattern: "**/src/instrumentation-client.ts" },
      ],
      "boundaries/legacy-templates": false,
      "import/resolver": {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      // Un archivo de src/ que no cae en ninguna capa es un error: la carpeta nueva se
      // declara arriba, con su regla, antes de usarse.
      "boundaries/no-unknown-files": "error",
      "boundaries/no-unknown-dependencies": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message:
            "Capa prohibida: «{{from.element.types}}» no puede importar de «{{to.element.types}}» (TRD §4.2).",
          policies: [
            // Dentro de una misma capa (y de un mismo adaptador) se importa con libertad.
            { allow: { dependency: { relationship: { to: "internal" } } } },
            // Un adaptador conoce los tipos del dominio, y a ningún otro adaptador.
            {
              from: { element: { type: "adapter" } },
              allow: { to: { element: { type: ["domain", "config"] } } },
            },
            {
              from: { element: { type: "service" } },
              allow: { to: { element: { type: ["domain", "adapter", "config"] } } },
            },
            // El arranque valida la configuración antes de atender una sola petición.
            {
              from: { file: { categories: "startup" } },
              allow: { to: { element: { type: ["config", "service"] } } },
            },
            // Lectura estricta de la tabla: la entrada y los trabajos solo ven servicios.
            // Si una pantalla necesita un tipo del dominio, el servicio lo reexporta.
            {
              from: { element: { type: "app" } },
              allow: { to: { element: { type: ["service", "messages", "ui"] } } },
            },
            // Un componente base solo conoce los textos. Los datos se los pasa la pantalla.
            {
              from: { element: { type: "ui" } },
              allow: { to: { element: { type: "messages" } } },
            },
            {
              from: { element: { type: "job" } },
              allow: { to: { element: { type: "service" } } },
            },
            {
              from: { element: { type: "payload" } },
              allow: { to: { element: { type: "service" } } },
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/src/**/*.{ts,tsx}"],
    ignores: ["**/src/config/**"],
    rules: {
      "no-restricted-properties": ["error", noProcessEnv],
    },
  },
  {
    // Va antes que los bloques de cada capa: en esta configuración el bloque posterior
    // reemplaza la regla, no la suma, así que cada uno de ellos repite estos patrones.
    files: ["**/src/**/*.{ts,tsx}"],
    ignores: ["**/src/adapters/supabase/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noDatabaseClient] }],
      "no-restricted-syntax": ["error", ...noDatabaseClientLoading],
    },
  },
  {
    // Dominio puro (P1): sin paquetes, sin red, sin reloj y sin variables de entorno.
    files: ["**/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": domainImports(DOMAIN_ONLY_LOCAL),
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "El dominio no usa la red (P1)." },
        { name: "process", message: "El dominio no lee variables de entorno (P1)." },
      ],
      "no-restricted-properties": [
        "error",
        noProcessEnv,
        {
          object: "Date",
          property: "now",
          message: "El reloj entra al dominio como argumento (P1).",
        },
        {
          object: "Math",
          property: "random",
          message: "El dominio es determinista: el azar entra como argumento (P1).",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "El reloj entra al dominio como argumento (P1).",
        },
        ...noDatabaseClientLoading,
      ],
    },
  },
  {
    files: ["**/src/domain/**/*.test.ts"],
    rules: {
      "no-restricted-imports": domainImports(DOMAIN_TEST_ONLY_LOCAL),
    },
  },
  {
    files: ["**/src/services/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react/*", "react-dom", "react-dom/*"],
              message: "Los servicios no conocen React: eso es de la capa de entrada (TRD §4.2).",
            },
            noDatabaseClient,
          ],
        },
      ],
    },
  },
  {
    files: ["**/src/app/**/*.{ts,tsx}", "**/src/jobs/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noProviderSdks] }],
    },
  },
  {
    files: ["**/src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noProviderSdks], paths: noWholeCatalog }],
    },
  },
  {
    // Pantallas y componentes. Este bloque reemplaza la regla de sintaxis del bloque
    // general de arriba: por eso repite la prohibición de cargar el cliente de base. La
    // prueba de capas tiene un caso que falla si se pierde.
    files: ["**/src/ui/**/*.tsx", "**/src/app/**/*.tsx"],
    // Las pruebas escriben el texto que esperan. Las páginas `.dev.tsx` solo existen en
    // desarrollo, para ver los componentes.
    ignores: ["**/*.test.tsx", "**/*.dev.tsx"],
    rules: {
      "react/jsx-no-literals": ["error", { noStrings: true, ignoreProps: true }],
      "no-restricted-syntax": ["error", ...noDatabaseClientLoading, ...noLiteralTextAttributes],
      // Sin estilos en línea: los prohibirá la política de seguridad de contenido (TRD §9),
      // y todo valor visual vive en un token.
      "react/forbid-dom-props": ["error", { forbid: ["style"] }],
    },
  },
]);
