import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

let shimDirectory: string | undefined;

/** Make the bundled runtime available to vp's child processes as `node`. */
export function bundledNodeDirectory(): string {
  if (/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
    return path.dirname(process.execPath);
  }
  if (shimDirectory) return shimDirectory;

  const directory = mkdtempSync(path.join(tmpdir(), "oxc-node-"));
  const isWindows = process.platform === "win32";
  // Invoke Electron at its original location so it can find its resources.
  const script = isWindows
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath.replaceAll("%", "%%")}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`;
  try {
    writeFileSync(path.join(directory, isWindows ? "node.cmd" : "node"), script, { mode: 0o700 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  shimDirectory = directory;
  return directory;
}

export function disposeBundledNode(): void {
  if (shimDirectory) {
    rmSync(shimDirectory, { recursive: true, force: true });
    shimDirectory = undefined;
  }
}
