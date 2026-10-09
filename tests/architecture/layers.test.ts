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
const LITERALS = "react/jsx-no-literals";
const DOM_PROPS = "react/forbid-dom-props";

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
  // T-109: los componentes base (src/ui/) no conocen datos. Solo importan los textos.
  {
    name: "un componente base importa un servicio",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { thing } from "../services/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un componente base importa un adaptador",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { thing } from "../adapters/mux/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un componente base importa el dominio",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { thing } from "../domain/shared/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un componente base importa una pantalla",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { thing } from "../app/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un componente base importa la configuración",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { thing } from "../config/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un servicio importa un componente base",
    file: `${fixtures}/services/probe.ts`,
    code: `import { thing } from "../ui/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "el dominio importa un componente base",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `import { thing } from "../../ui/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un trabajo importa un componente base",
    file: `${fixtures}/jobs/probe.ts`,
    code: `import { thing } from "../ui/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "los textos importan un componente base",
    file: `${fixtures}/messages/probe.ts`,
    code: `import { thing } from "../ui/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un componente base importa el cliente de base",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { Pool } from "pg";\nexport const probe = Pool;\n`,
    rule: IMPORTS,
  },
  {
    name: "un componente base importa el SDK de cobro",
    file: `${fixtures}/ui/probe.ts`,
    code: `import Stripe from "stripe";\nexport const probe = Stripe;\n`,
    rule: IMPORTS,
  },
  {
    name: "una página importa el SDK del registro de errores",
    file: `${fixtures}/app/probe.ts`,
    code: `import * as Sentry from "@sentry/nextjs";\nexport const probe = Sentry;\n`,
    rule: IMPORTS,
  },
  {
    name: "un componente base importa el SDK del registro de errores",
    file: `${fixtures}/ui/probe.ts`,
    code: `import * as Sentry from "@sentry/nextjs";\nexport const probe = Sentry;\n`,
    rule: IMPORTS,
  },
  {
    name: "un trabajo importa el SDK del registro de errores",
    file: `${fixtures}/jobs/probe.ts`,
    code: `import * as Sentry from "@sentry/nextjs";\nexport const probe = Sentry;\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio usa el SDK del registro de errores por su cuenta, sin el filtro",
    file: `${fixtures}/services/probe.ts`,
    code: `import * as Sentry from "@sentry/nextjs";\nexport const probe = Sentry;\n`,
    rule: IMPORTS,
  },
  {
    name: "otro adaptador usa el SDK del registro de errores",
    file: `${fixtures}/adapters/stripe/probe.ts`,
    code: `import * as Sentry from "@sentry/nextjs";\nexport const probe = Sentry;\n`,
    rule: IMPORTS,
  },
  {
    name: "el adaptador de la base usa el SDK del registro de errores",
    file: `${fixtures}/adapters/supabase/probe.ts`,
    code: `import * as Sentry from "@sentry/nextjs";\nexport const probe = Sentry;\n`,
    rule: IMPORTS,
  },
  {
    name: "el arranque importa el SDK del registro de errores directamente",
    file: `${fixtures}/instrumentation.ts`,
    code: `import * as Sentry from "@sentry/nextjs";\nexport const probe = Sentry;\n`,
    rule: IMPORTS,
  },
  // Lo mismo con import() o con require, que la regla de importaciones no ve: desde ahí
  // `Sentry.setUser` o `Sentry.logger` se saltarían el filtro igual.
  {
    name: "un servicio carga el SDK del registro de errores con import()",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = () => import("@sentry/nextjs");\n`,
    rule: SYNTAX,
  },
  {
    name: "un servicio carga una parte del SDK del registro de errores con require",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = () => require("@sentry/core");\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla (.tsx) carga el SDK del registro de errores con import()",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const probe = () => import("@sentry/nextjs");\n`,
    rule: SYNTAX,
  },
  {
    name: "un componente base (.tsx) carga el SDK del registro de errores con import()",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const probe = () => import("@sentry/browser");\n`,
    rule: SYNTAX,
  },
  {
    name: "el dominio carga el SDK del registro de errores con import()",
    file: `${fixtures}/domain/access/probe.ts`,
    code: `export const probe = () => import("@sentry/nextjs");\n`,
    rule: SYNTAX,
  },
  {
    name: "el adaptador de la base carga el SDK del registro de errores con import()",
    file: `${fixtures}/adapters/supabase/probe.ts`,
    code: `export const probe = () => import("@sentry/nextjs");\n`,
    rule: SYNTAX,
  },
  {
    name: "el arranque carga el SDK del registro de errores con import()",
    file: `${fixtures}/instrumentation.ts`,
    code: `export const probe = () => import("@sentry/nextjs");\n`,
    rule: SYNTAX,
  },
  {
    // `browser-sdk.ts` reexporta `init`: desde fuera serviría para encender el SDK otra
    // vez, con otras opciones y sin el filtro.
    name: "un servicio importa lo que el adaptador reexporta del SDK",
    file: `${fixtures}/services/probe.ts`,
    code: `import { init } from "@/adapters/sentry/browser-sdk";\nexport const probe = init;\n`,
    rule: IMPORTS,
  },
  {
    name: "un servicio carga con import() lo que el adaptador reexporta del SDK",
    file: `${fixtures}/services/probe.ts`,
    code: `export const probe = () => import("@/adapters/sentry/browser-sdk");\n`,
    rule: SYNTAX,
  },
  {
    // Pedir el paquete entero descarga casi el triple: lo que el navegador usa se pide por
    // `browser-sdk.ts`, y lo demás se importa de forma fija.
    name: "el propio adaptador del registro de errores pide el paquete entero con import()",
    file: `${fixtures}/adapters/sentry/probe.ts`,
    code: `export const probe = () => import("@sentry/nextjs");\n`,
    rule: SYNTAX,
  },
  {
    name: "el adaptador del registro de errores importa el cliente de base",
    file: `${fixtures}/adapters/sentry/probe.ts`,
    code: `import { Pool } from "pg";\nexport const probe = Pool;\n`,
    rule: IMPORTS,
  },
  {
    name: "el arranque del navegador importa un adaptador",
    file: `${fixtures}/instrumentation-client.ts`,
    code: `import { thing } from "./adapters/mux/thing";\nexport const probe = thing;\n`,
    rule: LAYERS,
  },
  {
    name: "un componente base importa el catálogo entero, que así llegaría al navegador",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { messages } from "@/messages";\nexport const probe = messages;\n`,
    rule: IMPORTS,
  },
  // Guardia: las reglas de texto de abajo viven en un bloque que reemplaza la regla de
  // sintaxis. Si ese bloque pierde la prohibición del cliente de base, esto falla.
  {
    name: "un componente base (.tsx) carga el cliente de base con import() dinámico",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const probe = () => import("pg");\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla (.tsx) carga el cliente de base con import() dinámico",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const probe = () => import("pg");\n`,
    rule: SYNTAX,
  },
  // RNF-15: ningún texto visible se escribe fuera del catálogo de src/messages/.
  {
    name: "un componente base lleva un texto escrito dentro",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = () => <p>Hola</p>;\n`,
    rule: LITERALS,
  },
  {
    name: "una pantalla lleva un texto escrito dentro",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = () => <h1>{"Bienvenida"}</h1>;\n`,
    rule: LITERALS,
  },
  {
    name: "un componente base escribe a mano un nombre accesible",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = () => <button type="button" aria-label="Cerrar" />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla escribe a mano el texto de ejemplo de un campo",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = () => <input placeholder={"Tu correo"} />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla escribe a mano la etiqueta de un componente",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const Field: (props: { label: string }) => null;\nexport const Probe = () => <Field label={\`Correo\`} />;\n`,
    rule: SYNTAX,
  },
  // Los huecos que encontró la revisión independiente: formas de escribir un texto a
  // mano que la regla dejaba pasar.
  {
    name: "una pantalla elige entre dos textos escritos a mano",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = ({ ok }: { ok: boolean }) => <p>{ok ? "Listo" : "Falló"}</p>;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla pinta un texto escrito a mano tras una condición",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = ({ x }: { x: boolean }) => <p>{x && "Texto a mano"}</p>;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla pinta una plantilla de JavaScript con texto",
    file: `${fixtures}/app/probe.tsx`,
    code: "export const Probe = ({ n }: { n: number }) => <p>{`Hay ${n} cursos`}</p>;\n",
    rule: SYNTAX,
  },
  {
    name: "una pantalla le pasa a un componente un texto a mano en una prop cualquiera",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const Field: (props: { error: string }) => null;\nexport const Probe = () => <Field error="Escribe un correo válido." />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla le pasa el texto de carga de un botón escrito a mano",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const Button: (props: { loadingLabel: string }) => null;\nexport const Probe = () => <Button loadingLabel={"Guardando…"} />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla escribe a mano el título de su pestaña",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const metadata = { title: "Entrar" };\nexport const Probe = () => null;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla (.ts) escribe a mano la descripción de su pestaña",
    file: `${fixtures}/app/probe.ts`,
    code: `export const metadata = { description: "Cursos de bienestar" };\n`,
    rule: SYNTAX,
  },
  // Segunda vuelta: lo que la regla «al revés» todavía dejaba pasar.
  {
    name: "una pantalla arma un nombre accesible pegando texto",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = ({ x }: { x: string }) => <button type="button" aria-label={"Eliminar " + x} />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla le pasa al resumen de errores un mensaje escrito a mano",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const Summary: (props: { errors: { fieldId: string; message: string }[] }) => null;\nexport const Probe = () => <Summary errors={[{ fieldId: "correo", message: "Escribe tu correo" }]} />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla mete un nombre accesible por un objeto esparcido",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = () => <button type="button" {...{ "aria-label": "Cerrar" }} />;\n`,
    rule: SYNTAX,
  },
  {
    name: "un componente base trae un texto a mano como valor por omisión de una prop",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = ({ label = "Guardar" }: { label?: string }) => <button type="button">{label}</button>;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla pinta un texto a mano dentro de un arreglo",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = () => <p>{["Hola"]}</p>;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla pinta un texto a mano con una conversión de tipo",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = () => <p>{"Hola" as string}</p>;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla le pasa a un componente un texto a mano como acción",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const Alert: (props: { action: string }) => null;\nexport const Probe = () => <Alert action="Reintentar" />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla le pasa a un componente un texto a mano como contenido",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const Tooltip: (props: { content: string }) => null;\nexport const Probe = () => <Tooltip content="Esto no se puede deshacer" />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla lee el texto crudo de una plantilla, con sus llaves",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const meta: { titleTemplate: { template: string } };\nexport const Probe = () => <p>{meta.titleTemplate.template}</p>;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla escribe a mano el título que devuelve generateMetadata",
    file: `${fixtures}/app/probe.tsx`,
    code: `export function generateMetadata() {\n  return { title: "Mis cursos" };\n}\nexport const Probe = () => null;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla escribe a mano un título absoluto",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const metadata = { title: { absolute: "Entrar" } };\nexport const Probe = () => null;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla carga una página de muestra con import()",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const probe = () => import("./muestra/page.dev");\n`,
    rule: SYNTAX,
  },
  {
    name: "una página de muestra usa estilos en línea",
    file: `${fixtures}/app/muestra/page.dev.tsx`,
    code: `export default function Page() {\n  return <div style={{ color: "red" }} />;\n}\n`,
    rule: DOM_PROPS,
  },
  {
    name: "un componente de Payload lleva un texto escrito dentro",
    file: `${fixtures}/payload/probe.tsx`,
    code: `export const Probe = () => <p>Hola</p>;\n`,
    rule: LITERALS,
  },
  {
    name: "un componente base usa una medida suelta marcada como importante",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = () => <div className="w-[317px]!" />;\n`,
    rule: SYNTAX,
  },
  {
    name: "un componente base usa una propiedad suelta tras una variante",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = () => <div className="hover:[color:red]" />;\n`,
    rule: SYNTAX,
  },
  {
    name: "un componente base usa una opacidad suelta",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = () => <div className="bg-text/[0.37]" />;\n`,
    rule: SYNTAX,
  },
  {
    name: "un componente base inventa un punto de quiebre",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = () => <div className="min-[900px]:flex" />;\n`,
    rule: SYNTAX,
  },
  // «Todo valor visual es un token»: un valor arbitrario de Tailwind es un valor suelto.
  {
    name: "un componente base usa un color suelto en una clase",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = () => <div className="bg-[#fff]" />;\n`,
    rule: SYNTAX,
  },
  {
    name: "una pantalla usa una medida suelta en una clase",
    file: `${fixtures}/app/probe.tsx`,
    code: `export const Probe = () => <div className="mt-2 w-[317px] p-4" />;\n`,
    rule: SYNTAX,
  },
  {
    name: "un componente base guarda una medida suelta en una constante de clases",
    file: `${fixtures}/ui/probe.tsx`,
    code: `const BASE = "inline-flex min-h-[44px]";\nexport const Probe = () => <div className={BASE} />;\n`,
    rule: SYNTAX,
  },
  // La excepción de las páginas de muestra es para páginas, no para cualquier archivo.
  {
    name: "un componente base se llama .dev.tsx para escribir texto a mano",
    file: `${fixtures}/ui/probe.dev.tsx`,
    code: `export const Probe = () => <p>Hola</p>;\n`,
    rule: LITERALS,
  },
  {
    name: "una pantalla importa un archivo de muestra, que solo existe en desarrollo",
    file: `${fixtures}/app/probe.tsx`,
    code: `import { Probe as Sample } from "./muestra/page.dev";\nexport const Probe = Sample;\n`,
    rule: IMPORTS,
  },
  {
    name: "un componente base importa el catálogo entero por una ruta relativa",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { messages } from "../messages";\nexport const probe = messages;\n`,
    rule: IMPORTS,
  },
  {
    name: "un componente base importa el catálogo entero nombrando su archivo",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { messages } from "@/messages/index.ts";\nexport const probe = messages;\n`,
    rule: IMPORTS,
  },
  {
    name: "un componente base usa estilos en línea",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = () => <div style={{ color: "red" }} />;\n`,
    rule: DOM_PROPS,
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
    name: "un componente base importa los textos",
    file: `${fixtures}/ui/probe.ts`,
    code: `import { thing } from "../messages/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "un componente base importa su bloque de textos por el alias",
    file: "src/ui/probe.ts",
    code: `import { ui } from "@/messages/es/ui";\nexport const probe = ui;\n`,
  },
  {
    name: "una pantalla importa un componente base",
    file: `${fixtures}/app/probe.ts`,
    code: `import { thing } from "../ui/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "una pantalla elige entre dos textos del catálogo y entre dos clases",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const text: { ok: string; bad: string };\nexport const Probe = ({ ok }: { ok: boolean }) => (\n  <p className={ok ? "text-success" : "text-danger"} data-state={ok ? "ok" : "bad"}>\n    {ok ? text.ok : text.bad}\n  </p>\n);\n`,
  },
  {
    name: "una pantalla escribe a mano lo que no es texto: tipos, nombres, direcciones y variantes",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const Field: (props: { name: string; autoComplete: string; variant: string; label: string }) => null;\ndeclare const label: string;\nexport const Probe = () => (\n  <form method="post" action="/entrar">\n    <Field name="email" autoComplete="email" variant="simple" label={label} />\n    <a href="/ayuda" rel="noopener noreferrer" target="_blank" aria-current="page">{label}</a>\n    <input type="email" inputMode="email" id="correo" aria-describedby="correo-ayuda" role="textbox" />\n  </form>\n);\n`,
  },
  {
    name: "una pantalla arma el título de su pestaña con el catálogo",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const title: string;\nexport const metadata = { title, robots: { index: false } };\nexport const Probe = () => null;\n`,
  },
  {
    name: "un componente base usa tokens, variantes entre corchetes y variables de la hoja",
    file: `${fixtures}/ui/probe.tsx`,
    code: `const BASE = "duration-(--duration-fast) z-(--z-skip) [&_a]:inline-block [&_a]:py-3 aria-[busy=true]:opacity-60";\nexport const Probe = () => <div className={BASE} />;\n`,
  },
  // Lo que la regla no debe estorbar: código corriente que no es texto para la gente.
  {
    name: "una pantalla usa valores de formulario, comparaciones y manejadores sin texto visible",
    file: `${fixtures}/app/probe.tsx`,
    code: `declare const Field: (props: { name: string; value: string; label: string }) => null;\ndeclare const label: string;\ndeclare const go: (to: string) => void;\nexport const Probe = ({ kind }: { kind: string }) => (\n  <form>\n    <input type="hidden" name="intent" value="cancel" />\n    <select name="country" defaultChecked={false}>\n      <option value="mx">{label}</option>\n    </select>\n    <Field name="plan" value="yearly" label={kind === "one" ? label : label} />\n    <button type="button" onClick={() => go("/cuenta")} aria-current={kind === "one" ? "page" : undefined}>\n      {label}\n    </button>\n  </form>\n);\n`,
  },
  {
    name: "un componente base busca un elemento por un selector entre corchetes",
    file: `${fixtures}/ui/probe.ts`,
    code: `export const probe = (root: Element) => [root.querySelector("[data-still]"), root.closest("[role=dialog]")];\n`,
  },
  {
    name: "un componente base da valores por omisión a lo que no es texto",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = ({ variant = "primary", type = "button" }: { variant?: string; type?: "button" | "submit" }) => (\n  <button type={type} data-variant={variant} />\n);\n`,
  },
  {
    name: "una página de muestra escribe sus textos de ejemplo a mano",
    file: `${fixtures}/app/muestra/page.dev.tsx`,
    code: `export default function Page() {\n  return <p title="Ejemplo">Hola</p>;\n}\n`,
  },
  {
    name: "un componente base recibe su texto y escribe clases y tipos a mano",
    file: `${fixtures}/ui/probe.tsx`,
    code: `export const Probe = ({ text }: { text: string }) => (\n  <button type="button" className="h-control" aria-label={text}>\n    {text}\n  </button>\n);\n`,
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
    name: "el arranque del navegador importa un servicio",
    file: `${fixtures}/instrumentation-client.ts`,
    code: `import { thing } from "./services/thing";\nexport const probe = thing;\n`,
  },
  {
    name: "el adaptador del registro de errores importa su SDK y la configuración",
    file: `${fixtures}/adapters/sentry/probe.ts`,
    code: `import * as Sentry from "@sentry/nextjs";\nimport { thing } from "../../config/thing";\nexport const probe = [Sentry, thing];\n`,
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
