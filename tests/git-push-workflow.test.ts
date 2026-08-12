import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { GitCommitResult } from "../src/infrastructure/git/git-commit-adapter.js";
import type {
  GitPushAdapter,
  GitPushRequest,
  GitPushResult,
} from "../src/infrastructure/git/git-push-adapter.js";
import { createGitPushWorkflow } from "../src/workflow/index.js";

function createCommitResult(
  executionId = "exec-push",
  status: GitCommitResult["status"] = "COMMITTED",
): GitCommitResult {
  if (status === "COMMITTED") {
    return {
      executionId,
      status,
      commitSha: "commit-sha",
      branch: "main",
      committedPaths: ["tracked.txt"],
    };
  }
  if (status === "REJECTED") {
    return {
      executionId,
      status,
      reasons: [{ code: "INDEX_NOT_CLEAN", message: "blocked" }],
    };
  }
  return {
    executionId,
    status,
    reasons: [{ code: "COMMIT_FAILED", message: "boom" }],
  };
}

function createAdapterStub(response: GitPushResult) {
  const calls: GitPushRequest[] = [];
  const adapter: GitPushAdapter = {
    async push(request: GitPushRequest): Promise<GitPushResult> {
      calls.push(request);
      return response;
    },
  };
  return { adapter, calls };
}

describe("Git push workflow", () => {
  it("monta request correto e propaga PUSHED", async () => {
    const commitResult = createCommitResult();
    const { adapter, calls } = createAdapterStub({
      executionId: commitResult.executionId,
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });
    const workflow = createGitPushWorkflow(adapter);

    const result = await workflow.push({
      executionId: commitResult.executionId,
      repositoryDir: "C:/repo/target",
      commitResult,
      remoteName: "origin",
      expectedBranch: "main",
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      executionId: commitResult.executionId,
      repositoryDir: "C:/repo/target",
      branch: "main",
      commitSha: "commit-sha",
      remoteName: "origin",
      expectedBranch: "main",
    });
    assert.deepEqual(result, {
      executionId: commitResult.executionId,
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });
  });

  it("propaga REJECTED e FAILED sem reinterpretar", async () => {
    const rejectedCommitResult = createCommitResult("exec-push", "REJECTED");
    const failedCommitResult = createCommitResult("exec-push", "FAILED");
    const rejectedAdapter = createAdapterStub({
      executionId: "exec-push",
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });
    const failedAdapter = createAdapterStub({
      executionId: "exec-push",
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });

    const rejectedWorkflow = createGitPushWorkflow(rejectedAdapter.adapter);
    const rejectedResult = await rejectedWorkflow.push({
      executionId: rejectedCommitResult.executionId,
      repositoryDir: "C:/repo/target",
      commitResult: rejectedCommitResult,
      remoteName: "origin",
    });
    assert.equal(rejectedAdapter.calls.length, 0);
    assert.equal(rejectedResult, rejectedCommitResult);

    const failedWorkflow = createGitPushWorkflow(failedAdapter.adapter);
    const failedResult = await failedWorkflow.push({
      executionId: failedCommitResult.executionId,
      repositoryDir: "C:/repo/target",
      commitResult: failedCommitResult,
      remoteName: "origin",
    });
    assert.equal(failedAdapter.calls.length, 0);
    assert.equal(failedResult, failedCommitResult);
  });

  it("propaga REJECTED com executionId correspondente sem reinterpretar", async () => {
    const rejectedCommitResult = createCommitResult("exec-rejected", "REJECTED");
    const { adapter, calls } = createAdapterStub({
      executionId: "exec-rejected",
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });
    const workflow = createGitPushWorkflow(adapter);

    const result = await workflow.push({
      executionId: "exec-rejected",
      repositoryDir: "C:/repo/target",
      commitResult: rejectedCommitResult,
      remoteName: "origin",
    });

    assert.equal(calls.length, 0);
    assert.equal(result, rejectedCommitResult);
  });

  it("propaga FAILED com executionId correspondente sem reinterpretar", async () => {
    const failedCommitResult = createCommitResult("exec-failed", "FAILED");
    const { adapter, calls } = createAdapterStub({
      executionId: "exec-failed",
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });
    const workflow = createGitPushWorkflow(adapter);

    const result = await workflow.push({
      executionId: "exec-failed",
      repositoryDir: "C:/repo/target",
      commitResult: failedCommitResult,
      remoteName: "origin",
    });

    assert.equal(calls.length, 0);
    assert.equal(result, failedCommitResult);
  });

  it("bloqueia executionId divergente sem chamar o adapter", async () => {
    const commitResult = createCommitResult("exec-commit");
    const { adapter, calls } = createAdapterStub({
      executionId: commitResult.executionId,
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });
    const workflow = createGitPushWorkflow(adapter);

    const result = await workflow.push({
      executionId: "exec-input",
      repositoryDir: "C:/repo/target",
      commitResult,
      remoteName: "origin",
      expectedBranch: "main",
    });

    assert.equal(calls.length, 0);
    assert.deepEqual(result, {
      executionId: "exec-input",
      status: "REJECTED",
      reasons: [
        {
          code: "INVALID_REQUEST",
          message: "commitResult.executionId must match executionId",
        },
      ],
    });
  });

  it("bloqueia REJECTED com executionId divergente sem chamar o adapter", async () => {
    const commitResult = createCommitResult("exec-rejected", "REJECTED");
    const { adapter, calls } = createAdapterStub({
      executionId: "exec-rejected",
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });
    const workflow = createGitPushWorkflow(adapter);

    const result = await workflow.push({
      executionId: "exec-input",
      repositoryDir: "C:/repo/target",
      commitResult,
      remoteName: "origin",
    });

    assert.equal(calls.length, 0);
    assert.deepEqual(result, {
      executionId: "exec-input",
      status: "REJECTED",
      reasons: [
        {
          code: "INVALID_REQUEST",
          message: "commitResult.executionId must match executionId",
        },
      ],
    });
  });

  it("bloqueia FAILED com executionId divergente sem chamar o adapter", async () => {
    const commitResult = createCommitResult("exec-failed", "FAILED");
    const { adapter, calls } = createAdapterStub({
      executionId: "exec-failed",
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/main",
    });
    const workflow = createGitPushWorkflow(adapter);

    const result = await workflow.push({
      executionId: "exec-input",
      repositoryDir: "C:/repo/target",
      commitResult,
      remoteName: "origin",
    });

    assert.equal(calls.length, 0);
    assert.deepEqual(result, {
      executionId: "exec-input",
      status: "REJECTED",
      reasons: [
        {
          code: "INVALID_REQUEST",
          message: "commitResult.executionId must match executionId",
        },
      ],
    });
  });

  it("preserva expectedBranch e remoteName no request", async () => {
    const commitResult = createCommitResult();
    const { adapter, calls } = createAdapterStub({
      executionId: commitResult.executionId,
      status: "PUSHED",
      branch: "release",
      remoteName: "upstream",
      commitSha: "commit-sha",
      pushedRef: "refs/heads/release",
    });
    const workflow = createGitPushWorkflow(adapter);

    await workflow.push({
      executionId: commitResult.executionId,
      repositoryDir: "C:/repo/target",
      commitResult,
      remoteName: "upstream",
      expectedBranch: "release",
    });

    assert.equal(calls[0]?.expectedBranch, "release");
    assert.equal(calls[0]?.remoteName, "upstream");
    assert.equal(calls[0]?.executionId, commitResult.executionId);
  });

  it("não duplica lógica Git no source do workflow", async () => {
    const source = await readFile(resolve(process.cwd(), "src/workflow/git-push-workflow.ts"), "utf8");
    const lower = source.toLowerCase();

    assert.ok(!lower.includes("execfile"));
    assert.ok(!lower.includes("spawn("));
    assert.ok(!lower.includes("git push"));
    assert.ok(!lower.includes("git remote"));
    assert.ok(!lower.includes("git branch"));
  });
});
