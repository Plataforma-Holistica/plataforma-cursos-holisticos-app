// Arma las variables de entorno de las pruebas de integración en la integración continua.
//
// La base local nace limpia en cada corrida: sus direcciones y llaves salen de
// `supabase status`, y la contraseña de app_service se inventa aquí, una por corrida.
// Las deja en $GITHUB_ENV para los pasos siguientes. En una máquina de desarrollo esos
// valores viven en `.env.local` y este guion no hace falta.

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

function fail(message) {
  console.error(`ci-env: ${message}`);
  process.exit(1);
}

const target = process.env.GITHUB_ENV;
if (!target) fail("solo corre en la integración continua (falta GITHUB_ENV).");

let status;
try {
  // Un comando fijo, sin nada que venga de fuera. Por el intérprete porque en Windows
  // `pnpm` es un guion.
  const output = execSync("pnpm exec supabase status -o json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  status = JSON.parse(output.slice(output.indexOf("{")));
} catch {
  fail("no se pudo leer `supabase status`. ¿La base local está arriba?");
}

for (const key of ["API_URL", "DB_URL", "PUBLISHABLE_KEY", "SECRET_KEY"]) {
  if (typeof status[key] !== "string" || status[key] === "") fail(`supabase status no trae ${key}.`);
}

// La aplicación entra como app_service, con una contraseña que solo existe en esta
// corrida. `pnpm db:login` se la pone al rol.
const password = randomBytes(24).toString("base64url");
const appUrl = new URL(status.DB_URL);
appUrl.username = "app_service";
appUrl.password = password;

const variables = {
  APP_ENV: "local",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: status.SECRET_KEY,
  DATABASE_URL: appUrl.href,
  DATABASE_URL_DIRECT: status.DB_URL,
};

// Son valores de una base desechable, pero no tienen por qué salir en el registro.
for (const secret of [password, status.SECRET_KEY]) console.log(`::add-mask::${secret}`);

appendFileSync(
  target,
  Object.entries(variables)
    .map(([name, value]) => `${name}=${value}\n`)
    .join(""),
);
console.log(`ci-env: ${Object.keys(variables).length} variables listas para los pasos siguientes.`);
