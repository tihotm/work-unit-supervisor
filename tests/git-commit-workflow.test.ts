import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { GitCommitAdapter, GitCommitRequest, GitCommitResult } from "../src/infrastructure/git/git-commit-adapter.js";
import type { WorkspaceApplyPlan, WorkspaceApplyResult } from "../src/infrastructure/workspace/index.js";
import { createGitCommitWorkflow } from "../src/workflow/index.js";

function createPlan(overrides: Partial<WorkspaceApplyPlan> = {}): WorkspaceApplyPlan {
  return {
    executionId: "exec-workflow",
    sourceWorkspaceDir: "C:/repo/source",
    targetWorkspaceDir: "C:/repo/target",
    allowedPaths: ["src/app.ts"],
    forbiddenPaths: [],
    baseSnapshot: [],
    sourceSnapshot: [{ relativePath: "src/app.ts", contentHash: "hash-after" }],
    baseFingerprint: "base-fingerprint",
    sourceFingerprint: "source-fingerprint",
    changeFingerprint: "change-fingerprint",
    changes: [{ type: "MODIFIED", path: "src/app.ts" }],
    ...overrides,
  };
}

function createAppliedResult(executionId = "exec-workflow"): WorkspaceApplyResult {
  return {
    executionId,
    status: "APPLIED",
    appliedPaths: ["src/app.ts"],
  };
}

function createRejectedResult(executionId = "exec-workflow"): WorkspaceApplyResult {
  return {
    executionId,
    status: "REJECTED",
    reasons: [{ code: "INVALID_PATH", message: "blocked", path: "src/app.ts" }],
  };
}

function createFailedResult(executionId = "exec-workflow"): WorkspaceApplyResult {
  return {
    executionId,
    status: "FAILED",
    reasons: [{ code: "APPLY_FAILED", message: "failed", path: "src/app.ts" }],
  };
}

function createAdapterStub(response: GitCommitResult) {
  const calls: GitCommitRequest[] = [];
  const adapter: GitCommitAdapter = {
    async commit(request: GitCommitRequest): Promise<GitCommitResult> {
      calls.push(request);
      return response;
    },
  };
  return { adapter, calls };
}

describe("Git commit workflow", () => {
  it("monta request correto e propaga COMMITTED", async () => {
    const plan = createPlan();
    const { adapter, calls } = createAdapterStub({
      executionId: plan.executionId,
      status: "COMMITTED",
      commitSha: "commit-sha",
      branch: "main",
      committedPaths: ["src/app.ts"],
    });
    const workflow = createGitCommitWorkflow(adapter);

    const result = await workflow.commit({
      plan,
      applyResult: createAppliedResult(plan.executionId),
      commitMessage: "feat: commit workflow",
      expectedBranch: "main",
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      executionId: plan.executionId,
      repositoryDir: plan.targetWorkspaceDir,
      changes: plan.changes,
      expectedSnapshot: plan.sourceSnapshot,
      commitMessage: "feat: commit workflow",
      expectedBranch: "main",
    });
    assert.deepEqual(result, {
      executionId: plan.executionId,
      status: "COMMITTED",
      commitSha: "commit-sha",
      branch: "main",
      committedPaths: ["src/app.ts"],
    });
  });

  it("propaga REJECTED e FAILED sem reinterpretar", async () => {
    const plan = createPlan();
    const rejectedAdapter = createAdapterStub({
      executionId: plan.executionId,
      status: "REJECTED",
      reasons: [{ code: "INDEX_NOT_CLEAN", message: "blocked" }],
    });
    const failedAdapter = createAdapterStub({
      executionId: plan.executionId,
      status: "FAILED",
      reasons: [{ code: "COMMIT_FAILED", message: "boom" }],
    });

    const rejectedWorkflow = createGitCommitWorkflow(rejectedAdapter.adapter);
    const rejectedResult = await rejectedWorkflow.commit({
      plan,
      applyResult: createAppliedResult(plan.executionId),
      commitMessage: "feat: commit workflow",
    });
    assert.deepEqual(rejectedResult, {
      executionId: plan.executionId,
      status: "REJECTED",
      reasons: [{ code: "INDEX_NOT_CLEAN", message: "blocked" }],
    });

    const failedWorkflow = createGitCommitWorkflow(failedAdapter.adapter);
    const failedResult = await failedWorkflow.commit({
      plan,
      applyResult: createAppliedResult(plan.executionId),
      commitMessage: "feat: commit workflow",
    });
    assert.deepEqual(failedResult, {
      executionId: plan.executionId,
      status: "FAILED",
      reasons: [{ code: "COMMIT_FAILED", message: "boom" }],
    });
  });

  it("impede commit quando upstream não está APPLIED", async () => {
    const plan = createPlan();
    const { adapter, calls } = createAdapterStub({
      executionId: plan.executionId,
      status: "COMMITTED",
      commitSha: "commit-sha",
      branch: "main",
      committedPaths: ["src/app.ts"],
    });
    const workflow = createGitCommitWorkflow(adapter);

    const rejectedApply = createRejectedResult(plan.executionId);
    const rejectedResult = await workflow.commit({
      plan,
      applyResult: rejectedApply,
      commitMessage: "feat: commit workflow",
      expectedBranch: "main",
    });

    assert.equal(calls.length, 0);
    assert.equal(rejectedResult, rejectedApply);

    const failedApply = createFailedResult(plan.executionId);
    const failedResult = await workflow.commit({
      plan,
      applyResult: failedApply,
      commitMessage: "feat: commit workflow",
    });

    assert.equal(calls.length, 0);
    assert.equal(failedResult, failedApply);
  });

  it("bloqueia executionId divergente sem chamar o adapter", async () => {
    const plan = createPlan({ executionId: "exec-plan" });
    const { adapter, calls } = createAdapterStub({
      executionId: plan.executionId,
      status: "COMMITTED",
      commitSha: "commit-sha",
      branch: "main",
      committedPaths: ["src/app.ts"],
    });
    const workflow = createGitCommitWorkflow(adapter);
    const applyResult = createAppliedResult("exec-apply");

    const result = await workflow.commit({
      plan,
      applyResult,
      commitMessage: "feat: commit workflow",
      expectedBranch: "main",
    });

    assert.equal(calls.length, 0);
    assert.deepEqual(result, {
      executionId: plan.executionId,
      status: "REJECTED",
      reasons: [
        {
          code: "INVALID_PLAN",
          message: "applyResult.executionId must match plan.executionId",
        },
      ],
    });
  });

  it("preserva executionId, commitMessage e expectedBranch no request", async () => {
    const plan = createPlan({ executionId: "exec-stable" });
    const { adapter, calls } = createAdapterStub({
      executionId: plan.executionId,
      status: "COMMITTED",
      commitSha: "commit-sha",
      branch: "release",
      committedPaths: ["src/app.ts"],
    });
    const workflow = createGitCommitWorkflow(adapter);

    await workflow.commit({
      plan,
      applyResult: createAppliedResult(plan.executionId),
      commitMessage: "feat: stable workflow",
      expectedBranch: "release",
    });

    assert.equal(calls[0]?.executionId, "exec-stable");
    assert.equal(calls[0]?.commitMessage, "feat: stable workflow");
    assert.equal(calls[0]?.expectedBranch, "release");
  });

  it("não duplica lógica Git no source do workflow", async () => {
    const source = await readFile(new URL("../../src/workflow/git-commit-workflow.ts", import.meta.url), "utf8");
    const lower = source.toLowerCase();

    assert.ok(!lower.includes("execfile"));
    assert.ok(!lower.includes("spawn("));
    assert.ok(!lower.includes("symbolic-ref"));
    assert.ok(!lower.includes("git add"));
    assert.ok(!lower.includes("git commit"));
    assert.ok(!lower.includes("restore --staged"));
  });
});
