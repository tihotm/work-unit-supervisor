import type { GitCommitResult } from "../infrastructure/git/git-commit-adapter.js";
import type {
  GitPushAdapter,
  GitPushRequest,
  GitPushRejectedResult,
  GitPushResult,
} from "../infrastructure/git/git-push-adapter.js";

export type GitPushWorkflowInput = {
  readonly executionId: string;
  readonly repositoryDir: string;
  readonly commitResult: GitCommitResult;
  readonly remoteName: string;
  readonly expectedBranch?: string;
};

export type GitPushWorkflowResult = GitCommitResult | GitPushResult;

export type GitPushWorkflow = {
  push(input: GitPushWorkflowInput): Promise<GitPushWorkflowResult>;
};

function buildExecutionIdMismatchResult(executionId: string): GitPushRejectedResult {
  return {
    executionId,
    status: "REJECTED",
    reasons: [
      {
        code: "INVALID_REQUEST",
        message: "commitResult.executionId must match executionId",
      },
    ],
  };
}

function shouldPush(commitResult: GitCommitResult): boolean {
  return commitResult.status === "COMMITTED";
}

function buildGitPushRequest(input: GitPushWorkflowInput): GitPushRequest {
  if (input.commitResult.status !== "COMMITTED") {
    throw new Error("INVALID_REQUEST");
  }

  return {
    executionId: input.executionId,
    repositoryDir: input.repositoryDir,
    branch: input.commitResult.branch,
    commitSha: input.commitResult.commitSha,
    remoteName: input.remoteName,
    ...(input.expectedBranch !== undefined ? { expectedBranch: input.expectedBranch } : {}),
  };
}

export function createGitPushWorkflow(adapter: GitPushAdapter): GitPushWorkflow {
  return {
    async push(input: GitPushWorkflowInput): Promise<GitPushWorkflowResult> {
      if (input.commitResult.executionId !== input.executionId) {
        return buildExecutionIdMismatchResult(input.executionId);
      }

      if (!shouldPush(input.commitResult)) {
        return input.commitResult;
      }

      return await adapter.push(buildGitPushRequest(input));
    },
  };
}
