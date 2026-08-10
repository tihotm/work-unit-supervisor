import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  assertWritableWorkspacePath,
  createWorkspaceSandbox,
  resolveSafeWorkspacePath,
} from "../src/infrastructure/workspace/index.js";

async function createTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

describe("Workspace sandbox", () => {
  it("cria e limpa somente a sandbox", async () => {
    const baseDir = await createTempDir("wus-sandbox-");
    const outsideFile = join(baseDir, "outside.txt");
    await writeFile(outsideFile, "keep");

    const sandbox = await createWorkspaceSandbox({
      baseDir,
      workspaceId: "job-1",
    });

    await writeFile(join(sandbox.workspaceDir, "inside.txt"), "ok");
    await sandbox.cleanup();

    await assert.rejects(() => readFile(join(sandbox.workspaceDir, "inside.txt"), "utf8"));
    assert.equal(await readFile(outsideFile, "utf8"), "keep");
    await rm(baseDir, { recursive: true, force: true });
  });
});

describe("Workspace path guard", () => {
  it("permite path interno simples e subdiretório", async () => {
    const baseDir = await createTempDir("wus-path-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-2" });
    const nestedDir = join(sandbox.workspaceDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    const nestedFile = join(nestedDir, "file.txt");
    await writeFile(nestedFile, "hello");

    assert.equal(await resolveSafeWorkspacePath(sandbox.workspaceDir, nestedFile), await realpath(nestedFile));
    assert.equal(await resolveSafeWorkspacePath(sandbox.workspaceDir, join(nestedDir, ".")), await realpath(nestedDir));
    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("bloqueia traversal, absoluto externo e prefix collision", async () => {
    const baseDir = await createTempDir("wus-path-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "sandbox" });
    const outsideDir = join(baseDir, "sandbox-other");
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "file.txt");
    await writeFile(outsideFile, "outside");

    await assert.rejects(() => resolveSafeWorkspacePath(sandbox.workspaceDir, join(sandbox.workspaceDir, "..", "..", "outside.txt")));
    await assert.rejects(() => resolveSafeWorkspacePath(sandbox.workspaceDir, outsideFile));
    await assert.rejects(() => resolveSafeWorkspacePath(sandbox.workspaceDir, join(baseDir, "sandbox-other", "file.txt")));

    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("aceita separadores Windows e POSIX na validação", async () => {
    const baseDir = await createTempDir("wus-path-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-3" });
    const nestedDir = join(sandbox.workspaceDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    const nestedFile = join(nestedDir, "file.txt");
    await writeFile(nestedFile, "hello");

    const windowsStylePath = nestedFile.replaceAll("/", "\\");
    const posixStylePath = nestedFile.replaceAll("\\", "/");
    assert.equal(await resolveSafeWorkspacePath(sandbox.workspaceDir, windowsStylePath), await realpath(nestedFile));
    assert.equal(await resolveSafeWorkspacePath(sandbox.workspaceDir, posixStylePath), await realpath(nestedFile));

    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("bloqueia symlink/junction escapando da raiz e aceita symlink interno seguro", async () => {
    const baseDir = await createTempDir("wus-symlink-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-4" });
    const insideDir = join(sandbox.workspaceDir, "inside");
    const outsideDir = join(baseDir, "outside");
    await mkdir(insideDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(insideDir, "file.txt"), "inside");
    await writeFile(join(outsideDir, "secret.txt"), "outside");

    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    let symlinkSupported = true;

    try {
      await symlink(insideDir, join(sandbox.workspaceDir, "inside-link"), symlinkType);
      await symlink(outsideDir, join(sandbox.workspaceDir, "outside-link"), symlinkType);
    } catch (error) {
      symlinkSupported = false;
      assert.match(String(error), /EPERM|EACCES|privilege|operation not permitted/i);
    }

    if (symlinkSupported) {
      const safePath = join(sandbox.workspaceDir, "inside-link", "file.txt");
      const escapePath = join(sandbox.workspaceDir, "outside-link", "secret.txt");
      assert.equal(await resolveSafeWorkspacePath(sandbox.workspaceDir, safePath), await realpath(join(insideDir, "file.txt")));
      await assert.rejects(() => resolveSafeWorkspacePath(sandbox.workspaceDir, escapePath));
    }

    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("falha fechado com raiz inexistente", async () => {
    await assert.rejects(() => resolveSafeWorkspacePath(join(tmpdir(), "wus-missing-root"), join(tmpdir(), "wus-missing-root", "file.txt")));
    await assert.rejects(() => assertWritableWorkspacePath(join(tmpdir(), "wus-missing-root"), join(tmpdir(), "wus-missing-root", "file.txt")));
  });

  it("não depende de BomPraTi, OpenHands, Core ou Ports", async () => {
    const sources = [
      new URL("../../src/infrastructure/workspace/workspace-path-guard.ts", import.meta.url),
      new URL("../../src/infrastructure/workspace/workspace-sandbox.ts", import.meta.url),
      new URL("../../src/infrastructure/workspace/index.ts", import.meta.url),
    ];

    for (const sourceUrl of sources) {
      const source = await readFile(sourceUrl, "utf8");
      const lower = source.toLowerCase();
      assert.ok(!lower.includes("openhands"));
      assert.ok(!lower.includes("bomprati"));
      assert.ok(!lower.includes("argus"));
      assert.ok(!lower.includes("../core/"));
      assert.ok(!lower.includes("../ports/"));
      assert.ok(!lower.includes("executor"));
    }
  });
});
