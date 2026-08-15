import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProjectAdapter, type ProjectAdapterContext } from "../src/project-adapter/index.js";
import { createProjectSupervisor } from "../src/project-supervisor/index.js";

type ConsumerInput = {
  readonly workUnitId: string;
  readonly domain: string;
  readonly phase: string;
  readonly allowedPaths: string[];
  readonly forbiddenPaths: string[];
  readonly authorized: boolean;
  readonly authorizationReason?: string;
};

function createContext(overrides: Partial<ConsumerInput> = {}): ProjectAdapterContext<ConsumerInput> {
  return {
    executionId: "exec-1",
    input: {
      workUnitId: "unit-1",
      domain: "consumer",
      phase: "delivery",
      allowedPaths: ["src/app"],
      forbiddenPaths: [],
      authorized: true,
      ...overrides,
    },
  };
}

describe("Project supervisor facade", () => {
  it("expõe a fronteira pública de supervisão para o consumidor", async () => {
    const supervisor = createProjectSupervisor(
      createProjectAdapter<ConsumerInput>({
        projectName: "consumer-app",
        buildWorkUnit: (context) => ({
          id: context.input.workUnitId,
          domain: context.input.domain,
          phase: context.input.phase,
          status: "READY",
          scope: {
            allowedPaths: context.input.allowedPaths,
            forbiddenPaths: context.input.forbiddenPaths,
          },
        }),
        buildAuthorization: () => ({
          isAuthorized: true,
        }),
      }),
    );

    const result = await supervisor.supervise(createContext());

    assert.equal(supervisor.projectName, "consumer-app");
    assert.equal(result.execution.executionId, "exec-1");
    assert.equal(result.execution.workUnitId, "unit-1");
    assert.equal(result.decision.state, "RUNNING");
  });

  it("preserva o bloqueio factual da composição do adapter", async () => {
    const supervisor = createProjectSupervisor(
      createProjectAdapter<ConsumerInput>({
        projectName: "consumer-app",
        buildWorkUnit: (context) => ({
          id: context.input.workUnitId,
          domain: context.input.domain,
          phase: context.input.phase,
          status: "READY",
          scope: {
            allowedPaths: context.input.allowedPaths,
            forbiddenPaths: context.input.forbiddenPaths,
          },
        }),
        buildAuthorization: (context) => ({
          isAuthorized: context.input.authorized,
          ...(context.input.authorizationReason !== undefined
            ? { reason: context.input.authorizationReason }
            : {}),
        }),
      }),
    );

    const result = await supervisor.supervise(
      createContext({
        authorized: false,
        authorizationReason: "consumer policy denied execution",
      }),
    );

    assert.equal(result.decision.state, "BLOCKED");
    if (result.decision.state === "BLOCKED") {
      assert.equal(result.decision.nextAction, "REJECT_WORK_UNIT");
      assert.deepEqual(result.decision.reasons, [
        {
          code: "UNAUTHORIZED",
          category: "AUTHORIZATION",
          message: "consumer policy denied execution",
        },
      ]);
    }
  });
});
