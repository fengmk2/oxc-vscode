import { closeSync, openSync, readSync } from "node:fs";
import * as path from "node:path";

/** Resolve Node entry points without interpreting shell shims or native vp binaries as JS. */
export function resolveVitePlusNodeEntry(vpPath: string): string | undefined {
  const binDir = path.dirname(vpPath);
  const candidates = [vpPath];
  if (path.basename(binDir) === ".bin") {
    // pnpm and Windows npm shims sit next to the installed package.
    candidates.push(path.resolve(binDir, "..", "vite-plus", "bin", "vp"));
  } else if (path.extname(vpPath) === ".cmd") {
    // Global npm shims on Windows sit next to node_modules.
    candidates.push(path.join(binDir, "node_modules", "vite-plus", "bin", "vp"));
  }

  for (const candidate of candidates) {
    let fd: number | undefined;
    try {
      fd = openSync(candidate, "r");
      // Read only the shebang: a standalone native vp can be a large file.
      const buffer = Buffer.alloc(256);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      const shebang = buffer.toString("utf8", 0, length).split(/\r?\n/, 1)[0];
      if (/^#!\s*(?:\S*\/node|\S*\/env\s+(?:-S\s+)?node)(?:\s|$)/.test(shebang)) return candidate;
      if (
        candidate === vpPath &&
        path.extname(vpPath) !== ".cmd" &&
        !/^#!.*(?:\/|\s)(?:sh|bash|dash|zsh|ksh)(?:\s|$)/.test(shebang)
      ) {
        // A native vp in .bin must not be replaced by an adjacent JS package.
        return undefined;
      }
    } catch {
      // The candidate is absent or unreadable; keep the original executable.
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return undefined;
}
