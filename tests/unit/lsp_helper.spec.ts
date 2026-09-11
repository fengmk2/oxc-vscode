import { deepStrictEqual, strictEqual } from "assert";
import { runExecutable } from "../../client/tools/lsp_helper";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

suite("runExecutable", () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  teardown(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env = originalEnv;
  });

  for (const command of ["lint", "fmt"] as const) {
    test(`runs vp ${command} --lsp in the project directory`, async () => {
      const result = await runExecutable({
        path: "/project/node_modules/.bin/vp",
        loader: "native",
        vitePlus: command,
        cwd: "/project",
      });
      deepStrictEqual(result.args, [command, "--lsp"]);
      strictEqual(result.options?.cwd, "/project");
    });

    test(`runs the vp JavaScript entry point with ${command} --lsp and the configured runtime`, async () => {
      const result = await runExecutable(
        {
          path: "/project/node_modules/vite-plus/bin/vp",
          loader: "node",
          vitePlus: command,
          cwd: "/project",
        },
        true,
      );
      strictEqual(result.command, process.execPath);
      deepStrictEqual(result.args, ["/project/node_modules/vite-plus/bin/vp", command, "--lsp"]);
      strictEqual(result.options?.cwd, "/project");
      strictEqual(result.options?.env?.ELECTRON_RUN_AS_NODE, "1");
    });
  }

  test("does not interpret a vp shell shim as JavaScript with useExecPath", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const result = await runExecutable(
      { path: "/project/node_modules/.bin/vp", loader: "native", vitePlus: "lint" },
      true,
    );
    strictEqual(result.command, "/project/node_modules/.bin/vp");
    deepStrictEqual(result.args, ["lint", "--lsp"]);
  });

  test("quotes Windows vp.cmd paths and passes the subcommand through the shell", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const result = await runExecutable({
      path: "C:\\My Project\\node_modules\\.bin\\vp.cmd",
      loader: "native",
      vitePlus: "fmt",
    });
    strictEqual(result.command, '"C:\\My Project\\node_modules\\.bin\\vp.cmd"');
    strictEqual(result.options?.shell, true);
    deepStrictEqual(result.args, ["fmt", "--lsp"]);
  });

  test("should create Node.js executable for .js files", async () => {
    const result = await runExecutable({
      path: "/path/to/server.js",
      loader: "node",
    });

    strictEqual(result.command, "node");
    strictEqual(result.args?.[0], "/path/to/server.js");
    strictEqual(result.args?.[1], "--lsp");
  });

  test("should create Node.js executable for .cjs files", async () => {
    const result = await runExecutable({
      path: "/path/to/server.cjs",
      loader: "node",
    });

    strictEqual(result.command, "node");
    strictEqual(result.args?.[0], "/path/to/server.cjs");
    strictEqual(result.args?.[1], "--lsp");
  });

  test("should create Node.js executable for .mjs files", async () => {
    const result = await runExecutable({
      path: "/path/to/server.mjs",
      loader: "node",
    });

    strictEqual(result.command, "node");
    strictEqual(result.args?.[0], "/path/to/server.mjs");
    strictEqual(result.args?.[1], "--lsp");
  });

  test("should create binary executable for non-Node files", async () => {
    const result = await runExecutable({
      path: "/path/to/oxc-language-server",
      loader: "native",
    });

    let expectedCommand = "/path/to/oxc-language-server";
    if (process.platform === "win32") {
      expectedCommand = `"${expectedCommand}"`;
    }

    strictEqual(result.command, expectedCommand);
    strictEqual(result.args?.[0], "--lsp");
    strictEqual(result.options?.shell, process.platform === "win32");
  });

  test("should use shell on Windows for binary executables", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const result = await runExecutable({
      path: "C:\\Path With Spaces\\oxc-language-server",
      loader: "native",
    });

    strictEqual(result.options?.shell, true);
  });

  test("should prepend nodePath to PATH", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = "/usr/bin:/bin";

    const result = await runExecutable(
      {
        path: "/path/to/server.js",
        loader: "node",
      },
      false,
      "/custom/node/bin/node",
    );

    strictEqual(result.command, "/custom/node/bin/node");
    strictEqual(result.options?.env?.PATH?.includes(`/custom/node/bin${path.delimiter}`), true);
  });

  test("should set path in quotes on Windows for binary executables", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const result = await runExecutable({
      path: "C:\\Path With Spaces\\oxc-language-server",
      loader: "native",
    });

    strictEqual(result.command, '"C:\\Path With Spaces\\oxc-language-server"');
  });

  test("should use the provided node path for Node.js executables", async () => {
    const result = await runExecutable(
      {
        path: "/path/to/server.js",
        loader: "node",
      },
      false,
      "/custom/node/bin/node",
    );

    strictEqual(result.command, "/custom/node/bin/node");
    strictEqual(result.args?.[0], "/path/to/server.js");
    strictEqual(result.args?.[1], "--lsp");
  });

  test("should use 'execPath' with ELECTRON_RUN_AS_NODE", async () => {
    const result = await runExecutable(
      {
        path: "/path/to/server.js",
        loader: "node",
      },
      true,
    );

    strictEqual(result.command, process.execPath);
    strictEqual(result.options?.env?.ELECTRON_RUN_AS_NODE, "1");
  });

  test("should not set ELECTRON_RUN_AS_NODE server env", async () => {
    const result = await runExecutable(
      {
        path: "/path/to/server.js",
        loader: "node",
      },
      false,
    );
    strictEqual(result.options?.env?.ELECTRON_RUN_AS_NODE, undefined);
  });

  test("should set yarn PnP loader path when provided", async () => {
    const result = await runExecutable({
      path: "/path/to/server.js",
      loader: "node",
      yarnPnpLoaderPath: "/path/to/.pnp.cjs",
    });
    strictEqual(result.args?.includes("--require"), true);
    strictEqual(result.args?.includes("/path/to/.pnp.cjs"), true, JSON.stringify(result.args));
    strictEqual(result.args?.includes("--loader"), true);
    const expectedEsmLoaderPath = pathToFileURL(
      `${path.sep}path${path.sep}to${path.sep}.pnp.loader.mjs`,
    ).href;
    strictEqual(result.args?.includes(expectedEsmLoaderPath), true, JSON.stringify(result.args));
  });
});
