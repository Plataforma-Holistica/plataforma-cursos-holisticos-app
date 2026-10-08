import "server-only";

import type { ZodError } from "zod";

// Los errores que salen del adaptador van a dar a los registros. Un error de `pg` trae el
// SQL, los parámetros y a veces el dato de una persona en su mensaje o en su detalle:
// nada de eso se conserva.

interface PgErrorShape {
  code: string;
  severity: string;
  constraint?: unknown;
  table?: unknown;
  column?: unknown;
}

function isPgError(error: unknown): error is PgErrorShape {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; severity?: unknown };
  return typeof candidate.code === "string" && typeof candidate.severity === "string";
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** La base rechazó una sentencia. `code` es el SQLSTATE de Postgres. */
export class DatabaseError extends Error {
  readonly code: string;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;

  constructor(source: PgErrorShape) {
    super(`La base rechazó la operación (SQLSTATE ${source.code}).`);
    this.name = "DatabaseError";
    this.code = source.code;
    this.constraint = text(source.constraint);
    this.table = text(source.table);
    this.column = text(source.column);
  }
}

/** Convierte un error de `pg` en `DatabaseError`. Lo demás pasa tal cual. */
export function toDatabaseError(error: unknown): unknown {
  return isPgError(error) ? new DatabaseError(error) : error;
}

/** Una fila no tiene la forma que su consulta declaró. Dice dónde, no qué valor traía. */
export class RowValidationError extends Error {
  readonly paths: string[];

  constructor(error: ZodError) {
    const paths = [...new Set(error.issues.map((issue) => issue.path.join(".") || "(fila)"))];
    super(`Una fila de la base no cumple su esquema: ${paths.join(", ")}.`);
    this.name = "RowValidationError";
    this.paths = paths;
  }
}

/** Se usó el objeto de una transacción que ya terminó. */
export class TransactionClosedError extends Error {
  constructor() {
    super("La transacción ya terminó: esta consulta se hizo fuera de su función.");
    this.name = "TransactionClosedError";
  }
}

/** Se pidió actuar como una persona con unas claims que el adaptador no verificó. */
export class UnverifiedClaimsError extends Error {
  constructor() {
    super("asUser solo acepta las claims que devuelve verifyAccessToken.");
    this.name = "UnverifiedClaimsError";
  }
}
