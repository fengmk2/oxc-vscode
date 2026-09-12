import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import * as path from "node:path";

const nodeShebangPattern = /^#!\s*(?:\S*\/node|\S*\/env\s+(?:-S\s+)?node)(?:\s|$)/;

function readShebang(file: string): string {
  const fd = openSync(file, "r");
  try {
    // A standalone native vp can be large; only read its header.
    const buffer = Buffer.alloc(256);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, length).split(/\r?\n/, 1)[0];
  } finally {
    closeSync(fd);
  }
}

/** Resolve Node entry points without interpreting shell shims or native vp binaries as JS. */
export function resolveVitePlusNodeEntry(vpPath: string): string | undefined {
  try {
    const shebang = readShebang(vpPath);
    if (nodeShebangPattern.test(shebang)) {
      return vpPath;
    }

    const isCmd = path.extname(vpPath) === ".cmd";
    if (!isCmd && !/^#!.*(?:\/|\s)(?:sh|bash|dash|zsh|ksh)(?:\s|$)/.test(shebang)) {
      return undefined;
    }

    // Read the literal target used by npm/pnpm shims, including custom global directories.
    // Do not execute the shim or expand shell variables to locate the entry.
    const shim = readFileSync(vpPath, "utf8");
    const target = isCmd
      ? /"%(?:~dp0|dp0%)[\\/]([^"\r\n]+)"[ \t]+%\*/.exec(shim)
      : /"\$basedir\/([^"\r\n]+)"[ \t]+"\$@"/.exec(shim);
    const binDir = path.dirname(vpPath);
    let nodeEntry: string | undefined;
    if (target) {
      const relativeTarget = isCmd ? target[1].replaceAll("\\", path.sep) : target[1];
      nodeEntry = path.resolve(binDir, relativeTarget);
    } else if (path.basename(binDir) === ".bin") {
      nodeEntry = path.resolve(binDir, "..", "vite-plus", "bin", "vp");
    } else if (isCmd) {
      nodeEntry = path.join(binDir, "node_modules", "vite-plus", "bin", "vp");
    }

    if (nodeEntry && nodeShebangPattern.test(readShebang(nodeEntry))) {
      return nodeEntry;
    }
  } catch {
    // An absent or unreadable entry must leave the original executable intact.
  }
  return undefined;
}
