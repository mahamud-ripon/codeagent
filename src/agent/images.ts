import fs from "node:fs/promises";
import path from "node:path";
import { resolveInsideRepo } from "../utils/paths.js";

/** AG-15: image input (@image.png) for vision models. */

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

export function extractImageMentions(text: string): string[] {
  const out: string[] = [];
  const re = /@([^\s"'`]+(?:\.png|\.jpg|\.jpeg|\.gif|\.webp))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]!);
  }
  return out;
}

export interface ImageBlock { path: string; mediaType: string; base64: string }

function mediaTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "image/png";
  }
}

/** Load @-mentioned images as base64 blocks (max 5, 8MB each). Skips missing/non-images. */
export async function loadImageBlocks(repoRoot: string, text: string, limit = 5): Promise<ImageBlock[]> {
  const mentions = extractImageMentions(text).slice(0, limit);
  const blocks: ImageBlock[] = [];
  for (const rel of mentions) {
    if (!isImagePath(rel)) continue;
    try {
      const abs = resolveInsideRepo(repoRoot, rel);
      const buf = await fs.readFile(abs);
      if (buf.length > 8 * 1024 * 1024) continue;
      blocks.push({ path: rel, mediaType: mediaTypeFor(path.extname(rel)), base64: buf.toString("base64") });
    } catch {
      // missing/unreadable — the model gets the @mention text only
    }
  }
  return blocks;
}
