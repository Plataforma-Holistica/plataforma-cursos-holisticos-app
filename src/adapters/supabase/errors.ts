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

/** Las claims eran válidas cuando se verificaron, pero su token ya venció. */
export class ExpiredClaimsError extends Error {
  constructor() {
    super("Las claims ya vencieron: hay que verificar un token vigente.");
    this.name = "ExpiredClaimsError";
  }
}

/**
 * No se pudo saber si el token es válido: el servidor de identidad no respondió. No es lo
 * mismo que un token inválido, y a la persona no se le debe tratar como si no tuviera
 * sesión.
 */
export class IdentityUnavailableError extends Error {
  constructor() {
    super("El servidor de identidad no respondió: no se pudo verificar la sesión.");
    this.name = "IdentityUnavailableError";
  }
}

/**
 * La función terminó bien, pero la transacción estaba abortada: una sentencia falló y
 * alguien atrapó el error. Nada se guardó. Sin esta comprobación Postgres contestaría
 * ROLLBACK al commit, sin error, y el adaptador reportaría éxito.
 */
export class TransactionAbortedError extends Error {
  constructor() {
    super(
      "La transacción no se guardó: una sentencia falló antes y su error se atrapó. " +
        "Un error de la base no se atrapa para seguir; si es esperado, se evita con la consulta.",
    );
    this.name = "TransactionAbortedError";
  }
}

/**
 * Una consulta le quitó la transacción al adaptador: la terminó (commit, rollback, end,
 * abort, con o sin `and chain`) o cambió con qué rol corre (`set role`, `reset role`).
 */
export class TransactionControlError extends Error {
  constructor() {
    super(
      "Una consulta terminó la transacción o cambió su rol. Quien la abre, la cierra y " +
        "decide el rol es el adaptador: nada de eso se escribe en una consulta.",
    );
    this.name = "TransactionControlError";
  }
}

/** Se abrió una transacción dentro de la función de otra. */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      "asUser, asServer y asSystem no se anidan: cada una toma una conexión. " +
        "Pasa el `tx` que ya tienes a quien lo necesite.",
    );
    this.name = "NestedTransactionError";
  }
}
