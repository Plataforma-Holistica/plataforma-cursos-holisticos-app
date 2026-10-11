import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
  AuthWeakPasswordError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  alreadyClosed,
  failureFromResponse,
  failureFromSdk,
  passwordSetFailure,
  recoveryRequestFailure,
  redeemFailure,
  sessionLostOnRefresh,
  sessionRevoked,
  signInFailure,
  signUpFailure,
  type AuthFailure,
} from "./auth-errors";

const rejected = (code: string | null, status = 400): AuthFailure => ({ kind: "rejected", status, code });
const unreachable: AuthFailure = { kind: "unreachable" };

// Lo que ninguna tabla reconoce: tiene que caer siempre en «no se supo».
const strangers: AuthFailure[] = [
  unreachable,
  rejected(null),
  rejected(null, 429),
  rejected("un_codigo_que_no_existe"),
  rejected("unexpected_failure"),
  rejected("conflict", 409),
  rejected("over_request_rate_limit", 429),
];

describe("leer un error del SDK", () => {
  it("un error de la API conserva su código y su estado, no su mensaje", () => {
    const failure = failureFromSdk(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"));
    expect(failure).toEqual({ kind: "rejected", status: 400, code: "invalid_credentials" });
    expect(JSON.stringify(failure)).not.toContain("Invalid login");
  });

  it.each([
    ["un corte de red", new AuthRetryableFetchError("fetch failed", 0)],
    ["un 503 de la pasarela", new AuthRetryableFetchError("Service Unavailable", 503)],
    ["un error interno de Auth", new AuthApiError("boom", 500, "unexpected_failure")],
    ["un error que el SDK no entiende", new AuthUnknownError("?", new Error("?"))],
    ["algo que no es un error del SDK", new Error("otra cosa")],
    ["un valor que no es un error", "texto"],
    ["nada", undefined],
  ])("%s es «no hubo respuesta»", (_name, error) => {
    expect(failureFromSdk(error)).toEqual(unreachable);
  });

  it("una sesión que falta se reconoce aunque no traiga código", () => {
    expect(failureFromSdk(new AuthSessionMissingError())).toEqual(rejected("session_not_found"));
  });

  it("una contraseña débil se reconoce por su clase", () => {
    expect(failureFromSdk(new AuthWeakPasswordError("weak", 422, ["length"]))).toEqual(
      rejected("weak_password", 422),
    );
  });

  it("un error de la API sin código queda sin código", () => {
    expect(failureFromSdk(new AuthApiError("?", 403, undefined))).toEqual(rejected(null, 403));
  });
});

describe("leer la respuesta de una llamada directa", () => {
  it("toma el código cuando es un texto", () => {
    expect(failureFromResponse(400, { code: "refresh_token_not_found", message: "x" })).toEqual(
      rejected("refresh_token_not_found"),
    );
  });

  it.each([
    ["sin la cabecera de versión el código es un número", { code: 400, error_code: "session_not_found" }],
    ["un error con forma de OAuth", { error: "invalid_grant", error_description: "x" }],
    ["un cuerpo que no es un objeto", "<html>"],
    ["un cuerpo vacío", null],
  ])("%s: queda sin código", (_name, body) => {
    expect(failureFromResponse(400, body)).toEqual(rejected(null));
  });

  it.each([500, 502, 503, 504, 520])("un %i es «no hubo respuesta»", (status) => {
    expect(failureFromResponse(status, { code: "session_not_found" })).toEqual(unreachable);
  });
});

describe("registrar", () => {
  it.each([
    ["over_email_send_rate_limit", "mail_rate_limited"],
    ["signup_disabled", "signup_disabled"],
    ["email_provider_disabled", "signup_disabled"],
    ["validation_failed", "rejected"],
    ["email_address_invalid", "rejected"],
    ["user_already_exists", "misconfigured"],
    ["email_exists", "misconfigured"],
  ])("%s es %s", (code, expected) => {
    expect(signUpFailure(rejected(code))).toBe(expected);
  });

  it.each(strangers)("lo que no reconoce es «no se supo»: %j", (failure) => {
    expect(signUpFailure(failure)).toBe("unknown");
  });
});

describe("pedir la recuperación", () => {
  it("solo distingue el límite de correos", () => {
    expect(recoveryRequestFailure(rejected("over_email_send_rate_limit", 429))).toBe("mail_rate_limited");
  });

  it.each(strangers)("lo demás es «no se supo»: %j", (failure) => {
    expect(recoveryRequestFailure(failure)).toBe("unknown");
  });
});

describe("canjear un enlace", () => {
  it.each(["otp_expired", "validation_failed", "user_banned", "user_not_found"])(
    "%s: el enlace no sirve",
    (code) => {
      expect(redeemFailure(rejected(code, 403))).toBe("invalid_or_expired");
    },
  );

  it.each(strangers)("lo demás es «no se supo»: %j", (failure) => {
    expect(redeemFailure(failure)).toBe("unknown");
  });
});

describe("fijar una contraseña", () => {
  it.each([
    ["same_password", "same_password"],
    ["weak_password", "weak_password"],
    ["validation_failed", "rejected"],
    ["bad_jwt", "rejected"],
    ["session_not_found", "rejected"],
    ["session_expired", "rejected"],
    ["user_not_found", "rejected"],
    ["user_banned", "rejected"],
    ["reauthentication_needed", "rejected"],
    ["insufficient_aal", "rejected"],
  ])("%s es %s", (code, expected) => {
    expect(passwordSetFailure(rejected(code, 422))).toBe(expected);
  });

  it.each(strangers)("lo que no reconoce no es un éxito ni un rechazo: %j", (failure) => {
    expect(passwordSetFailure(failure)).toBe("unknown");
  });
});

describe("entrar", () => {
  it.each([
    ["invalid_credentials", "invalid_credentials"],
    ["validation_failed", "invalid_credentials"],
    ["email_not_confirmed", "email_not_confirmed"],
    ["user_banned", "banned"],
    ["over_request_rate_limit", "rate_limited"],
  ])("%s es %s", (code, expected) => {
    expect(signInFailure(rejected(code))).toBe(expected);
  });

  it.each(strangers.filter((failure) => failure.kind !== "rejected" || failure.code !== "over_request_rate_limit"))(
    "lo que no reconoce es «no se supo»: %j",
    (failure) => {
      expect(signInFailure(failure)).toBe("unknown");
    },
  );
});

describe("renovar: cuándo la sesión se perdió de verdad", () => {
  it.each([
    "refresh_token_not_found",
    "refresh_token_already_used",
    "session_not_found",
    "session_expired",
    "user_not_found",
    "user_banned",
    "validation_failed",
  ])("%s: se perdió", (code) => {
    expect(sessionLostOnRefresh(rejected(code))).toBe(true);
  });

  it.each([...strangers, rejected("bad_jwt", 403), rejected("bad_json"), rejected("invalid_credentials")])(
    "un fallo pasajero o desconocido no borra la sesión: %j",
    (failure) => {
      expect(sessionLostOnRefresh(failure)).toBe(false);
    },
  );
});

describe("cerrar y preguntar por una sesión", () => {
  it.each(["session_not_found", "user_not_found"])("cerrar con %s es haber cerrado", (code) => {
    expect(alreadyClosed(rejected(code, 403))).toBe(true);
  });

  it.each([...strangers, rejected("bad_jwt", 403), rejected("user_banned", 403)])(
    "cerrar con otra cosa no es haber cerrado: %j",
    (failure) => {
      expect(alreadyClosed(failure)).toBe(false);
    },
  );

  it.each(["session_not_found", "user_not_found", "user_banned"])("%s: la sesión está revocada", (code) => {
    expect(sessionRevoked(rejected(code, 403))).toBe(true);
  });

  it.each([...strangers, rejected("bad_jwt", 403)])(
    "un token vencido o un fallo pasajero no dicen que esté revocada: %j",
    (failure) => {
      expect(sessionRevoked(failure)).toBe(false);
    },
  );
});
