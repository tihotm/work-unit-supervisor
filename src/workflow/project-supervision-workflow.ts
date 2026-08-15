import { buildSupervisorResult, decideSupervisor, type SupervisorResult } from "../core/index.js";
import type { ProjectAdapter, ProjectAdapterContext } from "../project-adapter/index.js";

export type ProjectSupervisionWorkflowInput<TProjectInput> = ProjectAdapterContext<TProjectInput>;

export type ProjectSupervisionWorkflowResult = SupervisorResult;

export type ProjectSupervisionWorkflow<TProjectInput> = {
  supervise(input: ProjectSupervisionWorkflowInput<TProjectInput>): Promise<ProjectSupervisionWorkflowResult>;
};

export function createProjectSupervisionWorkflow<TProjectInput>(
  adapter: ProjectAdapter<TProjectInput>,
): ProjectSupervisionWorkflow<TProjectInput> {
  return {
    async supervise(input: ProjectSupervisionWorkflowInput<TProjectInput>): Promise<ProjectSupervisionWorkflowResult> {
      const supervisorInput = adapter.toSupervisorInput(input);
      const decision = decideSupervisor(supervisorInput);

      return buildSupervisorResult(input.executionId, supervisorInput.workUnit, decision);
    },
  };
}
