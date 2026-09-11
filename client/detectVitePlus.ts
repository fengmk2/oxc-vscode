import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

export interface VitePlusProject {
  /** The ancestor that declares vite-plus, or the explicitly enabled directory. */
  root: string;
  /** Undefined means Vite+ is selected but is not installed locally. */
  vpPath?: string;
}

interface PackageJson {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  workspaces?: unknown;
}

function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function isRootWorkspace(dir: string, pkg: PackageJson | null): boolean {
  return (
    existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
    existsSync(path.join(dir, "lerna.json")) ||
    Boolean(pkg?.workspaces)
  );
}

/**
 * Implements Phases 1 and 2 of the editor detection RFC. The bound is the
 * monorepo root, which can be above the folder opened in the editor.
 * Global lookup belongs to the caller and must only run for a non-null result.
 * https://github.com/voidzero-dev/vite-plus/pull/1614
 */
export function detectVitePlusProject(start: string, enabled = false): VitePlusProject | null {
  let dir = path.resolve(start);
  try {
    if (statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    // The caller can also pass a directory that does not exist yet.
  }

  let pkg = readPackageJson(dir);
  if (!enabled) {
    while (!pkg?.dependencies?.["vite-plus"] && !pkg?.devDependencies?.["vite-plus"]) {
      if (isRootWorkspace(dir, pkg) || dir === path.dirname(dir)) return null;
      dir = path.dirname(dir);
      pkg = readPackageJson(dir);
    }
  }

  const root = dir;
  while (true) {
    const vpPath = path.join(
      dir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "vp.cmd" : "vp",
    );
    if (existsSync(vpPath)) return { root, vpPath };
    if (isRootWorkspace(dir, pkg) || dir === path.dirname(dir)) return { root };
    dir = path.dirname(dir);
    pkg = readPackageJson(dir);
  }
}

export class VitePlusError extends Error {}
