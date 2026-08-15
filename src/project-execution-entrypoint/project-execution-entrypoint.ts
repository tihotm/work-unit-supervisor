import type { SupervisorResult } from "../core/index.js";
import type { ExecutorInput, ExecutorPort, ExecutorResult } from "../ports/executor.js";
import type { ProjectAdapter, ProjectAdapterContext } from "../project-adapter/index.js";
import {
  createProjectExecutionWorkflow,
  type ProjectExecutionWorkflowInput,
  type ProjectExecutionWorkflowResult,
} from "../workflow/index.js";

export type ProjectExecutionEntrypointInput<TProjectInput> = ProjectAdapterContext<TProjectInput> & {
  readonly limits?: ExecutorInput["limits"];
};

export type ProjectExecutionEntrypointFailure = {
  readonly code: "ENTRYPOINT_FAILURE";
  readonly message: string;
};

export type ProjectExecutionEntrypointBlockedResult = {
  readonly status: "BLOCKED";
  readonly exitCode: 1;
  readonly supervision: SupervisorResult;
  readonly execution?: never;
};

export type ProjectExecutionEntrypointExecutedResult = {
  readonly status: Exclude<ExecutorResult["status"], "CANCELLED"> | "CANCELLED";
  readonly exitCode: 0 | 1;
  readonly supervision: SupervisorResult;
  readonly execution: ExecutorResult;
};

export type ProjectExecutionEntrypointFailedResult = {
  readonly status: "FAILED";
  readonly exitCode: 1;
  readonly error: ProjectExecutionEntrypointFailure;
};

export type ProjectExecutionEntrypointResult =
  | ProjectExecutionEntrypointBlockedResult
  | ProjectExecutionEntrypointExecutedResult
  | ProjectExecutionEntrypointFailedResult;

export type ProjectExecutionEntrypoint<TProjectInput> = {
  readonly projectName: string;
  run(input: ProjectExecutionEntrypointInput<TProjectInput>): Promise<ProjectExecutionEntrypointResult>;
};

function cloneError(error: unknown): ProjectExecutionEntrypointFailure {
  return {
    code: "ENTRYPOINT_FAILURE",
    message: error instanceof Error ? error.message : String(error),
  };
}

function mapWorkflowResult(
  result: ProjectExecutionWorkflowResult,
): ProjectExecutionEntrypointBlockedResult | ProjectExecutionEntrypointExecutedResult {
  if (!("execution" in result)) {
    return {
      status: "BLOCKED",
      exitCode: 1,
      supervision: result.supervision,
    };
  }

  const exitCode: 0 | 1 = result.execution.status === "SUCCEEDED" ? 0 : 1;

  return {
    status: result.execution.status,
    exitCode,
    supervision: result.supervision,
    execution: result.execution,
  };
}

export function createProjectExecutionEntrypoint<TProjectInput>(
  adapter: ProjectAdapter<TProjectInput>,
  executor: ExecutorPort,
): ProjectExecutionEntrypoint<TProjectInput> {
  const workflow = createProjectExecutionWorkflow(adapter, executor);

  return {
    projectName: adapter.projectName,
    async run(
      input: ProjectExecutionEntrypointInput<TProjectInput>,
    ): Promise<ProjectExecutionEntrypointResult> {
      try {
        const workflowInput: ProjectExecutionWorkflowInput<TProjectInput> = input;
        const result = await workflow.execute(workflowInput);
        return mapWorkflowResult(result);
      } catch (error) {
        return {
          status: "FAILED",
          exitCode: 1,
          error: cloneError(error),
        };
      }
    },
  };
}
