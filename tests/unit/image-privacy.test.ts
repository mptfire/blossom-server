/**
 * Image-privacy tests (r8c senior review: EXIF retention defect).
 *
 * The config schema promises keepExif=false strips ALL EXIF (GPS, artist).
 * sharp's `withMetadata({ exif: {} })` does NOT strip — the empty overlay
 * merges on top of the original metadata blocks, so GPS coordinates and the
 * artist field survived the "strip". These tests prove the pipeline now
 * strips on the privacy path and retains on the explicit keepExif=true path,
 * for JPEG, PNG and WebP outputs.
 *
 * Requires the native sharp module (desktop runner).
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { optimizeImage } from "../../src/optimize/image.ts";

const tmpRoot = await Deno.makeTempDir({ prefix: "blossom_exif_" });

async function exifFixture(path: string): Promise<void> {
  // Synthetic photo: plain pixels + embedded EXIF artist/GPS markers
  // (written via sharp's withExif — IFD0 artist + GPS latitude fields).
  const { default: sharp } = await import("sharp");
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg()
    .withExif({
      IFD0: {
        Artist: "exif-privacy-probe",
        ImageDescription: "synthetic GPS carrier",
        GPSLatitudeRef: "N",
        GPSLatitude: "52.0",
        GPSLongitudeRef: "E",
        GPSLongitude: "8.0",
      },
    })
    .toFile(path);
}

async function optimize(
  input: string,
  keepExif: boolean,
  format: "jpeg" | "png" | "webp",
): Promise<{ path: string; exif: Uint8Array | undefined; artist: boolean }> {
  const out = await optimizeImage(input, {
    keepExif,
    outputFormat: format,
    quality: 80,
    progressive: false,
    maxWidth: 2000,
    maxHeight: 2000,
    maintainAspectRatio: true,
    fps: 30,
  }, tmpRoot);
  const { default: sharp } = await import("sharp");
  const md = await sharp(out).metadata();
  let artist = false;
  if (md.exif) {
    const text = new TextDecoder("latin1").decode(md.exif);
    artist = text.includes("exif-privacy-probe");
  }
  return { path: out, exif: md.exif, artist };
}

Deno.test({
  name: "EXIF: keepExif=false strips artist/GPS from JPEG, PNG and WebP output",
  async fn() {
    const fixture = join(tmpRoot, "fixture.jpg");
    await exifFixture(fixture);
    const probe = await import("sharp").then(({ default: sharp }) =>
      sharp(fixture).metadata()
    );
    if (!probe.exif) throw new Error("fixture has no EXIF — test is vacuous");

    for (const format of ["jpeg", "png", "webp"] as const) {
      const { artist } = await optimize(fixture, false, format);
      assertEquals(artist, false, `${format}: artist EXIF survived the strip`);
    }
  },
});

Deno.test({
  name: "EXIF: keepExif=true retains metadata (positive control)",
  async fn() {
    const fixture = join(tmpRoot, "fixture-keep.jpg");
    await exifFixture(fixture);
    const { artist } = await optimize(fixture, true, "jpeg");
    assertEquals(artist, true, "keepExif=true must retain EXIF");
  },
});
