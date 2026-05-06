// File-explorer service — answers `directoryListingRequest`,
// `fileContentRequest`, `fileWriteRequest`, `fileSearchRequest` from
// the iPhone. Every path is normalised against the daemon's
// `projectRoot` so an iPhone can't traverse out (`..` segments are
// resolved server-side; anything that lands outside the root is
// rejected). Mirrors the Mac's filesystem service one-for-one — same
// payload shapes, same MIME conventions, same `binary` fallback for
// non-UTF8 bytes.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  DirectoryEntry,
  DirectoryListingResponsePayload,
  FileContentResponsePayload,
  FileWriteResponsePayload,
  FileSearchHit,
  FileSearchResponsePayload,
} from "./protocol.js";

export class FilesService {
  constructor(private readonly projectRoot: string) {}

  /** Resolve an iPhone-supplied relative path against `projectRoot`,
   *  with `..` traversal blocked. Returns absolute path on success,
   *  `null` if it would escape the root. Empty string = project root
   *  itself. */
  private resolveInRoot(relativePath: string): string | null {
    const cleaned = relativePath.startsWith("/")
      ? path.normalize(relativePath)
      : path.normalize(path.join(this.projectRoot, relativePath));
    const root = path.normalize(this.projectRoot) + path.sep;
    if (cleaned === path.normalize(this.projectRoot) || cleaned.startsWith(root)) {
      return cleaned;
    }
    return null;
  }

  // ---- directory listing ----

  async listDirectory(args: {
    requestId: string;
    relativePath: string;
  }): Promise<DirectoryListingResponsePayload> {
    const abs = this.resolveInRoot(args.relativePath);
    if (!abs) {
      return {
        requestId: args.requestId,
        relativePath: args.relativePath,
        entries: [],
        error: "Path is outside the project root.",
      };
    }
    try {
      const dirents = await fs.readdir(abs, { withFileTypes: true });
      const entries: DirectoryEntry[] = await Promise.all(
        dirents
          .filter((d) => !d.name.startsWith("."))
          .map(async (d) => {
            const full = path.join(abs, d.name);
            let sizeBytes = 0;
            if (d.isFile()) {
              try {
                const st = await fs.stat(full);
                sizeBytes = Number(st.size);
              } catch { /* unreadable, leave 0 */ }
            }
            return {
              name: d.name,
              isDirectory: d.isDirectory(),
              sizeBytes,
            };
          }),
      );
      // Sort: directories first, alphabetical within group — same as
      // the Mac's listing for visual consistency on iPhone.
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        requestId: args.requestId,
        relativePath: args.relativePath,
        entries,
        error: null,
      };
    } catch (err) {
      return {
        requestId: args.requestId,
        relativePath: args.relativePath,
        entries: [],
        error: errorMessage(err),
      };
    }
  }

  // ---- file read ----

  async readFile(args: {
    requestId: string;
    relativePath: string;
    maxBytes: number;
  }): Promise<FileContentResponsePayload> {
    const abs = this.resolveInRoot(args.relativePath);
    if (!abs) {
      return notFoundFile(args, "Path is outside the project root.");
    }
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        return notFoundFile(args, "Path is a directory.");
      }
      const cap = Math.max(1, Math.min(args.maxBytes, 8 * 1024 * 1024));
      const truncated = st.size > cap;
      const buf = await readBytes(abs, cap);
      const mimeType = guessMime(abs);
      // UTF-8 round-trip detection: if decoding gives mojibake (the
      // Buffer contains a 0x00 byte or invalid surrogate pair), bail
      // to base64 so the iPhone can decide what to do with it.
      const looksBinary = bufferLooksBinary(buf);
      if (looksBinary) {
        return {
          requestId: args.requestId,
          relativePath: args.relativePath,
          mimeType,
          utf8Text: null,
          binary: buf.toString("base64"),
          truncated,
          error: null,
        };
      }
      return {
        requestId: args.requestId,
        relativePath: args.relativePath,
        mimeType,
        utf8Text: buf.toString("utf8"),
        binary: null,
        truncated,
        error: null,
      };
    } catch (err) {
      return notFoundFile(args, errorMessage(err));
    }
  }

  // ---- file write ----

  async writeFile(args: {
    requestId: string;
    /** Either an absolute path or a path relative to the project root. */
    path: string;
    utf8Text: string;
  }): Promise<FileWriteResponsePayload> {
    const abs = this.resolveInRoot(args.path);
    if (!abs) {
      return {
        requestId: args.requestId,
        path: args.path,
        success: false,
        error: "Path is outside the project root.",
      };
    }
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.utf8Text, "utf8");
      return {
        requestId: args.requestId,
        path: args.path,
        success: true,
        error: null,
      };
    } catch (err) {
      return {
        requestId: args.requestId,
        path: args.path,
        success: false,
        error: errorMessage(err),
      };
    }
  }

  // ---- search ----

  /** Recursive name + optional content search. Bounds itself at
   *  `maxResults` and skips the usual noisy directories
   *  (`node_modules`, `.git`, build outputs) so the iPhone gets a
   *  useful list back in <1s on most repos. */
  async search(args: {
    requestId: string;
    rootPath: string;
    query: string;
    maxResults: number;
    searchContent: boolean;
  }): Promise<FileSearchResponsePayload> {
    const root = this.resolveInRoot(args.rootPath) ?? this.projectRoot;
    const limit = Math.max(1, Math.min(args.maxResults, 1000));
    const q = args.query.trim();
    if (q.length === 0) {
      return {
        requestId: args.requestId,
        query: args.query,
        hits: [],
        truncated: false,
        error: null,
      };
    }
    const lower = q.toLowerCase();
    const hits: FileSearchHit[] = [];
    let truncated = false;
    const maxFiles = 5000;
    let visited = 0;

    const walk = async (dir: string): Promise<void> => {
      if (hits.length >= limit) { truncated = true; return; }
      let dirents: import("node:fs").Dirent[] = [];
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (hits.length >= limit) { truncated = true; return; }
        if (visited > maxFiles) { truncated = true; return; }
        if (shouldSkip(d.name)) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (d.name.toLowerCase().includes(lower)) {
            hits.push({ path: full, isDirectory: true, lineNumber: null, snippet: null });
          }
          await walk(full);
        } else if (d.isFile()) {
          visited += 1;
          if (d.name.toLowerCase().includes(lower)) {
            hits.push({ path: full, isDirectory: false, lineNumber: null, snippet: null });
            continue;
          }
          if (args.searchContent && isLikelyTextByName(d.name)) {
            try {
              const st = await fs.stat(full);
              if (st.size > 512 * 1024) continue; // skip large files
              const text = await fs.readFile(full, "utf8");
              const idx = text.toLowerCase().indexOf(lower);
              if (idx >= 0) {
                const lines = text.slice(0, idx).split("\n");
                const lineNumber = lines.length;
                const lineStart = idx - (lines[lines.length - 1]?.length ?? 0);
                const lineEnd = text.indexOf("\n", idx);
                const snippet = text
                  .slice(lineStart, lineEnd === -1 ? Math.min(text.length, idx + 80) : lineEnd)
                  .trim()
                  .slice(0, 160);
                hits.push({ path: full, isDirectory: false, lineNumber, snippet });
              }
            } catch { /* unreadable, skip */ }
          }
        }
      }
    };

    try {
      await walk(root);
      return {
        requestId: args.requestId,
        query: args.query,
        hits,
        truncated,
        error: null,
      };
    } catch (err) {
      return {
        requestId: args.requestId,
        query: args.query,
        hits,
        truncated,
        error: errorMessage(err),
      };
    }
  }
}

// ---------- helpers ----------

function notFoundFile(
  args: { requestId: string; relativePath: string },
  error: string,
): FileContentResponsePayload {
  return {
    requestId: args.requestId,
    relativePath: args.relativePath,
    mimeType: "application/octet-stream",
    utf8Text: null,
    binary: null,
    truncated: false,
    error,
  };
}

async function readBytes(absPath: string, cap: number): Promise<Buffer> {
  const handle = await fs.open(absPath, "r");
  try {
    const buf = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buf, 0, cap, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function bufferLooksBinary(buf: Buffer): boolean {
  // Sample the first 4KB. Any 0x00 byte or run of non-UTF8 sequences
  // gets the file flagged as binary so we ship base64 instead of
  // mojibake.
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  // Cheap UTF-8 validity round-trip — a binary blob will produce
  // replacement chars, which encode back to ≥3-byte sequences and
  // change the byte length.
  const decoded = sample.toString("utf8");
  const reencoded = Buffer.from(decoded, "utf8");
  if (reencoded.length !== sample.length) return true;
  return false;
}

function guessMime(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  const map: Record<string, string> = {
    ".swift": "text/x-swift",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".yml": "text/yaml",
    ".yaml": "text/yaml",
    ".toml": "application/toml",
    ".rs": "text/rust",
    ".py": "text/x-python",
    ".rb": "text/x-ruby",
    ".go": "text/x-go",
    ".sh": "application/x-sh",
    ".html": "text/html",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
  };
  return map[ext] ?? "text/plain";
}

function isLikelyTextByName(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  const text = new Set([
    ".swift", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".json", ".md", ".markdown", ".yml", ".yaml", ".toml",
    ".rs", ".py", ".rb", ".go", ".sh", ".bash", ".zsh",
    ".html", ".css", ".scss", ".sass", ".vue", ".svelte",
    ".txt", ".env", ".gitignore", ".gitattributes",
    ".c", ".h", ".cpp", ".hpp", ".m", ".mm",
    ".kt", ".kts", ".java", ".scala", ".clj", ".lua", ".pl", ".php",
    ".sql", ".graphql", ".dockerfile",
  ]);
  if (text.has(ext)) return true;
  // Files without an extension that match common CI/config names.
  const lc = name.toLowerCase();
  if (["readme", "license", "makefile", "dockerfile", "rakefile",
       "package.json", ".eslintrc", ".prettierrc"].includes(lc)) return true;
  return false;
}

function shouldSkip(name: string): boolean {
  const skipDirs = new Set([
    "node_modules", ".git", ".svn", ".hg",
    "dist", "build", "out", "target", ".next", ".nuxt", ".turbo",
    "DerivedData", ".build", ".swiftpm",
    "__pycache__", ".venv", "venv", ".tox",
    ".gradle", ".idea", ".vscode",
  ]);
  return skipDirs.has(name);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Keep `fsSync` import used so esbuild/tsc don't drop it on tree-shake;
// callers may inline a sync stat in future.
function _unused() { return fsSync; }
