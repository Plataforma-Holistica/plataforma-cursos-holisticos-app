import { describe, expect, it } from "vitest";

import { readVideoFacts, videoMimeOf, type RangeReader } from "./video-content";

const utf = (text: string) => Buffer.from(text, "latin1");
function atom(type: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
/** Un átomo con su tamaño en 64 bits, como trae un `mdat` de más de 4 GB. */
function bigAtom(type: string, declared: bigint, ...content: Buffer[]): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write(type, 4, "latin1");
  head.writeBigUInt64BE(declared, 8);
  return Buffer.concat([head, ...content]);
}
function mvhd0(timescale: number, duration: number): Buffer {
  const body = Buffer.alloc(100);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return atom("mvhd", body);
}
function mvhd1(timescale: number, duration: bigint): Buffer {
  const body = Buffer.alloc(112);
  body[0] = 1;
  body.writeUInt32BE(timescale, 20);
  body.writeBigUInt64BE(duration, 24);
  return atom("mvhd", body);
}
const ftyp = atom("ftyp", utf("isom"), Buffer.alloc(4), utf("isommp42"));

/** Lee de un archivo en memoria, y cuenta cuánto pidió. */
function memory(file: Buffer) {
  const calls: { start: number; length: number }[] = [];
  const read: RangeReader = (start, length) => {
    calls.push({ start, length });
    return Promise.resolve({ bytes: new Uint8Array(file.subarray(start, start + length)), total: file.length });
  };
  return { read, calls };
}

const MP4 = "video/mp4";
const MOV = "video/quicktime";

describe("videoMimeOf", () => {
  it("sale de la extensión, sin importar las mayúsculas", () => {
    expect(videoMimeOf("clase.mp4")).toBe(MP4);
    expect(videoMimeOf("CLASE.MOV")).toBe(MOV);
    expect(videoMimeOf("clase.final.v2.mp4")).toBe(MP4);
  });

  it("lo demás no se admite", () => {
    for (const name of ["clase.mkv", "clase.m4v", "clase.mp4.exe", "clase", "mp4", ""]) expect(videoMimeOf(name)).toBeNull();
  });
});

describe("readVideoFacts", () => {
  it("lee la duración con el índice al principio", async () => {
    const file = Buffer.concat([ftyp, atom("moov", mvhd0(1000, 90_000)), atom("mdat", Buffer.alloc(50))]);
    expect(await readVideoFacts(memory(file).read, MP4)).toEqual({ contentOk: true, seconds: 90 });
  });

  it("lee la duración con el índice al final, saltando sin bajar lo de en medio", async () => {
    const big = Buffer.alloc(2_000_000);
    const file = Buffer.concat([ftyp, atom("free"), atom("mdat", big), atom("moov", atom("udta", Buffer.alloc(9)), mvhd0(600, 1200))]);
    const { read, calls } = memory(file);
    expect(await readVideoFacts(read, MP4)).toEqual({ contentOk: true, seconds: 2 });
    expect(Math.max(...calls.map((call) => call.length))).toBeLessThan(1000);
    expect(calls.length).toBeLessThan(10);
  });

  it("entiende un átomo de 64 bits antes del índice", async () => {
    const mdat = bigAtom("mdat", 16n + 40n, Buffer.alloc(40));
    const file = Buffer.concat([ftyp, mdat, atom("moov", mvhd0(1000, 5000))]);
    expect(await readVideoFacts(memory(file).read, MP4)).toEqual({ contentOk: true, seconds: 5 });
  });

  it("entiende mvhd de la versión 1", async () => {
    const file = Buffer.concat([ftyp, atom("moov", mvhd1(90_000, 90_000n * 3600n))]);
    expect(await readVideoFacts(memory(file).read, MP4)).toEqual({ contentOk: true, seconds: 3600 });
  });

  it("redondea hacia arriba: lo que cuenta en el tope no se queda corto", async () => {
    const file = Buffer.concat([ftyp, atom("moov", mvhd0(1000, 1001))]);
    expect((await readVideoFacts(memory(file).read, MP4)).seconds).toBe(2);
  });

  it("un MOV puede empezar sin ftyp", async () => {
    const file = Buffer.concat([atom("wide"), atom("mdat", Buffer.alloc(30)), atom("moov", mvhd0(600, 6000))]);
    expect(await readVideoFacts(memory(file).read, MOV)).toEqual({ contentOk: true, seconds: 10 });
  });

  it("un MP4 sin ftyp al principio no es un MP4", async () => {
    const file = Buffer.concat([atom("wide"), atom("moov", mvhd0(600, 6000))]);
    expect(await readVideoFacts(memory(file).read, MP4)).toEqual({ contentOk: false, seconds: null });
  });

  it("lo que no es un video se dice como no es", async () => {
    for (const bytes of [utf("%PDF-1.7 un contenido cualquiera, bastante largo"), utf("MZ"), Buffer.alloc(40), Buffer.alloc(0)]) {
      expect(await readVideoFacts(memory(bytes).read, MP4)).toEqual({ contentOk: false, seconds: null });
      expect(await readVideoFacts(memory(bytes).read, MOV)).toEqual({ contentOk: false, seconds: null });
    }
  });

  it("un video sin duración legible: el contenido sirve y los segundos son nulos, y la base lo rechaza", async () => {
    const without = [
      Buffer.concat([ftyp, atom("mdat", Buffer.alloc(30))]), // sin índice
      Buffer.concat([ftyp, atom("moov", atom("trak", Buffer.alloc(30)))]), // sin mvhd
      Buffer.concat([ftyp, atom("moov", mvhd0(0, 5000))]), // sin escala
      Buffer.concat([ftyp, atom("moov", mvhd0(1000, 0))]), // sin duración: fragmentado
      Buffer.concat([ftyp, atom("moov", mvhd0(1000, 0xffffffff))]), // «no se sabe», según la norma
      Buffer.concat([ftyp, atom("moov", mvhd1(1000, 2n ** 63n))]), // no cabe
      Buffer.concat([ftyp, atom("moov", atom("mvhd", Buffer.alloc(8)))]), // mvhd corto
    ];
    for (const file of without) expect(await readVideoFacts(memory(file).read, MP4)).toEqual({ contentOk: true, seconds: null });
  });

  it("no da una vuelta infinita: un átomo con tamaño roto termina", async () => {
    const zero = Buffer.alloc(8);
    zero.write("skip", 4, "latin1"); // tamaño 0: llega hasta el final
    const tiny = Buffer.alloc(8);
    tiny.writeUInt32BE(4, 0); // menos que su propia cabecera
    tiny.write("skip", 4, "latin1");
    const past = Buffer.alloc(8);
    past.writeUInt32BE(1 << 30, 0); // pasa del archivo
    past.write("skip", 4, "latin1");
    for (const broken of [zero, tiny, past]) {
      const { read, calls } = memory(Buffer.concat([ftyp, broken, atom("moov", mvhd0(1000, 5000))]));
      expect(await readVideoFacts(read, MP4)).toEqual({ contentOk: true, seconds: null });
      expect(calls.length).toBeLessThan(5);
    }
  });

  it("se cansa de archivos con miles de átomos diminutos, sin bajarlos todos", async () => {
    const many = Array.from({ length: 1000 }, () => atom("free"));
    const { read, calls } = memory(Buffer.concat([ftyp, ...many, atom("moov", mvhd0(1000, 5000))]));
    expect(await readVideoFacts(read, MP4)).toEqual({ contentOk: true, seconds: null });
    expect(calls.length).toBeLessThanOrEqual(64);
  });

  it("si no se pudo leer, no se sabe: nulo, que la base no toma como rechazo", async () => {
    expect(await readVideoFacts(() => Promise.resolve(null), MP4)).toEqual({ contentOk: null, seconds: null });
    // Falla ya caminando, con el principio leído.
    const file = Buffer.concat([ftyp, atom("mdat", Buffer.alloc(30)), atom("moov", mvhd0(1000, 5000))]);
    const { read } = memory(file);
    let count = 0;
    const flaky: RangeReader = (start, length) => (++count > 1 ? Promise.resolve(null) : read(start, length));
    expect(await readVideoFacts(flaky, MP4)).toEqual({ contentOk: null, seconds: null });
    // Falla al leer el mvhd.
    const atMvhd: RangeReader = (start, length) => (start >= ftyp.length + 8 + 8 ? Promise.resolve(null) : read(start, length));
    expect(await readVideoFacts(atMvhd, MP4)).toEqual({ contentOk: null, seconds: null });
  });
});
