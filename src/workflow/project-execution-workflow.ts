import type { ExecutorInput, ExecutorPort, ExecutorResult } from "../ports/executor.js";
import { buildSupervisorResult, decideSupervisor, type SupervisorResult } from "../core/index.js";
import type { ProjectAdapter, ProjectAdapterContext } from "../project-adapter/index.js";

export type ProjectExecutionWorkflowInput<TProjectInput> = ProjectAdapterContext<TProjectInput> & {
  readonly limits?: ExecutorInput["limits"];
};

export type ProjectExecutionWorkflowBlockedResult = {
  readonly supervision: SupervisorResult;
  readonly execution?: never;
};

export type ProjectExecutionWorkflowExecutedResult = {
  readonly supervision: SupervisorResult;
  readonly execution: ExecutorResult;
};

export type ProjectExecutionWorkflowResult =
  | ProjectExecutionWorkflowBlockedResult
  | ProjectExecutionWorkflowExecutedResult;

export type ProjectExecutionWorkflow<TProjectInput> = {
  execute(input: ProjectExecutionWorkflowInput<TProjectInput>): Promise<ProjectExecutionWorkflowResult>;
};

export function createProjectExecutionWorkflow<TProjectInput>(
  adapter: ProjectAdapter<TProjectInput>,
  executor: ExecutorPort,
): ProjectExecutionWorkflow<TProjectInput> {
  return {
    async execute(input: ProjectExecutionWorkflowInput<TProjectInput>): Promise<ProjectExecutionWorkflowResult> {
      const supervisorInput = adapter.toSupervisorInput(input);
      const decision = decideSupervisor(supervisorInput);
      const supervision = buildSupervisorResult(input.executionId, supervisorInput.workUnit, decision);

      if (decision.state !== "RUNNING") {
        return {
          supervision,
        };
      }

      const execution = await executor.execute({
        executionId: input.executionId,
        workUnit: supervisorInput.workUnit,
        ...(input.limits !== undefined ? { limits: input.limits } : {}),
      });

      return {
        supervision,
        execution,
      };
    },
  };
}
