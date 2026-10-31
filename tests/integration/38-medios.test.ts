import { generateKeyPairSync, verify } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { signPlayback } from "@/adapters/mux/sign";
import { createMediaGrant } from "@/services/media/grant";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, secondFactorFor, type KnownUser, type MemoryJar } from "./helpers/auth";
import { mediaStoreOn } from "./helpers/media";
import { asOwner, asSystem, reverted, teamStoreOn } from "./helpers/team";
import { totpCode } from "./helpers/totp";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// La función única de medios (T-108; RF-305), contra el Auth y la base locales: la guarda del
// equipo corre de verdad, la lección se lee como la persona, y la velocidad mínima es la del
// parámetro. Todo dentro de una transacción del dueño que se revierte: cargar un curso y dar
// una capacidad escriben en la auditoría. La firma es con una llave generada aquí.

const emails: string[] = [];
afterAll(async () => {
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = { id: "LlaveDePrueba01", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
const NOW = 1_800_000_000;

async function entered(person: KnownUser): Promise<MemoryJar> {
  const jar = memoryJar();
  const result = await testServices().signIn(jar, person, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return jar;
}

/** Un curso cargado como sistema, con una lección de Mux y otra de prueba. Devuelve sus lecciones. */
async function loadCourse(owner: Client): Promise<{ mux: string; test: string }> {
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de medios'), private.system_catalog_add('levels', 'Nivel de medios')");
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra de medios', 'maestra-medios', null) as id")).rows[0]?.id;
  const video = (provider: string, n: number) => ({ provider, asset_id: `medios-${n}`, playback_id: `PlaybackMedios${n}`, duration_seconds: 356 });
  const course = {
    slug: "curso-medios",
    title: "Curso de medios",
    practice: "practica-de-medios",
    level: "nivel-de-medios",
    modules: [{ title: "Uno", lessons: [{ title: "Con Mux", video: video("mux", 1) }, { title: "De prueba", video: video("test", 2) }] }],
  };
  const loaded = (await owner.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [teacher, JSON.stringify(course)])).rows[0];
  if (loaded?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded?.answer}`);
  const lessons = await owner.query<{ id: string; provider: string }>(
    "select l.id::text as id, v.provider from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id where l.title in ('Con Mux', 'De prueba')",
  );
  await asOwner(owner);
  return {
    mux: lessons.rows.find((row) => row.provider === "mux")?.id ?? "",
    test: lessons.rows.find((row) => row.provider === "test")?.id ?? "",
  };
}

/** Alguien del equipo con esas capacidades y su código dado, dentro de la transacción, y un curso cargado. */
async function staged<T>(capabilities: string[], fn: (stage: { owner: Client; jar: MemoryJar; lessons: { mux: string; test: string } }) => Promise<T>) {
  const person = await claimedUser();
  emails.push(person.email);
  await completeAccountAsOwner(person.id);
  const factor = await secondFactorFor(person);
  const jar = await entered(person);
  return reverted(async (owner) => {
    const services = testServices({ teamStore: teamStoreOn(owner) });
    await asSystem(owner);
    for (const capability of capabilities) {
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, $2::public.capability)", [person.id, capability]);
    }
    await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
      person.id,
      factor.factorId,
      person.email.toLowerCase(),
    ]);
    await asOwner(owner);
    expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
    const lessons = await loadCourse(owner);
    return fn({ owner, jar, lessons });
  });
}

function mediaOn(owner: Client) {
  const reported: string[] = [];
  const media = createMediaGrant(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: testServices({ teamStore: teamStoreOn(owner) }).teamStanding,
      checkSession: testServices().checkSession,
      store: mediaStoreOn(owner),
      signingKey: () => KEY,
      sign: signPlayback,
      files: { signDownload: () => Promise.resolve(null) },
      now: () => NOW,
    },
  );
  return { ...media, reported };
}

describe("la función única de medios, contra la base", () => {
  it("con Contenido: firma la lección de Mux, con su playback id y la vida que sale de VELOCIDAD_MIN", async () => {
    await staged(["content"], async ({ owner, jar, lessons }) => {
      const media = mediaOn(owner);
      const grant = await media.getMediaGrant(jar, lessons.mux, "review");
      if (grant.kind !== "granted") throw new Error(`No firmó: ${grant.kind}`);
      expect(grant.playbackId).toBe("PlaybackMedios1");
      // 356 s a 0.75× son 475 s, más los diez minutos de ADR-27.
      expect(grant.expiresAt).toBe(NOW + 475 + 600);
      const [header = "", payload = "", signature = ""] = grant.tokens.video.split(".");
      expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ sub: "PlaybackMedios1", aud: "v", exp: NOW + 1075 });
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
      expect(media.reported).toEqual([]);
    });
  });

  it("la lección de prueba, una que no existe y una sin forma: no_video", async () => {
    await staged(["content"], async ({ owner, jar, lessons }) => {
      const media = mediaOn(owner);
      expect(await media.getMediaGrant(jar, lessons.test, "review")).toEqual({ kind: "no_video" });
      expect(await media.getMediaGrant(jar, "00000000-0000-4000-8000-000000000000", "review")).toEqual({ kind: "no_video" });
      expect(await media.getMediaGrant(jar, "no-es-un-id", "review")).toEqual({ kind: "no_video" });
    });
  });

  it("alguien del equipo sin Contenido: refused, también para la lección que sí existe", async () => {
    await staged(["config"], async ({ owner, jar, lessons }) => {
      expect(await mediaOn(owner).getMediaGrant(jar, lessons.mux, "review")).toEqual({ kind: "refused" });
    });
  });

  it("la segunda barrera: la base no le da la lección a quien es del equipo sin Contenido, y a Contenido sí", async () => {
    await staged(["config"], async ({ owner, jar, lessons }) => {
      const team = await testServices({ teamStore: teamStoreOn(owner) }).teamStanding(jar);
      if (team.kind !== "team") throw new Error(`No quedó del equipo: ${team.kind}`);
      // Sin pasar por la guarda del servicio: la consulta misma, como esa persona.
      expect(await mediaStoreOn(owner).lessonVideo(team.claims, lessons.mux)).toBeNull();
    });
    await staged(["content"], async ({ owner, jar, lessons }) => {
      const team = await testServices({ teamStore: teamStoreOn(owner) }).teamStanding(jar);
      if (team.kind !== "team") throw new Error(`No quedó del equipo: ${team.kind}`);
      expect(await mediaStoreOn(owner).lessonVideo(team.claims, lessons.mux)).toMatchObject({ playbackId: "PlaybackMedios1" });
    });
  });

  it("una cuenta común: refused, sin preguntarle nada a la base", async () => {
    const person = await claimedUser();
    emails.push(person.email);
    await completeAccountAsOwner(person.id);
    const jar = await entered(person);
    const media = createMediaGrant(
      { report: () => Promise.resolve() },
      {
        teamStanding: testServices().teamStanding,
        checkSession: testServices().checkSession,
        store: mediaStoreOn(null as never),
        signingKey: () => KEY,
        sign: signPlayback,
        files: { signDownload: () => Promise.resolve(null) },
        now: () => NOW,
      },
    );
    expect(await media.getMediaGrant(jar, "00000000-0000-4000-8000-000000000000", "review")).toEqual({ kind: "refused" });
  });
});
