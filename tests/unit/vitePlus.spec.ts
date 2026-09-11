import { deepStrictEqual, rejects, strictEqual } from "assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { mock } from "node:test";
import { commands, ConfigurationTarget, Uri, window, workspace } from "vscode";
import { ConfigService } from "../../client/ConfigService";
import { WORKSPACE_FOLDER, WORKSPACE_SECOND_FOLDER } from "../test-helpers";

suite("Vite+ server selection", () => {
  const root = path.join(WORKSPACE_FOLDER.uri.fsPath, "vite-plus-tests");
  const secondRoot =
    WORKSPACE_SECOND_FOLDER && path.join(WORKSPACE_SECOND_FOLDER.uri.fsPath, "vite-plus-tests");
  const conf = workspace.getConfiguration("oxc", WORKSPACE_FOLDER.uri);
  const originalPath = process.env.PATH;
  let service: ConfigService;

  function file(relative: string, content = "", dir = root): string {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  }

  function declare(dir = root) {
    file("package.json", JSON.stringify({ devDependencies: { "vite-plus": "latest" } }), dir);
  }

  function shim(dir = root) {
    return file(
      path.join("node_modules/.bin", process.platform === "win32" ? "vp.cmd" : "vp"),
      "",
      dir,
    );
  }

  async function open(dir = root) {
    await window.showTextDocument(Uri.file(file("index.txt", "", dir)));
  }

  setup(async () => {
    file("pnpm-workspace.yaml");
    await open();
    service = new ConfigService();
  });

  teardown(async () => {
    service.dispose();
    mock.restoreAll();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await commands.executeCommand("workbench.action.closeAllEditors");
    for (const folder of [WORKSPACE_FOLDER, WORKSPACE_SECOND_FOLDER]) {
      if (!folder) continue;
      const config = workspace.getConfiguration("oxc", folder.uri);
      // oxlint-disable-next-line no-await-in-loop -- reset each workspace folder
      await Promise.all(
        ["path.vp", "vitePlus.enable"].map((key) =>
          config.update(key, undefined, ConfigurationTarget.WorkspaceFolder),
        ),
      );
    }
    await workspace.getConfiguration("oxc").update("path.oxlint", undefined);
    await workspace.getConfiguration("oxc").update("path.oxfmt", undefined);
    rmSync(root, { recursive: true, force: true });
    if (secondRoot) rmSync(secondRoot, { recursive: true, force: true });
  });

  test("uses vp lint/fmt for an active nested package", async () => {
    declare();
    const vpPath = shim();
    const [lint, fmt] = await Promise.all([
      service.getOxlintServerBinPath(),
      service.getOxfmtServerBinPath(),
    ]);
    deepStrictEqual(lint, { path: vpPath, loader: "native", cwd: root, vitePlus: "lint" });
    deepStrictEqual(fmt, { path: vpPath, loader: "native", cwd: root, vitePlus: "fmt" });
  });

  test("explicit enable works without a package.json dependency", async () => {
    const vpPath = shim();
    await conf.update("vitePlus.enable", true, ConfigurationTarget.WorkspaceFolder);
    strictEqual((await service.getOxlintServerBinPath())?.path, vpPath);
    strictEqual((await service.getOxfmtServerBinPath())?.vitePlus, "fmt");
  });

  test("an explicit vp path opts in and resolves against the workspace folder", async () => {
    const vpPath = file("bin/custom-vp.js");
    await conf.update(
      "path.vp",
      "./vite-plus-tests/bin/custom-vp.js",
      ConfigurationTarget.WorkspaceFolder,
    );
    deepStrictEqual(await service.getOxlintServerBinPath(), {
      path: vpPath,
      loader: "node",
      cwd: WORKSPACE_FOLDER.uri.fsPath,
      vitePlus: "lint",
    });
    await commands.executeCommand("workbench.action.closeAllEditors");
    strictEqual(
      (await service.getOxfmtServerBinPath())?.path,
      vpPath,
      "uses workspace folders when no document is active",
    );
  });

  test("recognizes the extensionless vite-plus JavaScript entry point", async () => {
    const vpPath = file("node_modules/vite-plus/bin/vp");
    await conf.update("path.vp", vpPath, ConfigurationTarget.WorkspaceFolder);
    strictEqual((await service.getOxfmtServerBinPath())?.loader, "node");
  });

  test("invalid explicit vp paths give an error instead of falling back", async () => {
    declare();
    shim();
    await conf.update("path.vp", "./missing-vp", ConfigurationTarget.WorkspaceFolder);
    await rejects(service.getOxlintServerBinPath(), /Invalid Vite\+ binary.*oxc.path.vp/);
    await conf.update("path.vp", "../unsafe-vp", ConfigurationTarget.WorkspaceFolder);
    await rejects(service.getOxfmtServerBinPath(), /Invalid Vite\+ binary/);
  });

  test("explicit tool paths take priority over Vite+ for each tool", async () => {
    declare();
    shim();
    const lintPath = file("custom/oxlint.js");
    const fmtPath = file("custom/oxfmt.js");
    await workspace.getConfiguration("oxc").update("path.oxlint", lintPath);
    strictEqual((await service.getOxlintServerBinPath())?.path, lintPath);
    strictEqual((await service.getOxlintServerBinPath())?.vitePlus, undefined);
    strictEqual((await service.getOxfmtServerBinPath())?.vitePlus, "fmt");
    await workspace.getConfiguration("oxc").update("path.oxfmt", fmtPath);
    strictEqual((await service.getOxfmtServerBinPath())?.path, fmtPath);
    strictEqual((await service.getOxfmtServerBinPath())?.vitePlus, undefined);
  });

  test("false disables automatic detection and an explicit vp path", async () => {
    declare();
    const vpPath = shim();
    await conf.update("path.vp", vpPath, ConfigurationTarget.WorkspaceFolder);
    await conf.update("vitePlus.enable", false, ConfigurationTarget.WorkspaceFolder);
    strictEqual((await service.getOxlintServerBinPath())?.vitePlus, undefined);
    strictEqual((await service.getOxfmtServerBinPath())?.vitePlus, undefined);
  });

  test("root-declared-no-local-global-on-path", async () => {
    declare();
    const binDir = path.join(root, "global-bin");
    const vpPath = file(process.platform === "win32" ? "vp.cmd" : "vp", "", binDir);
    process.env.PATH = binDir;
    deepStrictEqual(await service.getOxlintServerBinPath(), {
      path: vpPath,
      loader: "native",
      cwd: root,
      vitePlus: "lint",
    });
    const localPath = shim();
    strictEqual(
      (await service.getOxlintServerBinPath())?.path,
      localPath,
      "local install must take priority after a restart",
    );
  });

  test("global-vp-without-declaration", async () => {
    const binDir = path.join(root, "global-bin");
    file(process.platform === "win32" ? "vp.cmd" : "vp", "", binDir);
    process.env.PATH = binDir;
    strictEqual((await service.getOxlintServerBinPath())?.vitePlus, undefined);
    strictEqual((await service.getOxfmtServerBinPath())?.vitePlus, undefined);
    await conf.update("vitePlus.enable", true, ConfigurationTarget.WorkspaceFolder);
    strictEqual(
      (await service.getOxlintServerBinPath())?.vitePlus,
      "lint",
      "explicit opt-in permits global resolution without a dependency",
    );
  });

  test("missing local and global installs give an install hint, even if plain tools exist", async () => {
    declare();
    process.env.PATH = root;
    mock.method(require("node:child_process"), "spawnSync", () => ({ status: 1 }));
    mock.method(require("node:os"), "homedir", () => root);
    await rejects(service.getOxlintServerBinPath(), /Vite\+ selected.*pnpm install/);
    await rejects(service.getOxfmtServerBinPath(), /Vite\+ selected.*pnpm install/);
    const vpPath = shim();
    strictEqual(
      (await service.getOxlintServerBinPath())?.path,
      vpPath,
      "missing installs must not be cached",
    );
  });

  test("resolves vp from a global vite-plus package, not a package named vp", async () => {
    declare();
    process.env.PATH = root;
    const globalModules = path.join(root, "global/node_modules");
    file(
      "vite-plus/package.json",
      JSON.stringify({ name: "vite-plus", bin: { vp: "bin/vp" } }),
      globalModules,
    );
    const vpPath = file("vite-plus/bin/vp", "", globalModules);
    mock.method(require("node:child_process"), "spawnSync", () => ({
      status: 0,
      stdout: globalModules,
    }));
    deepStrictEqual(await service.getOxfmtServerBinPath(), {
      path: vpPath,
      loader: "node",
      cwd: root,
      vitePlus: "fmt",
    });
  });

  test("reselects when navigating between Vite+ and plain workspace folders", async function () {
    if (!secondRoot) this.skip();
    declare();
    const vpPath = shim();
    strictEqual((await service.getOxlintServerBinPath())?.path, vpPath);
    file("pnpm-workspace.yaml", "", secondRoot!);
    await open(secondRoot!);
    strictEqual((await service.getOxlintServerBinPath())?.vitePlus, undefined);
    await open();
    strictEqual((await service.getOxlintServerBinPath())?.path, vpPath);
  });

  test("explicit settings are scoped to the active workspace folder", async function () {
    if (!secondRoot || !WORKSPACE_SECOND_FOLDER) this.skip();
    const firstPath = file("bin/vp.js");
    const secondPath = file("bin/vp.js", "", secondRoot!);
    await conf.update(
      "path.vp",
      "./vite-plus-tests/bin/vp.js",
      ConfigurationTarget.WorkspaceFolder,
    );
    await workspace
      .getConfiguration("oxc", WORKSPACE_SECOND_FOLDER!.uri)
      .update("path.vp", "./vite-plus-tests/bin/vp.js", ConfigurationTarget.WorkspaceFolder);
    strictEqual((await service.getOxlintServerBinPath())?.path, firstPath);
    await open(secondRoot!);
    strictEqual((await service.getOxlintServerBinPath())?.path, secondPath);
    strictEqual((await service.getOxfmtServerBinPath())?.cwd, WORKSPACE_SECOND_FOLDER!.uri.fsPath);
  });
});
