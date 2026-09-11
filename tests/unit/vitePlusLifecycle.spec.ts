import { strictEqual } from "assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { mock } from "node:test";
import { window, workspace } from "vscode";
import { ConfigService } from "../../client/ConfigService";
import type { BinarySearchResult } from "../../client/findBinary";
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
      await workspace.getConfiguration("oxc").update("enable", undefined);
      rmSync(root, { recursive: true, force: true });
    });

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
