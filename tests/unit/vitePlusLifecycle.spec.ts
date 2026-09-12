import { deepStrictEqual, ok, strictEqual } from "assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { mock } from "node:test";
import { CancellationTokenSource, ConfigurationTarget, window, workspace } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { ConfigService } from "../../client/ConfigService";
import {
  BinarySearchResult,
  clearGlobalNodeModulesPathsCache,
  searchGlobalNodeModulesBin,
} from "../../client/findBinary";
import StatusBarItemHandler from "../../client/StatusBarItemHandler";
import Formatter from "../../client/tools/formatter";
import Linter from "../../client/tools/linter";
import { WORKSPACE_FOLDER } from "../test-helpers";

for (const [Tool, command, getter] of [
  [Linter, "lint", "getOxlintServerBinPath"],
  [Formatter, "fmt", "getOxfmtServerBinPath"],
] as const) {
  suite(`Vite+ ${command} lifecycle`, () => {
    const root = path.join(WORKSPACE_FOLDER.uri.fsPath, `vp-${command}-lifecycle`);
    let service: ConfigService;
    let tool: Linter | Formatter;
    let output: ReturnType<typeof window.createOutputChannel>;
    let status: StatusBarItemHandler;
    let selected: BinarySearchResult;

    setup(async () => {
      // No server needs to run to exercise client replacement on navigation.
      await workspace.getConfiguration("oxc").update("enable", false);
      mkdirSync(root, { recursive: true });
      const vpPath = path.join(root, "vp.cjs");
      writeFileSync(vpPath, "");
      selected = { path: vpPath, loader: "node", vitePlus: command, cwd: root };
      service = new ConfigService();
      mock.method(service, getter, async () => selected);
      const channel = window.createOutputChannel(`Vite+ ${command} lifecycle`, { log: true });
      output = channel;
      status = new StatusBarItemHandler("test");
      tool = new Tool(channel, service, status);
      await tool.activate(selected);
    });

    teardown(async () => {
      await tool.deactivate();
      tool.dispose();
      service.dispose();
      output.dispose();
      status.dispose();
      mock.restoreAll();
      clearGlobalNodeModulesPathsCache();
      await workspace.getConfiguration("oxc").update("enable", undefined);
      await workspace
        .getConfiguration("oxc", WORKSPACE_FOLDER.uri)
        .update(
          command === "lint" ? "disableNestedConfig" : "fmt.disableNestedConfig",
          undefined,
          ConfigurationTarget.WorkspaceFolder,
        );
      rmSync(root, { recursive: true, force: true });
    });

    for (const userSetting of [false, true]) {
      test(`disables nested configs only for Vite+ with user setting ${userSetting}`, async () => {
        const key = command === "lint" ? "disableNestedConfig" : "fmt.disableNestedConfig";
        const config = workspace.getConfiguration("oxc", WORKSPACE_FOLDER.uri);
        await config.update(key, userSetting, ConfigurationTarget.WorkspaceFolder);
        service.getWorkspaceConfig(WORKSPACE_FOLDER.uri)!.refresh();
        const event = { affectsConfiguration: (section: string) => section === `oxc.${key}` };

        const check = async (expected: boolean) => {
          const client = (tool as unknown as { client: LanguageClient }).client;
          const optionsForWorkspace = (settings: { workspaceUri: string; options: unknown }[]) =>
            settings.find(({ workspaceUri }) => workspaceUri === WORKSPACE_FOLDER.uri.toString())!
              .options;
          const assertOptions = (options: unknown) => {
            const values = options as Record<string, unknown>;
            strictEqual(values[key], expected);
            if (command === "lint") {
              strictEqual(
                (values.flags as Record<string, string>).disable_nested_config,
                String(expected),
              );
            }
          };

          assertOptions(optionsForWorkspace(client.clientOptions.initializationOptions));
          const cancellation = new CancellationTokenSource();
          try {
            const pulled = await client.clientOptions.middleware!.workspace!.configuration!(
              {
                items: [
                  { section: "oxc_language_server", scopeUri: WORKSPACE_FOLDER.uri.toString() },
                  { section: "unrelated", scopeUri: WORKSPACE_FOLDER.uri.toString() },
                  { section: "oxc_language_server" },
                ],
              },
              cancellation.token,
              async () => [],
            );
            ok(Array.isArray(pulled));
            assertOptions(pulled[0]);
            deepStrictEqual(pulled.slice(1), [null, null]);
          } finally {
            cancellation.dispose();
          }

          const running = mock.method(client, "isRunning", () => true);
          const notification = mock.method(client, "sendNotification", async () => {});
          try {
            await tool.onConfigChange(event);
            strictEqual(notification.mock.callCount(), 1);
            const [method, params] = notification.mock.calls[0].arguments;
            strictEqual(method, "workspace/didChangeConfiguration");
            assertOptions(optionsForWorkspace(params.settings));
            assertOptions(optionsForWorkspace(client.clientOptions.initializationOptions));
          } finally {
            running.mock.restore();
            notification.mock.restore();
          }
          strictEqual(
            workspace.getConfiguration("oxc", WORKSPACE_FOLDER.uri).get(key),
            userSetting,
            "the saved setting must not change",
          );
        };

        await check(true);
        const vitePlus = selected;
        selected = { path: selected.path, loader: "node" };
        await tool.restart(true);
        await check(userSetting);
        selected = vitePlus;
        await tool.restart(true);
        await check(true);
      });
    }

    test("keeps the client for unchanged binaries and replaces it when the project or mode changes", async () => {
      const activation = mock.method(tool, "activate", tool.activate.bind(tool));
      await tool.restart(true);
      strictEqual(activation.mock.callCount(), 0);

      selected = { ...selected, cwd: path.join(root, "another-project") };
      await tool.restart(true);
      strictEqual(activation.mock.callCount(), 1);

      selected = { path: selected.path, loader: "node" };
      await tool.restart(true);
      strictEqual(activation.mock.callCount(), 2);

      await tool.restart();
      strictEqual(
        activation.mock.callCount(),
        3,
        "the restart command must allow an unchanged binary",
      );
    });

    test("navigation reuses global locations and an explicit restart refreshes them", async () => {
      const name = command === "lint" ? "oxlint" : "oxfmt";
      const firstModules = path.join(root, "first", "node_modules");
      const secondModules = path.join(root, "second", "node_modules");
      for (const dir of [firstModules, secondModules]) {
        mkdirSync(path.join(dir, ".bin"), { recursive: true });
        writeFileSync(path.join(dir, ".bin", name), "");
      }
      let globalModules = firstModules;
      const probes = mock.method(require("node:child_process"), "spawnSync", () => ({
        status: 0,
        stdout: globalModules,
      }));
      mock.method(service, getter, () => searchGlobalNodeModulesBin(name));
      const activation = mock.method(tool, "activate", tool.activate.bind(tool));
      await tool.restart();
      strictEqual(
        activation.mock.calls[0].arguments[0]?.path,
        path.join(firstModules, ".bin", name),
      );
      strictEqual(probes.mock.callCount(), 2);

      globalModules = secondModules;
      await tool.restart(true);
      strictEqual(activation.mock.callCount(), 1);
      strictEqual(probes.mock.callCount(), 2, "navigation must reuse the known locations");

      await tool.restart();
      strictEqual(
        activation.mock.calls[1].arguments[0]?.path,
        path.join(secondModules, ".bin", name),
      );
      strictEqual(probes.mock.callCount(), 4, "explicit restarts must query the locations again");
    });

    test("waits for an ongoing restart before processing another restart or shutdown", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const activate = tool.activate.bind(tool);
      const activation = mock.method(tool, "activate", async (binary?: BinarySearchResult) => {
        await gate;
        await activate(binary);
      });
      const first = tool.restart();
      const second = tool.restart();
      const shutdown = tool.deactivate();
      release();
      await Promise.all([first, second, shutdown]);
      strictEqual(activation.mock.callCount(), 2);
      strictEqual(tool.getLspVersion(), undefined);
    });
  });
}
