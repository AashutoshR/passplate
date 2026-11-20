import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError } from "../errors";

/**
 * Dish photos uploaded in the menu editor. Files are named by a hash of their
 * bytes, so a name never changes meaning and can be cached for a year by
 * browsers and the CDN (NFR-17). The type is read from the bytes, never from
 * the file name or the browser's claim.
 */

export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
export const MEDIA_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

export function uploadDir(): string {
  return resolve(process.env.UPLOAD_DIR ?? join(import.meta.dir, "../../../../var/uploads"));
}

function sniff(bytes: Uint8Array): "jpg" | "png" | "webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

export async function saveUpload(file: File, dir = uploadDir()): Promise<{ path: string }> {
  if (file.size === 0) throw new AppError(400, "empty_file", "That file is empty");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError(413, "too_large", "Photos can be up to 3 MB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = sniff(bytes);
  if (!ext) throw new AppError(415, "not_an_image", "Upload a JPEG, PNG or WebP photo");
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`;
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, name), bytes);
  return { path: `/api/v1/media/${name}` };
}

const TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;

export function mediaFile(name: string, dir = uploadDir()): { file: ReturnType<typeof Bun.file>; type: string } {
  if (!MEDIA_NAME.test(name)) throw new AppError(404, "not_found", "Not found");
  const ext = name.split(".").pop() as keyof typeof TYPES;
  return { file: Bun.file(join(dir, name)), type: TYPES[ext] };
}
