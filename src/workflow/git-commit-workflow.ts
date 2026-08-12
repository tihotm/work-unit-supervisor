import type { GitCommitAdapter, GitCommitRequest, GitCommitResult } from "../infrastructure/git/git-commit-adapter.js";
import type {
  WorkspaceApplyPlan,
  WorkspaceApplyRejectedResult,
  WorkspaceApplyResult,
} from "../infrastructure/workspace/index.js";

export type GitCommitWorkflowInput = {
  readonly plan: WorkspaceApplyPlan;
  readonly applyResult: WorkspaceApplyResult;
  readonly commitMessage: string;
  readonly expectedBranch?: string;
};

export type GitCommitWorkflowResult = WorkspaceApplyResult | GitCommitResult;

export type GitCommitWorkflow = {
  commit(input: GitCommitWorkflowInput): Promise<GitCommitWorkflowResult>;
};

function buildGitCommitRequest(input: GitCommitWorkflowInput): GitCommitRequest {
  return {
    executionId: input.plan.executionId,
    repositoryDir: input.plan.targetWorkspaceDir,
    changes: input.plan.changes,
    expectedSnapshot: input.plan.sourceSnapshot,
    commitMessage: input.commitMessage,
    ...(input.expectedBranch !== undefined ? { expectedBranch: input.expectedBranch } : {}),
  };
}

function shouldCommit(applyResult: WorkspaceApplyResult): boolean {
  return applyResult.status === "APPLIED";
}

function buildExecutionIdMismatchResult(plan: WorkspaceApplyPlan): WorkspaceApplyRejectedResult {
  return {
    executionId: plan.executionId,
    status: "REJECTED",
    reasons: [
      {
        code: "INVALID_PLAN",
        message: "applyResult.executionId must match plan.executionId",
      },
    ],
  };
}

export function createGitCommitWorkflow(adapter: GitCommitAdapter): GitCommitWorkflow {
  return {
    async commit(input: GitCommitWorkflowInput): Promise<GitCommitWorkflowResult> {
      if (!shouldCommit(input.applyResult)) {
        return input.applyResult;
      }

      if (input.applyResult.executionId !== input.plan.executionId) {
        return buildExecutionIdMismatchResult(input.plan);
      }

      return await adapter.commit(buildGitCommitRequest(input));
    },
  };
}
