import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

// Las capas del TRD §4.2. Quién puede importar a quién se decide aquí y en ningún otro
// lado. `tests/architecture/layers.test.ts` comprueba cada regla: si se afloja una, esa
// prueba falla.

// SDK de proveedores y clientes de base. Solo los adaptadores y los servicios los tocan.
const PROVIDER_SDKS = [
  "@supabase/*",
  "@mux/mux-node",
  "stripe",
  "facturapi",
  "resend",
  "pg",
  "postgres",
];

const noProviderSdks = {
  group: PROVIDER_SDKS,
  message:
    "Esta capa no habla con proveedores ni con la base: pídeselo a un servicio (TRD §4.2).",
};

// En el dominio solo se importa código del propio dominio.
const DOMAIN_ONLY_LOCAL = "^(?!\\.{1,2}/|@/)";
const DOMAIN_TEST_ONLY_LOCAL = "^(?!\\.{1,2}/|@/|vitest$|fast-check$)";

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
        { type: "app", pattern: "src/app" },
        { type: "job", pattern: "src/jobs" },
        { type: "payload", pattern: "src/payload" },
        { type: "messages", pattern: "src/messages" },
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
              allow: { to: { element: { type: "domain" } } },
            },
            {
              from: { element: { type: "service" } },
              allow: { to: { element: { type: ["domain", "adapter"] } } },
            },
            // Lectura estricta de la tabla: la entrada y los trabajos solo ven servicios.
            // Si una pantalla necesita un tipo del dominio, el servicio lo reexporta.
            {
              from: { element: { type: "app" } },
              allow: { to: { element: { type: ["service", "messages"] } } },
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
]);
