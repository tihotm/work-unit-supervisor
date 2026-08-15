import type { WorkUnit } from "../core/work-unit.js";
import type {
  SupervisorAuthorization,
  SupervisorInput,
  SupervisorPrecondition,
  SupervisorRequiredEvidence,
} from "../core/supervisor.js";

export type ProjectAdapterContext<TProjectInput> = {
  readonly executionId: string;
  readonly input: TProjectInput;
};

export type ProjectAdapterDefinition<TProjectInput> = {
  readonly projectName: string;
  readonly buildWorkUnit: (context: ProjectAdapterContext<TProjectInput>) => WorkUnit;
  readonly buildAuthorization: (context: ProjectAdapterContext<TProjectInput>) => SupervisorAuthorization;
  readonly buildPreconditions?: (
    context: ProjectAdapterContext<TProjectInput>,
  ) => readonly SupervisorPrecondition[];
  readonly buildCapabilities?: (
    context: ProjectAdapterContext<TProjectInput>,
  ) => readonly string[];
  readonly buildRequiredCapabilities?: (
    context: ProjectAdapterContext<TProjectInput>,
  ) => readonly string[];
  readonly buildRequiredEvidences?: (
    context: ProjectAdapterContext<TProjectInput>,
  ) => readonly SupervisorRequiredEvidence[];
};

export type ProjectAdapter<TProjectInput> = {
  readonly projectName: string;
  toSupervisorInput(context: ProjectAdapterContext<TProjectInput>): SupervisorInput;
};

function normalizeProjectName(projectName: string): string {
  if (typeof projectName !== "string" || projectName.trim().length === 0) {
    throw new Error("INVALID_PROJECT_NAME");
  }

  return projectName.trim();
}

function cloneAuthorization(authorization: SupervisorAuthorization): SupervisorAuthorization {
  return authorization.reason === undefined
    ? { isAuthorized: authorization.isAuthorized }
    : { isAuthorized: authorization.isAuthorized, reason: authorization.reason };
}

function cloneWorkUnit(workUnit: WorkUnit): WorkUnit {
  return {
    ...workUnit,
    scope: {
      allowedPaths: [...workUnit.scope.allowedPaths],
      forbiddenPaths: [...workUnit.scope.forbiddenPaths],
    },
  };
}

function clonePreconditions(preconditions: readonly SupervisorPrecondition[]): SupervisorPrecondition[] {
  return preconditions.map((precondition) => ({ ...precondition }));
}

function cloneCapabilities(capabilities: readonly string[]): string[] {
  return [...capabilities];
}

function cloneRequiredEvidences(
  evidences: readonly SupervisorRequiredEvidence[],
): SupervisorRequiredEvidence[] {
  return evidences.map((evidence) => ({ ...evidence }));
}

export function createProjectAdapter<TProjectInput>(
  definition: ProjectAdapterDefinition<TProjectInput>,
): ProjectAdapter<TProjectInput> {
  const projectName = normalizeProjectName(definition.projectName);

  return {
    projectName,
    toSupervisorInput(context: ProjectAdapterContext<TProjectInput>): SupervisorInput {
      return {
        workUnit: cloneWorkUnit(definition.buildWorkUnit(context)),
        authorization: cloneAuthorization(definition.buildAuthorization(context)),
        preconditions: clonePreconditions(definition.buildPreconditions?.(context) ?? []),
        capabilities: cloneCapabilities(definition.buildCapabilities?.(context) ?? []),
        requiredCapabilities: cloneCapabilities(
          definition.buildRequiredCapabilities?.(context) ?? [],
        ),
        requiredEvidences: cloneRequiredEvidences(
          definition.buildRequiredEvidences?.(context) ?? [],
        ),
      };
    },
  };
}
