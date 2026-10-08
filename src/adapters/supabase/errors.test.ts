import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DatabaseError, RowValidationError, toDatabaseError } from "./errors";

// Lo que trae un error de `pg`, con datos de una persona en el mensaje y en el detalle.
const pgError = Object.assign(new Error('invalid input syntax for type uuid: "ana@correo.test"'), {
  code: "22P02",
  severity: "ERROR",
  detail: "Key (email)=(ana@correo.test) already exists.",
  constraint: "profiles_pkey",
  table: "profiles",
  query: "select * from profiles where email = $1",
  parameters: ["ana@correo.test"],
});

describe("errores de la base", () => {
  it("conserva el código de Postgres y la restricción", () => {
    const error = toDatabaseError(pgError);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "22P02", constraint: "profiles_pkey", table: "profiles" });
  });

  it("no arrastra el mensaje, el detalle, el SQL ni los parámetros", () => {
    const error = toDatabaseError(pgError);
    if (!(error instanceof DatabaseError)) throw new Error("se esperaba un DatabaseError");
    const everything = JSON.stringify({
      message: error.message,
      stack: error.stack,
      own: { ...error },
      cause: String(error.cause),
    });
    expect(everything).not.toContain("ana@correo.test");
    expect(everything).not.toContain("select * from profiles");
  });

  it("lo que no viene de la base se deja pasar tal cual", () => {
    const own = new Error("regla de negocio");
    expect(toDatabaseError(own)).toBe(own);
    expect(toDatabaseError("texto")).toBe("texto");
  });

  it("una fila que no cumple su esquema dice dónde falla, no qué valor traía", () => {
    const result = z.object({ id: z.uuid(), n: z.number() }).safeParse({ id: "secreto", n: "x" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const error = new RowValidationError(result.error);
    expect(error.paths).toEqual(["id", "n"]);
    expect(error.message).toContain("id");
    expect(error.message).not.toContain("secreto");
  });
});
