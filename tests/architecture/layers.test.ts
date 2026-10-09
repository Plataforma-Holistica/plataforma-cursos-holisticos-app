import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// La prueba de la tarea T-101: la integración continua falla si una capa importa lo que
// no debe (TRD §4.2). Cada caso corre el lint real sobre un archivo de muestra. Los
// archivos de `fixtures/src/` solo existen para que los `import` resuelvan.

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = "tests/architecture/fixtures/src";

const LAYERS = "boundaries/dependencies";
const IMPORTS = "no-restricted-imports";
const SYNTAX = "no-restricted-syntax";

let eslint: ESLint;

beforeAll(() => {
  // `ignore: false` porque el lint normal se salta la carpeta de muestras.
  eslint = new ESLint({ cwd: root, ignore: false });
});

async function rulesBroken(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}/${file}` });
  const messages = result?.messages ?? [];
  const fatal = messages.find((message) => message.fatal);
  if (fatal) throw new Error(`El lint no pudo leer ${file}: ${fatal.message}`);
  return messages
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? "");
}

interface Case {
  name: string;
  file: string;
  code: string;
  rule: string;
}

const forbidden: Case[] = [
  {
    name: "el dominio importa un servicio",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `import { thing } from "../../services/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "el dominio importa un adaptador",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `import { thing } from "../../adapters/mux/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "el dominio importa un paquete",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `import { z } from "zod";\nexport const probe = z;\n`,
    rule: IMPORTS,
  },
  {
    name: "el dominio importa un módulo de Node",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `import { readFileSync } from "node:fs";\nexport const probe = readFileSync;\n`,
    rule: IMPORTS,
  },
  {
    name: "el dominio lee el reloj con Date.now()",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `export const probe = () => Date.now();\n`,
    rule: "no-restricted-properties",
  },
  {
    name: "el dominio lee el reloj con new Date()",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `export const probe = () => new Date();\n`,
    rule: "no-restricted-syntax",
  },
  {
    name: "el dominio lee una variable de entorno",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `export const probe = () => process.env.APP_ENV;\n`,
    rule: "no-restricted-globals",
  },
  {
    name: "el dominio usa la red",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `export const probe = () => fetch("https://example.com");\n`,
    rule: "no-restricted-globals",
  },
  {
    name: "el dominio usa el azar",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `export const probe = () => Math.random();\n`,
    rule: "no-restricted-properties",
  },
  {
    name: "un adaptador importa a otro adaptador",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `import { thing } from "../mux/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un adaptador importa un servicio",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `import { thing } from "../../services/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un adaptador importa una pantalla",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `import { thing } from "../../app/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un servicio importa React",
    file: `${fixtures}/services/probe.ts`,
    code: `import { useState } from "react";\nexport const probe = useState;\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio importa una pantalla",
    file: `${fixtures}/services/probe.ts`,
    code: `import { thing } from "../app/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "una página importa un adaptador",
    file: `${fixtures}/app/probe.ts`,
    code: `import { thing } from "../adapters/mux/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "una página importa el dominio de reparto",
    file: `${fixtures}/app/probe.ts`,
    code: `import { thing } from "../domain/payout/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "una página importa solo un tipo del dominio",
    file: `${fixtures}/app/probe.ts`,
    code: `import type { thing } from "../domain/shared/thing";\nexport type Probe = typeof thing;\n`,
    rule: LAYERS,
  },
  {
    name: "una página importa el cliente de base",
    file: `${fixtures}/app/probe.ts`,
    code: `import { createClient } from "@supabase/supabase-js";\nexport const probe = createClient;\n`,
    rule: IMPORTS,
  },
  {
    name: "una página importa el SDK de cobro",
    file: `${fixtures}/app/probe.ts`,
    code: `import Stripe from "stripe";\nexport const probe = Stripe;\n`,
    rule: IMPORTS,
  },
  {
    name: "un trabajo importa el dominio",
    file: `${fixtures}/jobs/probe.ts`,
    code: `import { thing } from "../domain/payout/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un trabajo importa un adaptador",
    file: `${fixtures}/jobs/probe.ts`,
    code: `import { thing } from "../adapters/stripe/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un trabajo importa el SDK de video",
    file: `${fixtures}/jobs/probe.ts`,
    code: `import Mux from "@mux/mux-node";\nexport const probe = Mux;\n`,
    rule: IMPORTS,
  },
  {
    name: "la configuración de Payload importa un adaptador",
    file: `${fixtures}/payload/probe.ts`,
    code: `import { thing } from "../adapters/stripe/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "el dominio importa la configuración",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `import { thing } from "../../config/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "una página importa la configuración",
    file: `${fixtures}/app/probe.ts`,
    code: `import { thing } from "../config/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "la configuración importa un servicio",
    file: `${fixtures}/config/probe.ts`,
    code: `import { thing } from "../services/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "el arranque importa un adaptador",
    file: `${fixtures}/instrumentation.ts`,
    code: `import { thing } from "./adapters/mux/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un servicio lee una variable de entorno por su cuenta",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = () => process.env.APP_ENV;\n`,
    rule: "no-restricted-properties",
  },
  {
    name: "un adaptador lee una variable de entorno por su cuenta",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `export const probe = () => process.env.STRIPE_SECRET_KEY;\n`,
    rule: "no-restricted-properties",
  },
  {
    name: "una página lee una variable de entorno por su cuenta",
    file: `${fixtures}/app/probe.ts`,
    code: `export const probe = () => process.env.NEXT_PUBLIC_SITE_URL;\n`,
    rule: "no-restricted-properties",
  },
  {
    name: "un archivo de src/ fuera de toda capa",
    file: `${fixtures}/helpers/probe.ts`,
    code: `export const probe = 1;\n`,
    rule: "boundaries/no-unknown-files",
  },
  {
    name: "una página real importa el dominio por el alias",
    file: "src/app/probe.ts",
    code: `import type { Cents } from "@/domain/shared/types";\nexport type Probe = Cents;\n`,
    rule: LAYERS,
  },
  // ADR-31 (TRD §8.10): el cliente de base y el SDK de Supabase no salen de su adaptador.
  {
    name: "un servicio importa el cliente de base",
    file: `${fixtures}/services/probe.ts`,
    code: `import { Pool } from "pg";\nexport const probe = Pool;\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio importa un paquete de la familia del cliente de base",
    file: `${fixtures}/services/probe.ts`,
    code: `import Pool from "pg-pool";\nexport const probe = Pool;\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio importa el SDK de Supabase",
    file: `${fixtures}/services/probe.ts`,
    code: `import { createClient } from "@supabase/supabase-js";\nexport const probe = createClient;\n`,
    rule: IMPORTS,
  },
  {
    name: "otro adaptador importa el cliente de base",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `import { Pool } from "pg";\nexport const probe = Pool;\n`,
    rule: IMPORTS,
  },
  {
    name: "la configuración importa el cliente de base",
    file: `${fixtures}/config/probe.ts`,
    code: `import { Pool } from "pg";\nexport const probe = Pool;\n`,
    rule: IMPORTS,
  },
  {
    name: "la configuración de Payload importa el SDK de Supabase",
    file: `${fixtures}/payload/probe.ts`,
    code: `import { createClient } from "@supabase/supabase-js";\nexport const probe = createClient;\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio carga un archivo interno del cliente de base",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = () => import("pg/lib/index.js");\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio importa un archivo interno del cliente de base",
    file: `${fixtures}/services/probe.ts`,
    code: `import Client from "pg/lib/client";\nexport const probe = Client;\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio carga el cliente de base con una plantilla",
    file: `${fixtures}/services/probe.ts`,
    code: "export const probe = () => import(`pg`);\n",
    rule: SYNTAX,
  },
  {
    name: "un servicio carga un paquete con un nombre que se arma al correr",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = (name: string) => import(name);\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio se fabrica su propio require",
    file: `${fixtures}/services/probe.ts`,
    code: `import { createRequire } from "node:module";\nexport const probe = createRequire(import.meta.url)("pg");\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio usa module.require",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = () => module.require("pg");\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio llama a sql(...) directamente",
    file: `${fixtures}/services/probe.ts`,
    code: `declare const sql: (...args: unknown[]) => unknown;\nexport const probe = (text: string) => sql([text]);\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio se escribe en JavaScript, donde las reglas de capas no alcanzan",
    file: `${fixtures}/services/probe.mjs`,
    code: `import pg from "pg";\nexport const probe = pg;\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio carga un paquete con require y un nombre que se arma al correr",
    file: `${fixtures}/services/probe.ts`,
    code: `declare const require: (name: string) => unknown;\nexport const probe = (name: string) => require(name);\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio importa el módulo de módulos entero para fabricarse un require",
    file: `${fixtures}/services/probe.ts`,
    code: `import Module from "node:module";\nexport const probe = Module.createRequire(import.meta.url)("pg");\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio llama a la etiqueta sql con call",
    file: `${fixtures}/services/probe.ts`,
    code: `declare const sql: { call: (...args: unknown[]) => unknown };\nexport const probe = (text: string) => sql.call(null, [text]);\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio escribe un commit dentro de una consulta",
    file: `${fixtures}/services/probe.ts`,
    code: "declare const sql: (strings: TemplateStringsArray) => unknown;\nexport const probe = sql`commit and chain`;\n",
    rule: SYNTAX,
  },
  {
    name: "un servicio cambia de rol dentro de una consulta",
    file: `${fixtures}/services/probe.ts`,
    code: "declare const sql: (strings: TemplateStringsArray) => unknown;\nexport const probe = sql`reset role`;\n",
    rule: SYNTAX,
  },
  {
    name: "un servicio reescribe quién actúa dentro de una consulta",
    file: `${fixtures}/services/probe.ts`,
    code: "declare const sql: (strings: TemplateStringsArray) => unknown;\nexport const probe = sql`select set_config('app.actor_id', 'otro', true)`;\n",
    rule: SYNTAX,
  },
  {
    name: "el arranque importa el cliente de base",
    file: `${fixtures}/instrumentation.ts`,
    code: `import { Pool } from "pg";\nexport const probe = Pool;\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio carga el cliente de base con import() dinámico",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = () => import("pg");\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio carga el SDK de Supabase con require",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = () => require("@supabase/supabase-js");\n`,
    rule: SYNTAX,
  },
  {
    name: "una página carga el cliente de base con import() dinámico",
    file: `${fixtures}/app/probe.ts`,
    code: `export const probe = () => import("pg");\n`,
    rule: SYNTAX,
  },
  {
    name: "el dominio carga el cliente de base con import() dinámico",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `export const probe = () => import("pg");\n`,
    rule: SYNTAX,
  },
];

const allowed: Omit<Case, "rule">[] = [
  {
    name: "el dominio importa al propio dominio",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `import { thing } from "../shared/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "el dominio recibe el reloj como argumento",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `export const probe = (now: Date) => new Date(now.getTime() + 1000);\n`,
  },
  {
    name: "una prueba del dominio importa vitest y fast-check",
    file: `${fixtures}/domain/access/probe.test.ts`,
    code: `import fc from "fast-check";\nimport { it } from "vitest";\nexport const probe = [fc, it];\n`,
  },
  {
    name: "un adaptador importa el dominio y su SDK",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `import Stripe from "stripe";\nimport { thing } from "../../domain/shared/thing";\nexport const probe = [Stripe, thing];\n`,
  },
  {
    name: "un adaptador importa sus propios archivos",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `import { thing } from "./thing";\nexport const probe = thing;\n`,
  },
  {
    name: "un servicio importa el dominio y un adaptador",
    file: `${fixtures}/services/probe.ts`,
    code: `import { thing as adapter } from "../adapters/mux/thing";\nimport { thing as domain } from "../domain/payout/thing";\nexport const probe = [adapter, domain];\n`,
  },
  {
    name: "un servicio llega a la base por el adaptador de Supabase",
    file: `${fixtures}/services/probe.ts`,
    code: `import { thing } from "../adapters/supabase/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "el adaptador de Supabase importa el cliente de base y su SDK",
    file: `${fixtures}/adapters/supabase/probe.ts`,
    code: `import { createClient } from "@supabase/supabase-js";\nimport { Pool } from "pg";\nexport const probe = [createClient, Pool];\n`,
  },
  {
    name: "el adaptador de Supabase carga el cliente de base con import() dinámico",
    file: `${fixtures}/adapters/supabase/probe.ts`,
    code: `export const probe = () => import("pg");\n`,
  },
  {
    name: "una página importa un servicio y los textos",
    file: `${fixtures}/app/probe.ts`,
    code: `import { thing as text } from "../messages/thing";\nimport { thing as service } from "../services/thing";\nexport const probe = [text, service];\n`,
  },
  {
    name: "un servicio importa la configuración",
    file: `${fixtures}/services/probe.ts`,
    code: `import { thing } from "../config/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "un adaptador importa la configuración",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `import { thing } from "../../config/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "la configuración lee las variables de entorno y usa un paquete",
    file: `${fixtures}/config/probe.ts`,
    code: `import { z } from "zod";\nexport const probe = () => [z, process.env.APP_ENV];\n`,
  },
  {
    name: "un servicio escribe una consulta normal, con palabras que solo se parecen a las prohibidas",
    file: `${fixtures}/services/probe.ts`,
    code: "declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;\nexport const probe = (id: string) => sql`select role, committed_at, ended_at from public.profiles where id = ${id} on conflict do nothing`;\n",
  },
  {
    name: "el arranque importa la configuración",
    file: `${fixtures}/instrumentation.ts`,
    code: `import { thing } from "./config/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "un trabajo importa un servicio",
    file: `${fixtures}/jobs/probe.ts`,
    code: `import { thing } from "../services/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "la configuración de Payload importa un servicio",
    file: `${fixtures}/payload/probe.ts`,
    code: `import { thing } from "../services/thing";\nexport const probe = thing;\n`,
  },
];

describe("capas de la aplicación (TRD §4.2)", () => {
  it.each(forbidden)("prohíbe: $name", async ({ file, code, rule }) => {
    expect(await rulesBroken(file, code)).toContain(rule);
  });

  it.each(allowed)("permite: $name", async ({ file, code }) => {
    expect(await rulesBroken(file, code)).toEqual([]);
  });
});
