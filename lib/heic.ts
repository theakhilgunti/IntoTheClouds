/** Detect / convert Apple HEIC·HEIF uploads so the home photo picker works in Chromium. */

export function isHeicFile(file: File): boolean {
  const t = (file.type || "").toLowerCase();
  const n = file.name.toLowerCase();
  return (
    t === "image/heic" ||
    t === "image/heif" ||
    t === "image/heic-sequence" ||
    t === "image/heif-sequence" ||
    n.endsWith(".heic") ||
    n.endsWith(".heif")
  );
}

/** True for normal raster uploads plus HEIC/HEIF (which often arrive with an empty MIME). */
export function isImageUpload(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return isHeicFile(file) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name);
}

/**
 * Return a JPEG File browsers can decode / upload.
 * Non-HEIC files are returned unchanged. EXIF may be stripped — read GPS from the
 * original HEIC with exifr before calling this.
 */
export async function toJpegFile(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;
  const heic2any = (await import("heic2any")).default as (opts: {
    blob: Blob;
    toType?: string;
    quality?: number;
  }) => Promise<Blob | Blob[]>;
  const result = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
  const blob = Array.isArray(result) ? result[0]! : result;
  const base = file.name.replace(/\.(heic|heif)$/i, "") || "photo";
  return new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
}
