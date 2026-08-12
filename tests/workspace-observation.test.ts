import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { createWorkspaceSandbox } from "../src/infrastructure/workspace/workspace-sandbox.js";
import { captureWorkspaceSnapshot } from "../src/infrastructure/workspace/workspace-snapshotter.js";
import { mapWorkspaceDiff, type WorkspaceFileChange } from "../src/infrastructure/workspace/workspace-diff-mapper.js";

async function createTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

function fileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("Workspace snapshotter", () => {
  it("captura workspace vazio", async () => {
    const baseDir = await createTempDir("wus-snapshot-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-empty" });

    const snapshot = await captureWorkspaceSnapshot(sandbox.workspaceDir);

    assert.deepEqual(snapshot, []);
    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("captura arquivo regular, subdiretório e ordem determinística", async () => {
    const baseDir = await createTempDir("wus-snapshot-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-files" });
    const nestedDir = join(sandbox.workspaceDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(sandbox.workspaceDir, "b.txt"), "bravo");
    await writeFile(join(nestedDir, "a.txt"), "alpha");

    const snapshot = await captureWorkspaceSnapshot(sandbox.workspaceDir);

    assert.deepEqual(snapshot, [
      { relativePath: "b.txt", contentHash: fileHash("bravo") },
      { relativePath: "nested/a.txt", contentHash: fileHash("alpha") },
    ]);

    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("muda o hash quando o conteúdo muda", async () => {
    const baseDir = await createTempDir("wus-snapshot-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-hash" });
    const filePath = join(sandbox.workspaceDir, "file.txt");

    await writeFile(filePath, "before");
    const before = await captureWorkspaceSnapshot(sandbox.workspaceDir);
    await writeFile(filePath, "after");
    const after = await captureWorkspaceSnapshot(sandbox.workspaceDir);

    assert.equal(before[0]?.contentHash, fileHash("before"));
    assert.equal(after[0]?.contentHash, fileHash("after"));
    assert.notEqual(before[0]?.contentHash, after[0]?.contentHash);

    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("bloqueia traversal e symlink externo", async () => {
    const baseDir = await createTempDir("wus-snapshot-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-guard" });
    const outsideDir = join(baseDir, "outside");
    const insideDir = join(sandbox.workspaceDir, "inside");
    await mkdir(outsideDir, { recursive: true });
    await mkdir(insideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "secret");
    await writeFile(join(insideDir, "safe.txt"), "safe");

    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    let symlinkSupported = true;

    try {
      await symlink(outsideDir, join(sandbox.workspaceDir, "outside-link"), symlinkType);
    } catch (error) {
      symlinkSupported = false;
      assert.match(String(error), /EPERM|EACCES|privilege|operation not permitted/i);
    }

    if (symlinkSupported) {
      await assert.rejects(() => captureWorkspaceSnapshot(sandbox.workspaceDir));
    }

    await assert.rejects(() => captureWorkspaceSnapshot(join(sandbox.workspaceDir, "..", "..", "escape")));

    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("falha se a raiz for substituída durante a captura", async () => {
    const baseDir = await createTempDir("wus-snapshot-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-root-toctou" });
    const oldWorkspaceDir = `${sandbox.workspaceDir}-old`;
    const replacementFile = join(sandbox.workspaceDir, "a.txt");
    const trailingFile = join(sandbox.workspaceDir, "z.txt");

    await writeFile(replacementFile, Buffer.alloc(16 * 1024 * 1024, 1));
    await writeFile(trailingFile, "trailing");

    const capturePromise = captureWorkspaceSnapshot(sandbox.workspaceDir);
    const captureAssertion = assert.rejects(capturePromise);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await rename(sandbox.workspaceDir, oldWorkspaceDir);
    await mkdir(sandbox.workspaceDir, { recursive: true });

    await captureAssertion;

    await rm(sandbox.workspaceDir, { recursive: true, force: true });
    await rm(oldWorkspaceDir, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  it("omite arquivo removido antes da captura", async () => {
    const baseDir = await createTempDir("wus-snapshot-");
    const sandbox = await createWorkspaceSandbox({ baseDir, workspaceId: "job-file-toctou" });
    const disappearingFile = join(sandbox.workspaceDir, "z.txt");

    await writeFile(join(sandbox.workspaceDir, "a.txt"), "stable");
    await writeFile(disappearingFile, "gone");

    await rm(disappearingFile, { force: true });
    const snapshot = await captureWorkspaceSnapshot(sandbox.workspaceDir);

    assert.deepEqual(snapshot, [{ relativePath: "a.txt", contentHash: fileHash("stable") }]);

    await sandbox.cleanup();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("não depende de BomPraTi ou OpenHands", async () => {
    const sources = [
      new URL("../../src/infrastructure/workspace/workspace-snapshotter.ts", import.meta.url),
      new URL("../../src/infrastructure/workspace/workspace-diff-mapper.ts", import.meta.url),
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
    }
  });
});

describe("Workspace diff mapper", () => {
  it("produz diff vazio sem mudanças", () => {
    const snapshot = [
      { relativePath: "a.txt", contentHash: fileHash("a") },
      { relativePath: "nested/b.txt", contentHash: fileHash("b") },
    ] as const;

    const diff = mapWorkspaceDiff(snapshot, snapshot);

    assert.deepEqual(diff, []);
  });

  it("produz mudanças adicionadas, modificadas e removidas em ordem determinística", () => {
    const before = [
      { relativePath: "a.txt", contentHash: fileHash("before-a") },
      { relativePath: "c.txt", contentHash: fileHash("before-c") },
    ] as const;
    const after = [
      { relativePath: "a.txt", contentHash: fileHash("after-a") },
      { relativePath: "b.txt", contentHash: fileHash("after-b") },
    ] as const;

    const diff = mapWorkspaceDiff(before, after);

    assert.deepEqual(diff, [
      { type: "MODIFIED", path: "a.txt" },
      { type: "ADDED", path: "b.txt" },
      { type: "DELETED", path: "c.txt" },
    ]);
  });

  it("é determinístico para o mesmo input", () => {
    const before = [
      { relativePath: "z.txt", contentHash: fileHash("z1") },
      { relativePath: "a.txt", contentHash: fileHash("a1") },
    ] as const;
    const after = [
      { relativePath: "a.txt", contentHash: fileHash("a2") },
      { relativePath: "m.txt", contentHash: fileHash("m2") },
      { relativePath: "z.txt", contentHash: fileHash("z1") },
    ] as const;

    const first = mapWorkspaceDiff(before, after);
    const second = mapWorkspaceDiff(before, after);

    assert.deepEqual(first, second);
  });

  it("não expõe decisão de admissibilidade nem payload arbitrário", async () => {
    const source = await readFile(new URL("../../src/infrastructure/workspace/workspace-diff-mapper.ts", import.meta.url), "utf8");
    const lower = source.toLowerCase();

    assert.ok(!lower.includes("admissible"));
    assert.ok(!lower.includes("rejected"));
    assert.ok(!lower.includes("quality gate"));
    assert.ok(!lower.includes("openhands runtime"));
    assert.ok(!lower.includes("bomprati domain"));
    assert.ok(!lower.includes("metadata"));
    assert.ok(!lower.includes("details"));
    assert.ok(!lower.includes("record<string, unknown>"));
  });

  it("mantém o contrato do diff fechado no tipo", () => {
    const change: WorkspaceFileChange = { type: "ADDED", path: "a.txt" };
    // @ts-expect-error only the three file-change kinds are allowed
    const invalid: WorkspaceFileChange = { type: "RENAMED", path: "a.txt" };

    assert.equal(change.type, "ADDED");
    assert.equal(invalid.type, "RENAMED");
  });

  it("rejeita snapshots com relativePath duplicado", () => {
    const duplicateBefore = [
      { relativePath: "a.txt", contentHash: fileHash("1") },
      { relativePath: "a.txt", contentHash: fileHash("2") },
    ] as const;
    const duplicateAfter = [
      { relativePath: "b.txt", contentHash: fileHash("1") },
      { relativePath: "b.txt", contentHash: fileHash("2") },
    ] as const;

    assert.throws(() => mapWorkspaceDiff(duplicateBefore, []));
    assert.throws(() => mapWorkspaceDiff([], duplicateAfter));
  });
});
