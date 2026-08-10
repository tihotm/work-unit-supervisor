import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  acquireWorkspaceApplyLock,
  applyWorkspacePlan,
  captureWorkspaceSnapshot,
  createWorkspaceApplyPlan,
  createWorkspaceSandbox,
  mapWorkspaceDiff,
} from "../src/infrastructure/workspace/index.js";
import { workspaceApplyRuntime } from "../src/infrastructure/workspace/workspace-applier.js";

async function createTempDir(prefix: string): Promise<string> {
  return await fsPromises.mkdtemp(join(tmpdir(), prefix));
}

async function cleanupWorkspace(baseDir: string, ...dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await fsPromises.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
}

async function buildPlan(params: {
  readonly executionId: string;
  readonly sourceWorkspaceDir: string;
  readonly targetWorkspaceDir: string;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths?: readonly string[];
}) {
  const baseSnapshot = await captureWorkspaceSnapshot(params.targetWorkspaceDir);
  const sourceSnapshot = await captureWorkspaceSnapshot(params.sourceWorkspaceDir);
  const changes = mapWorkspaceDiff(baseSnapshot, sourceSnapshot);

  return createWorkspaceApplyPlan({
    executionId: params.executionId,
    sourceWorkspaceDir: params.sourceWorkspaceDir,
    targetWorkspaceDir: params.targetWorkspaceDir,
    allowedPaths: params.allowedPaths,
    forbiddenPaths: params.forbiddenPaths ?? [],
    baseSnapshot,
    sourceSnapshot,
    changes,
  });
}

describe("Workspace applier", () => {
  it("aplica ADDED", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-added" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-added" });

    try {
      await fsPromises.writeFile(join(source.workspaceDir, "added.txt"), "hello");
      const plan = await buildPlan({
        executionId: "exec-added",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["added.txt"],
      });

      const result = await applyWorkspacePlan(plan);

      assert.deepEqual(result, {
        executionId: "exec-added",
        status: "APPLIED",
        appliedPaths: ["added.txt"],
      });
      assert.equal(await fsPromises.readFile(join(target.workspaceDir, "added.txt"), "utf8"), "hello");
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("aplica MODIFIED", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-modified" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-modified" });

    try {
      await fsPromises.writeFile(join(target.workspaceDir, "edit.txt"), "before");
      await fsPromises.writeFile(join(source.workspaceDir, "edit.txt"), "after");
      const plan = await buildPlan({
        executionId: "exec-modified",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["edit.txt"],
      });

      const result = await applyWorkspacePlan(plan);

      assert.deepEqual(result, {
        executionId: "exec-modified",
        status: "APPLIED",
        appliedPaths: ["edit.txt"],
      });
      assert.equal(await fsPromises.readFile(join(target.workspaceDir, "edit.txt"), "utf8"), "after");
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("aplica DELETED", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-deleted" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-deleted" });

    try {
      await fsPromises.writeFile(join(target.workspaceDir, "gone.txt"), "before");
      const plan = await buildPlan({
        executionId: "exec-deleted",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["gone.txt"],
      });

      const result = await applyWorkspacePlan(plan);

      assert.deepEqual(result, {
        executionId: "exec-deleted",
        status: "APPLIED",
        appliedPaths: ["gone.txt"],
      });
      await assert.rejects(() => fsPromises.readFile(join(target.workspaceDir, "gone.txt"), "utf8"));
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("falha fechado para scope inválido, traversal e path absoluto", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-invalid-scope" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-invalid-scope" });

    try {
      await fsPromises.writeFile(join(source.workspaceDir, "ok.txt"), "ok");
      const baseSnapshot = await captureWorkspaceSnapshot(target.workspaceDir);
      const sourceSnapshot = await captureWorkspaceSnapshot(source.workspaceDir);
      const changes = mapWorkspaceDiff(baseSnapshot, sourceSnapshot);

      assert.throws(
        () =>
          createWorkspaceApplyPlan({
            executionId: "exec-invalid-allowed",
            sourceWorkspaceDir: source.workspaceDir,
            targetWorkspaceDir: target.workspaceDir,
            allowedPaths: ["../escape"],
            forbiddenPaths: [],
            baseSnapshot,
            sourceSnapshot,
            changes,
          }),
        /INVALID_PATH/,
      );

      assert.throws(
        () =>
          createWorkspaceApplyPlan({
            executionId: "exec-invalid-forbidden",
            sourceWorkspaceDir: source.workspaceDir,
            targetWorkspaceDir: target.workspaceDir,
            allowedPaths: ["ok.txt"],
            forbiddenPaths: ["ok.txt"],
            baseSnapshot,
            sourceSnapshot,
            changes,
          }),
        /INVALID_PATH/,
      );

      assert.throws(
        () =>
          createWorkspaceApplyPlan({
            executionId: "exec-invalid-change",
            sourceWorkspaceDir: source.workspaceDir,
            targetWorkspaceDir: target.workspaceDir,
            allowedPaths: ["ok.txt"],
            forbiddenPaths: [],
            baseSnapshot,
            sourceSnapshot,
            changes: [{ type: "ADDED", path: "../escape" } as never],
          }),
        /INVALID_PATH/,
      );

      assert.throws(
        () =>
          createWorkspaceApplyPlan({
            executionId: "exec-invalid-absolute",
            sourceWorkspaceDir: source.workspaceDir,
            targetWorkspaceDir: target.workspaceDir,
            allowedPaths: ["ok.txt"],
            forbiddenPaths: [],
            baseSnapshot,
            sourceSnapshot,
            changes: [{ type: "ADDED", path: join(baseDir, "escape.txt") } as never],
          }),
        /INVALID_PATH/,
      );
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("rejeita change identity divergente antes de escrever", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-change-id" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-change-id" });

    try {
      await fsPromises.writeFile(join(source.workspaceDir, "added.txt"), "hello");
      const plan = await buildPlan({
        executionId: "exec-change-id",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["added.txt"],
      });

      const tamperedPlan = {
        ...plan,
        changeFingerprint: "0".repeat(64),
      };

      const result = await applyWorkspacePlan(tamperedPlan);

      assert.equal(result.status, "REJECTED");
      assert.equal(result.reasons[0]?.code, "CHANGE_IDENTITY_MISMATCH");
      await assert.rejects(() => fsPromises.readFile(join(target.workspaceDir, "added.txt"), "utf8"));
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("rejeita divergência de base depois da auditoria antes de escrever", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-base-diverge" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-base-diverge" });

    try {
      await fsPromises.writeFile(join(target.workspaceDir, "edit.txt"), "before");
      await fsPromises.writeFile(join(source.workspaceDir, "edit.txt"), "after");
      const plan = await buildPlan({
        executionId: "exec-base-diverge",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["edit.txt"],
      });

      await fsPromises.writeFile(join(target.workspaceDir, "edit.txt"), "tampered");

      const result = await applyWorkspacePlan(plan);

      assert.equal(result.status, "REJECTED");
      assert.equal(result.reasons[0]?.code, "BASE_DIVERGED");
      assert.equal(await fsPromises.readFile(join(target.workspaceDir, "edit.txt"), "utf8"), "tampered");
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("usa identidade determinística independente da ordem das mudanças", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-order" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-order" });

    try {
      await fsPromises.writeFile(join(source.workspaceDir, "a.txt"), "a");
      await fsPromises.writeFile(join(source.workspaceDir, "b.txt"), "b");

      const baseSnapshot = await captureWorkspaceSnapshot(target.workspaceDir);
      const sourceSnapshot = await captureWorkspaceSnapshot(source.workspaceDir);
      const diff = mapWorkspaceDiff(baseSnapshot, sourceSnapshot);
      const reversed = [...diff].reverse();
      const commonInput = {
        executionId: "exec-order",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["a.txt", "b.txt"],
        forbiddenPaths: [],
        baseSnapshot,
        sourceSnapshot,
      };

      const first = createWorkspaceApplyPlan({
        ...commonInput,
        changes: diff,
      });
      const second = createWorkspaceApplyPlan({
        ...commonInput,
        changes: reversed,
      });

      assert.equal(first.changeFingerprint, second.changeFingerprint);
      assert.deepEqual(first.changes, second.changes);
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("aplica rollback quando uma mudança posterior falha", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-rollback" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-rollback" });

    try {
      const updatedNested = Buffer.alloc(16 * 1024 * 1024, "a");
      const updatedTail = "after-tail";

      await fsPromises.mkdir(join(target.workspaceDir, "nested"), { recursive: true });
      await fsPromises.writeFile(join(target.workspaceDir, "z.txt"), "before-tail");
      await fsPromises.mkdir(join(source.workspaceDir, "nested", "a", "b"), { recursive: true });
      await fsPromises.writeFile(join(source.workspaceDir, "nested", "a", "b", "file.txt"), updatedNested);
      await fsPromises.writeFile(join(source.workspaceDir, "z.txt"), updatedTail);

      const plan = await buildPlan({
        executionId: "exec-rollback",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["nested/a/b/file.txt", "z.txt"],
      });

      const mutation = new Promise<void>((resolveMutation, rejectMutation) => {
        setImmediate(async () => {
          try {
            await fsPromises.writeFile(join(target.workspaceDir, "tampered.txt"), "tampered");
            resolveMutation();
          } catch (error) {
            rejectMutation(error);
          }
        });
      });

      const result = await applyWorkspacePlan(plan);
      await mutation;

      assert.equal(result.status, "REJECTED");
      assert.equal(result.reasons[0]?.code, "BASE_DIVERGED");
      assert.equal((await fsPromises.stat(join(target.workspaceDir, "nested"))).isDirectory(), true);
      await assert.rejects(() => fsPromises.stat(join(target.workspaceDir, "nested", "a")));
      await assert.rejects(() => fsPromises.stat(join(target.workspaceDir, "nested", "a", "b")));
      await assert.rejects(() => fsPromises.readFile(join(target.workspaceDir, "nested", "a", "b", "file.txt"), "utf8"));
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("preserva a falha original quando rollback também falha", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-rollback-failure" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-rollback-failure" });
    const originalRmdir = workspaceApplyRuntime.rmdir;
    (workspaceApplyRuntime as { rmdir: typeof originalRmdir }).rmdir = async () => {
      throw new Error("MOCK_ROLLBACK_FAILED");
    };

    try {
      const updatedNested = Buffer.alloc(64 * 1024 * 1024, "a");
      const updatedTail = "after-tail";

      await fsPromises.mkdir(join(target.workspaceDir, "nested"), { recursive: true });
      await fsPromises.writeFile(join(target.workspaceDir, "z.txt"), "before-tail");
      await fsPromises.mkdir(join(source.workspaceDir, "nested", "a", "b"), { recursive: true });
      await fsPromises.writeFile(join(source.workspaceDir, "nested", "a", "b", "file.txt"), updatedNested);
      await fsPromises.writeFile(join(source.workspaceDir, "z.txt"), updatedTail);

      const plan = await buildPlan({
        executionId: "exec-rollback-failure",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["nested/a/b/file.txt", "z.txt"],
      });

      const firstAppliedPath = join(target.workspaceDir, "nested", "a", "b", "file.txt");
      const mutation = new Promise<void>((resolveMutation, rejectMutation) => {
        const poll = async (): Promise<void> => {
          try {
            const fileExists = await fsPromises.stat(firstAppliedPath).then((stats) => stats.isFile(), () => false);
            if (fileExists) {
              await fsPromises.writeFile(join(target.workspaceDir, "tampered.txt"), "tampered");
              resolveMutation();
              return;
            }
            setTimeout(poll, 5);
          } catch (error) {
            rejectMutation(error);
          }
        };

        setTimeout(poll, 0);
      });

      const result = await applyWorkspacePlan(plan);
      await mutation;

      assert.equal(result.status, "FAILED");
      assert.equal(result.reasons[0]?.code, "BASE_DIVERGED");
      assert.equal(result.reasons[1]?.code, "ROLLBACK_FAILED");
    } finally {
      (workspaceApplyRuntime as { rmdir: typeof originalRmdir }).rmdir = originalRmdir;
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("rejeita parent symlink antes de escrever fora da raiz", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-symlink" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-symlink" });
    const outsideDir = join(baseDir, "outside");

    try {
      await fsPromises.mkdir(outsideDir, { recursive: true });
      await fsPromises.mkdir(join(source.workspaceDir, "nested"), { recursive: true });
      await fsPromises.writeFile(join(source.workspaceDir, "nested", "file.txt"), "hello");
      const plan = await buildPlan({
        executionId: "exec-symlink",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["nested/file.txt"],
      });

      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      let symlinkSupported = true;

      try {
        await fsPromises.symlink(outsideDir, join(target.workspaceDir, "nested"), symlinkType);
      } catch (error) {
        symlinkSupported = false;
        assert.match(String(error), /EPERM|EACCES|privilege|operation not permitted/i);
      }

      if (symlinkSupported) {
        const result = await applyWorkspacePlan(plan);
        assert.notEqual(result.status, "APPLIED");
        await assert.rejects(() => fsPromises.readFile(join(outsideDir, "file.txt"), "utf8"));
      }
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("mantém lock exclusivo por target e não bloqueia targets diferentes", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-lock" });
    const targetA = await createWorkspaceSandbox({ baseDir, workspaceId: "target-lock-a" });
    const targetB = await createWorkspaceSandbox({ baseDir, workspaceId: "target-lock-b" });

    try {
      const lockA = await acquireWorkspaceApplyLock(targetA.workspaceDir);
      await assert.rejects(() => acquireWorkspaceApplyLock(targetA.workspaceDir), /TARGET_LOCKED/);
      const lockB = await acquireWorkspaceApplyLock(targetB.workspaceDir);

      await lockA.release();
      await lockB.release();
    } finally {
      await source.cleanup();
      await targetA.cleanup();
      await targetB.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("disputa o mesmo lock para aliases do mesmo workspace físico", async () => {
    const baseDir = await createTempDir("wus-apply-");
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-lock-alias" });
    const aliasDir = target.workspaceDir.replace(/^([a-z]):/i, (_, drive: string) => {
      const toggledDrive = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
      return `${toggledDrive}:`;
    });

    try {
      const lock = await acquireWorkspaceApplyLock(target.workspaceDir);
      await assert.rejects(() => acquireWorkspaceApplyLock(aliasDir), /TARGET_LOCKED/);
      await lock.release();
    } finally {
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("não expõe payload arbitrário nem acoplamento de domínio no source real", async () => {
    const source = await fsPromises.readFile(new URL("../../src/infrastructure/workspace/workspace-applier.ts", import.meta.url), "utf8");
    const lower = source.toLowerCase();

    assert.ok(!lower.includes("metadata"));
    assert.ok(!lower.includes("details"));
    assert.ok(!lower.includes("record<string, unknown>"));
    assert.ok(!lower.includes("bomprati"));
    assert.ok(!lower.includes("argus"));
    assert.ok(!lower.includes("openhands"));
    assert.ok(!lower.includes("../core/"));
    assert.ok(!lower.includes("../ports/"));
  });
});
