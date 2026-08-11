import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { applyAuditedWorkspacePlan } from "../src/workflow/index.js";
import type { DiffAuditResult } from "../src/diff-auditor/index.js";
import { captureWorkspaceSnapshot, createWorkspaceApplyPlan, createWorkspaceSandbox, mapWorkspaceDiff } from "../src/infrastructure/workspace/index.js";

async function createTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function cleanupWorkspace(baseDir: string, ...dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
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

function createAdmissibleAuditResult(): DiffAuditResult {
  return { status: "ADMISSIBLE" };
}

function createRejectedAuditResult(): DiffAuditResult {
  return {
    status: "REJECTED",
    reasons: [
      {
        code: "PATH_FORBIDDEN",
        message: "bloqueado",
        path: "src/app/file.txt",
      },
    ],
  };
}

describe("Workspace apply workflow", () => {
  it("aplica o plano quando o audit está admissível", async () => {
    const baseDir = await createTempDir("wus-workflow-apply-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-apply" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-apply" });

    try {
      await writeFile(join(source.workspaceDir, "file.txt"), "after");
      await writeFile(join(target.workspaceDir, "file.txt"), "before");
      const plan = await buildPlan({
        executionId: "exec-apply",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["file.txt"],
      });

      const result = await applyAuditedWorkspacePlan(plan, createAdmissibleAuditResult());

      assert.equal(result.status, "APPLIED");
      assert.deepEqual(result, {
        executionId: "exec-apply",
        status: "APPLIED",
        appliedPaths: ["file.txt"],
      });
      assert.equal(await readFile(join(target.workspaceDir, "file.txt"), "utf8"), "after");
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("devolve rejection factual quando o audit rejeita e não aplica", async () => {
    const baseDir = await createTempDir("wus-workflow-reject-");
    const source = await createWorkspaceSandbox({ baseDir, workspaceId: "source-reject" });
    const target = await createWorkspaceSandbox({ baseDir, workspaceId: "target-reject" });

    try {
      await writeFile(join(source.workspaceDir, "file.txt"), "after");
      await writeFile(join(target.workspaceDir, "file.txt"), "before");
      const plan = await buildPlan({
        executionId: "exec-reject",
        sourceWorkspaceDir: source.workspaceDir,
        targetWorkspaceDir: target.workspaceDir,
        allowedPaths: ["file.txt"],
      });

      const result = await applyAuditedWorkspacePlan(plan, createRejectedAuditResult());

      assert.equal(result.status, "REJECTED");
      if (result.status === "REJECTED") {
        assert.equal(result.executionId, "exec-reject");
        assert.equal(result.reasons[0]?.code, "INVALID_PATH");
        assert.equal(result.reasons[0]?.path, "src/app/file.txt");
      }
      assert.equal(await readFile(join(target.workspaceDir, "file.txt"), "utf8"), "before");
    } finally {
      await source.cleanup();
      await target.cleanup();
      await cleanupWorkspace(baseDir);
    }
  });

  it("não expõe payload arbitrário nem acoplamento de domínio no source", async () => {
    const source = await readFile(new URL("../../src/workflow/workspace-apply-workflow.ts", import.meta.url), "utf8");
    const lower = source.toLowerCase();

    assert.ok(!lower.includes("metadata"));
    assert.ok(!lower.includes("details"));
    assert.ok(!lower.includes("record<string, unknown>"));
    assert.ok(!lower.includes("bomprati"));
    assert.ok(!lower.includes("argus"));
    assert.ok(!lower.includes("github"));
  });
});
