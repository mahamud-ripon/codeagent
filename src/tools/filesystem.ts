import fs from "node:fs/promises";
import path from "node:path";
import { resolveInsideRepo } from "../utils/paths.js";
import { TRUNCATION_BUDGETS, truncate } from "../utils/truncate.js";
import { isIgnoredDir, isSecretPath } from "../repo/ignore.js";
import { applyMultiStrategyPatch, validateSyntaxPreFlight } from "./patch.js";

const MAX_LIST_FILES = 5000;

/** Binary-ish extensions mapped to a human-readable category. */
const BINARY_EXTENSIONS = new Map<string, string>([
  // Images
  ["png", "image"], ["jpg", "image"], ["jpeg", "image"], ["gif", "image"],
  ["bmp", "image"], ["webp", "image"], ["ico", "image"], ["tiff", "image"],
  ["tif", "image"], ["avif", "image"], ["heic", "image"], ["psd", "image"],
  // Media
  ["mp3", "media"], ["wav", "media"], ["flac", "media"], ["ogg", "media"],
  ["m4a", "media"], ["mp4", "media"], ["avi", "media"], ["mov", "media"],
  ["mkv", "media"], ["webm", "media"], ["wmv", "media"],
  // Archives, executables, fonts, office documents, databases
  ["zip", "binary"], ["tar", "binary"], ["gz", "binary"], ["bz2", "binary"],
  ["7z", "binary"], ["rar", "binary"], ["exe", "binary"], ["dll", "binary"],
  ["so", "binary"], ["dylib", "binary"], ["bin", "binary"], ["iso", "binary"],
  ["jar", "binary"], ["class", "binary"], ["wasm", "binary"], ["pdf", "binary"],
  ["doc", "binary"], ["docx", "binary"], ["xls", "binary"], ["xlsx", "binary"],
  ["ppt", "binary"], ["pptx", "binary"], ["ttf", "binary"], ["otf", "binary"],
  ["woff", "binary"], ["woff2", "binary"], ["eot", "binary"],
  ["sqlite", "binary"], ["db", "binary"],
]);

function binaryFileError(relative: string, category: string): Error {
  return new Error(
    `Cannot read ${relative}: ${category} file. This agent only handles text files — ` +
      `the current model cannot view images or binary content. If the task depends on ` +
      `this file's contents, tell the user it cannot be inspected here.`,
  );
}

/**
 * Rejects files that cannot be meaningfully consumed as text: known binary /
 * image / media extensions, plus a NUL-byte content sniff (first 8 KB) that
 * catches extensionless binaries. Reading these as UTF-8 would only inject
 * garbage into the model context.
 */
async function assertNotBinary(absolute: string, relative: string): Promise<void> {
  const ext = path.extname(absolute).toLowerCase().replace(/^\./, "");
  const category = BINARY_EXTENSIONS.get(ext);
  if (category) {
    throw binaryFileError(relative, category);
  }
  const fh = await fs.open(absolute, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, bytesRead).includes(0)) {
      throw binaryFileError(relative, "binary");
    }
  } finally {
    await fh.close();
  }
}

function assertNotSecret(repoRelative: string): void {
  if (isSecretPath(repoRelative)) {
    throw new Error(
      `Refusing to access potential secret file: ${repoRelative}`,
    );
  }
}

export async function listFiles(repoRoot: string, relative = "."): Promise<string> {
  const root = path.resolve(repoRoot);
  const startDir = resolveInsideRepo(root, relative);

  let stat;
  try {
    stat = await fs.stat(startDir);
  } catch {
    throw new Error(`Path does not exist: ${relative}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${relative}`);
  }

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_LIST_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnoredDir(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        results.push(path.relative(root, full).split(path.sep).join("/"));
      }
      if (results.length >= MAX_LIST_FILES) return;
    }
  }

  await walk(startDir);

  const out = results.join("\n");
  return truncate(out, TRUNCATION_BUDGETS.listFiles);
}

export async function readFile(repoRoot: string, filePath: string): Promise<string> {
  assertNotSecret(filePath);
  const absolute = resolveInsideRepo(repoRoot, filePath);

  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
  // 1 MB hard cap before even decoding — binary / huge files rejected early.
  if (stat.size > 1_000_000) {
    throw new Error(
      `${filePath} is too large (${stat.size} bytes). Refine your approach instead of reading it whole.`,
    );
  }

  await assertNotBinary(absolute, filePath);
  const content = await fs.readFile(absolute, "utf8");
  return truncate(content, TRUNCATION_BUDGETS.fileRead);
}

export interface ViewFileOptions {
  startLine?: number;
  endLine?: number;
}

export async function viewFile(
  repoRoot: string,
  filePath: string,
  options?: ViewFileOptions,
): Promise<string> {
  assertNotSecret(filePath);
  const absolute = resolveInsideRepo(repoRoot, filePath);

  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
  if (stat.size > 2_000_000) {
    throw new Error(
      `${filePath} is too large (${stat.size} bytes). Refine your approach or view specific line ranges.`,
    );
  }

  await assertNotBinary(absolute, filePath);
  const raw = await fs.readFile(absolute, "utf8");
  const lines = raw.split(/\r?\n/);
  const total = lines.length;

  const start = Math.max(1, options?.startLine ?? 1);
  const end = Math.min(total, options?.endLine ?? total);

  if (start > total) {
    return `[File: ${filePath} (${total} total lines)] (start_line ${start} is beyond end of file)`;
  }

  const selected = lines.slice(start - 1, end);
  const maxLineDigits = String(end).length;

  const numbered = selected.map((line, idx) => {
    const lineNum = String(start + idx).padStart(maxLineDigits, " ");
    return `${lineNum} | ${line}`;
  });

  const header = `[File: ${filePath} (lines ${start}-${end} of ${total})]`;
  return `${header}\n${numbered.join("\n")}`;
}

export async function writeFile(
  repoRoot: string,
  filePath: string,
  content: string,
): Promise<string> {
  assertNotSecret(filePath);
  if (content.length > 500_000) {
    throw new Error("Content too large (500k char limit). Write smaller files.");
  }
  validateSyntaxPreFlight(content, filePath);
  const absolute = resolveInsideRepo(repoRoot, filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
  return `Wrote ${filePath}`;
}

export async function editFile(
  repoRoot: string,
  filePath: string,
  oldText: string,
  newText: string,
): Promise<string> {
  assertNotSecret(filePath);
  const absolute = resolveInsideRepo(repoRoot, filePath);

  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
  await assertNotBinary(absolute, filePath);
  const content = await fs.readFile(absolute, "utf8");

  const { updated, strategy } = applyMultiStrategyPatch(content, oldText, newText, filePath);
  await fs.writeFile(absolute, updated, "utf8");
  return `Edited ${filePath} (strategy: ${strategy})`;
}
