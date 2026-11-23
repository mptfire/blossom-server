/**
 * Image optimization using npm:sharp.
 * Handles JPEG, PNG, WebP (static) and animated GIF → animated WebP.
 *
 * sharp is loaded lazily via dynamic import so it is never required when the
 * media endpoint is disabled.
 */

import type { ImageOptimizeConfig } from "../config/schema.ts";

export type { ImageOptimizeConfig as ImageOptimizeOptions };

/**
 * Optimizes a static image (JPEG/PNG/WebP) using sharp.
 * Returns the path to the optimized temp file.
 * Caller is responsible for deleting the output file on any error.
 */
export async function optimizeImage(
  inputPath: string,
  opts: ImageOptimizeConfig,
  tmpDir: string,
): Promise<string> {
  const { default: sharp } = await import("sharp");
  const outputPath = await Deno.makeTempFile({
    dir: tmpDir,
    suffix: `.${opts.outputFormat}`,
  });

  // rotate() normalizes orientation so we can safely strip EXIF
  let pipeline = sharp(inputPath).rotate();

  if (opts.keepExif) {
    // Intentional retention: preserve all metadata (GPS, artist, …)
    pipeline = pipeline.withMetadata();
  }
  // keepExif=false: call withMetadata() NOT AT ALL — sharp strips every
  // metadata block (EXIF, XMP, IPTC) by default. The previous
  // `withMetadata({ exif: {} })` RETAINED the existing EXIF: the empty
  // overlay merges on top of the original blocks, so GPS coordinates and
  // artist fields survived the "strip" (r8c senior review, privacy defect).

  // Resize to fit inside the bounding box without upscaling
  pipeline = pipeline.resize(opts.maxWidth, opts.maxHeight, {
    fit: "inside",
    withoutEnlargement: true,
  });

  // Encode to target format
  switch (opts.outputFormat) {
    case "webp":
      pipeline = pipeline.webp({ quality: opts.quality });
      break;
    case "jpeg":
      pipeline = pipeline.jpeg({
        quality: opts.quality,
        progressive: opts.progressive,
      });
      break;
    case "png":
      pipeline = pipeline.png({
        quality: opts.quality,
        progressive: opts.progressive,
      });
      break;
  }

  await pipeline.toFile(outputPath);
  return outputPath;
}

/**
 * Optimizes an animated GIF using sharp's animated WebP path.
 * When outputFormat is "webp" (default), sharp produces an animated WebP.
 * For other formats the GIF is treated as a static image (first frame).
 * Returns the path to the optimized temp file.
 */
export async function optimizeGif(
  inputPath: string,
  opts: ImageOptimizeConfig,
  tmpDir: string,
): Promise<string> {
  const { default: sharp } = await import("sharp");
  const outputPath = await Deno.makeTempFile({
    dir: tmpDir,
    suffix: `.${opts.outputFormat}`,
  });

  // animated: true preserves all frames
  let pipeline = sharp(inputPath, { animated: true }).rotate();

  if (!opts.keepExif) {
    // keepExif=false: sharp's default is to strip ALL metadata — the GPS
    // and artist blocks are only retained when withMetadata() is called.
  } else {
    pipeline = pipeline.withMetadata();
  }

  pipeline = pipeline.resize(opts.maxWidth, opts.maxHeight, {
    fit: "inside",
    withoutEnlargement: true,
  });

  if (opts.outputFormat === "webp") {
    // delay is per-frame delay in ms — derived from the fps cap.
    // Sharp clamps individual frame delays to this value when they are shorter.
    const delay = Math.round(1000 / opts.fps);
    pipeline = pipeline.webp({ quality: opts.quality, delay });
  } else if (opts.outputFormat === "jpeg") {
    pipeline = pipeline.jpeg({
      quality: opts.quality,
      progressive: opts.progressive,
    });
  } else {
    pipeline = pipeline.png({
      quality: opts.quality,
      progressive: opts.progressive,
    });
  }

  await pipeline.toFile(outputPath);
  return outputPath;
}
