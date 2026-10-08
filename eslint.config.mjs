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
// Con sus archivos internos: `pg/lib/client` es el mismo cliente por otra puerta.
const DATABASE_CLIENTS = ["pg", "pg/*", "pg-*", "postgres", "postgres/*", "@supabase/*"];

const noDatabaseClient = {
  group: DATABASE_CLIENTS,
  message:
    "El cliente de base y el SDK de Supabase viven solo en src/adapters/supabase/: usa asUser, asServer o asSystem (TRD §8.10).",
};

// Lo mismo cuando el paquete se carga con import() o con require, que la regla de
// arriba no ve.
const DATABASE_CLIENT_SOURCE =
  "/^((pg|postgres)(\\u002F.+)?|pg-.+|@supabase\\u002F.+)$/";

const noDatabaseClientLoading = [
  {
    selector: `ImportExpression[source.value=${DATABASE_CLIENT_SOURCE}]`,
    message: noDatabaseClient.message,
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=${DATABASE_CLIENT_SOURCE}]`,
    message: noDatabaseClient.message,
  },
  {
    // Un nombre que se arma al correr (una plantilla, una variable) no se puede revisar.
    selector: "ImportExpression[source.type!='Literal']",
    message:
      "Un import() lleva escrito el nombre de lo que carga: así el lint puede ver qué es (TRD §8.10).",
  },
  {
    selector: "CallExpression[callee.object.name='module'][callee.property.name='require']",
    message: noDatabaseClient.message,
  },
  {
    // `sql` es una etiqueta de plantilla. Llamada como función acepta una plantilla
    // imitada, con texto armado, que es justo lo que la etiqueta existe para impedir.
    selector: "CallExpression[callee.name='sql']",
    message:
      "sql se usa como etiqueta (sql`select ...`), nunca como función: así los valores viajan como parámetros (TRD §8.10).",
  },
];

// Fabricarse un `require` propio es otra forma de cargar un paquete sin que se vea.
const noOwnRequire = ["node:module", "module"].map((name) => ({
  name,
  importNames: ["createRequire"],
  message:
    "createRequire carga paquetes a espaldas del lint. Si hace falta, va en el adaptador (TRD §8.10).",
}));

// SDK de proveedores. Solo su adaptador los toca.
const PROVIDER_SDKS = [...DATABASE_CLIENTS, "@mux/mux-node", "stripe", "facturapi", "resend"];

const noProviderSdks = {
  group: PROVIDER_SDKS,
  message:
    "Esta capa no habla con proveedores ni con la base: pídeselo a un servicio (TRD §4.2).",
};

// Ningún texto visible se escribe fuera del catálogo de src/messages/ (RNF-15).
//
// El texto entre etiquetas lo cuida `react/jsx-no-literals`. Lo demás, estas reglas, que
// van al revés de lo intuitivo: no prohíben una lista de atributos «de texto», sino todo
// texto escrito a mano en un atributo, salvo en los que no son para la gente (clases,
// tipos, nombres, direcciones, variantes). Una lista de prohibidos se queda corta con
// cada prop nueva (`error`, `loadingLabel`); una de permitidos falla hacia lo seguro: una
// prop nueva que no es texto se agrega aquí, a la vista de quien revisa.
const NON_TEXT_ATTRIBUTES =
  "/^(" +
  [
    "className|class|id|name|type|href|src|srcSet|rel|target|method|action|encType|htmlFor|form",
    "role|lang|dir|key|ref|slot|is|as|variant|size|tone",
    "autoComplete|autoCapitalize|autoCorrect|inputMode|enterKeyHint|spellCheck|pattern|accept",
    "loading|decoding|fetchPriority|crossOrigin|referrerPolicy|integrity|nonce|sandbox|allow",
    "charSet|httpEquiv|content|media|sizes|scope|headers|wrap|list|step|min|max|capture",
    "xmlns|viewBox|fill|stroke|strokeLinecap|strokeLinejoin|strokeWidth|d|points|transform",
    "preserveAspectRatio|focusable|itemProp|itemType|property",
    "data-.+",
    "aria-(hidden|live|atomic|relevant|busy|current|invalid|required|disabled|expanded|pressed)",
    "aria-(checked|selected|haspopup|controls|describedby|labelledby|owns|activedescendant)",
    "aria-(orientation|sort|autocomplete|modal|multiline|multiselectable|readonly|level)",
    "aria-(posinset|setsize|colcount|rowcount|colindex|rowindex|colspan|rowspan|errormessage)",
    "aria-(details|flowto|keyshortcuts)",
  ].join("|") +
  ")$/";

// Un texto escrito a mano: una cadena (no un número ni un booleano) con alguna letra.
const HANDWRITTEN = "Literal[raw=/^[\"']/][value=/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/]";
const CHOICE = ":matches(ConditionalExpression, LogicalExpression)";
const TEXT_ATTRIBUTE = `JSXAttribute[name.name!=${NON_TEXT_ATTRIBUTES}]`;
const JSX_CHILD = ":matches(JSXElement, JSXFragment) > JSXExpressionContainer";

const noLiteralTextMessage =
  "Los textos visibles salen del catálogo de src/messages/, nunca escritos aquí (RNF-15). Si este atributo no es texto para la gente, agrégalo a NON_TEXT_ATTRIBUTES en eslint.config.mjs.";

const noLiteralText = [
  // En un atributo: directo, entre llaves, como plantilla, o elegido con una condición.
  `${TEXT_ATTRIBUTE} > ${HANDWRITTEN}`,
  `${TEXT_ATTRIBUTE} > JSXExpressionContainer > ${HANDWRITTEN}`,
  `${TEXT_ATTRIBUTE} > JSXExpressionContainer > TemplateLiteral`,
  `${TEXT_ATTRIBUTE} > JSXExpressionContainer > ${CHOICE} > :matches(${HANDWRITTEN}, TemplateLiteral)`,
  // Entre etiquetas: lo que `jsx-no-literals` no ve.
  `${JSX_CHILD} > TemplateLiteral`,
  `${JSX_CHILD} > ${CHOICE} > :matches(${HANDWRITTEN}, TemplateLiteral)`,
].map((selector) => ({ selector, message: noLiteralTextMessage }));

// El título y la descripción de la pestaña también los lee la gente.
const noLiteralMetadata = [
  {
    selector:
      "ExportNamedDeclaration VariableDeclarator[id.name='metadata'] Property[key.name=/^(title|description|default|template|siteName|applicationName)$/] > :matches(Literal[raw=/^[\"']/], TemplateLiteral)",
    message:
      "El título y la descripción de una pantalla salen del catálogo de src/messages/ (RNF-15).",
  },
];

// Todo valor visual es un token de src/ui/theme.css. Un valor entre corchetes de Tailwind
// (`bg-[#fff]`, `w-[317px]`) es un valor suelto. Las variantes entre corchetes
// (`[&_a]:py-3`, `aria-[busy=true]:opacity-60`) y las variables de la hoja
// (`z-(--z-skip)`) no lo son: terminan en dos puntos o van entre paréntesis.
const LOOSE_VALUE = "/(-\\[[^\\]\\s]+\\]|(^|\\s)\\[[^\\]\\s]+\\])(\\s|\\u002F|$)/";
const noLooseVisualValues = [
  `Literal[raw=/^["']/][value=${LOOSE_VALUE}]`,
  `TemplateElement[value.raw=${LOOSE_VALUE}]`,
].map((selector) => ({
  selector,
  message:
    "Todo valor visual es un token de src/ui/theme.css. Un valor entre corchetes es un valor suelto: agrega el token ahí y en el diseño.",
}));

// Un componente que corre en el navegador se lleva todo lo que importa. El catálogo
// entero no debe viajar: cada componente importa solo su bloque. La expresión atrapa la
// carpeta y su índice, vengan por el alias o por una ruta relativa, y deja pasar
// `@/messages/es/ui` y `@/messages/format`.
const noWholeCatalog = {
  regex: "(^|/)messages(/index(\\.ts)?)?$",
  message:
    "Un componente base importa solo su bloque de textos (@/messages/es/ui), no el catálogo entero.",
};

// Las páginas `.dev.tsx` solo existen con `pnpm dev`. Importar una desde código de verdad
// la llevaría a producción, con sus textos de ejemplo.
const noDevFiles = {
  regex: "\\.dev(\\.tsx?)?$",
  message: "Un archivo .dev solo existe en desarrollo: no se importa desde la aplicación.",
};

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
      // El archivo de arranque de Next no vive en ninguna carpeta de capa.
      "boundaries/files": [{ category: "startup", pattern: "**/src/instrumentation.ts" }],
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
      "no-restricted-imports": ["error", { patterns: [noDatabaseClient], paths: noOwnRequire }],
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
          paths: noOwnRequire,
        },
      ],
    },
  },
  {
    files: ["**/src/app/**/*.{ts,tsx}", "**/src/jobs/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [noProviderSdks, noDevFiles], paths: noOwnRequire },
      ],
    },
  },
  {
    files: ["**/src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [noProviderSdks, noWholeCatalog, noDevFiles], paths: noOwnRequire },
      ],
    },
  },
  {
    // Pantallas y componentes, en `.ts` y en `.tsx`. Este bloque reemplaza la regla de
    // sintaxis del bloque general de arriba: por eso repite la prohibición de cargar el
    // cliente de base. La prueba de capas tiene un caso que falla si se pierde.
    files: ["**/src/ui/**/*.{ts,tsx}", "**/src/app/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/src/app/**/page.dev.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noDatabaseClientLoading,
        ...noLooseVisualValues,
        ...noLiteralMetadata,
      ],
    },
  },
  {
    // Las páginas de muestra escriben sus textos de ejemplo a mano, pero siguen sin poder
    // cargar el cliente de base ni usar valores visuales sueltos.
    files: ["**/src/app/**/page.dev.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...noDatabaseClientLoading, ...noLooseVisualValues],
    },
  },
  {
    // Lo que además vale para el JSX. Reemplaza otra vez la regla de sintaxis, así que
    // repite todo lo del bloque anterior.
    files: ["**/src/ui/**/*.tsx", "**/src/app/**/*.tsx"],
    // Las pruebas escriben el texto que esperan. Las páginas de muestra (`page.dev.tsx`)
    // solo existen en desarrollo, para ver los componentes: la excepción es para ellas,
    // no para cualquier archivo que se llame `.dev.tsx`.
    ignores: ["**/*.test.tsx", "**/src/app/**/page.dev.tsx"],
    rules: {
      "react/jsx-no-literals": ["error", { noStrings: true, ignoreProps: true }],
      "no-restricted-syntax": [
        "error",
        ...noDatabaseClientLoading,
        ...noLooseVisualValues,
        ...noLiteralMetadata,
        ...noLiteralText,
      ],
      // Sin estilos en línea: los prohibirá la política de seguridad de contenido (TRD §9),
      // y todo valor visual vive en un token.
      "react/forbid-dom-props": ["error", { forbid: ["style"] }],
    },
  },
]);
