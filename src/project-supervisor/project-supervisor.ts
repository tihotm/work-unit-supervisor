import type { SupervisorResult } from "../core/index.js";
import type { ProjectAdapter, ProjectAdapterContext } from "../project-adapter/index.js";
import { createProjectSupervisionWorkflow, type ProjectSupervisionWorkflow } from "../workflow/index.js";

export type ProjectSupervisor<TProjectInput> = {
  readonly projectName: string;
  supervise(input: ProjectAdapterContext<TProjectInput>): Promise<SupervisorResult>;
};

export function createProjectSupervisor<TProjectInput>(
  adapter: ProjectAdapter<TProjectInput>,
): ProjectSupervisor<TProjectInput> {
  const workflow: ProjectSupervisionWorkflow<TProjectInput> = createProjectSupervisionWorkflow(adapter);

  return {
    projectName: adapter.projectName,
    async supervise(input: ProjectAdapterContext<TProjectInput>): Promise<SupervisorResult> {
      return await workflow.supervise(input);
    },
  };
}
