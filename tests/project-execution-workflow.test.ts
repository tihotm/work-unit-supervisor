import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProjectAdapter, type ProjectAdapterContext } from "../src/project-adapter/index.js";
import { createProjectExecutionWorkflow } from "../src/workflow/index.js";
import type { ExecutorInput, ExecutorPort } from "../src/ports/index.js";

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

function createAdapter() {
  return createProjectAdapter<ConsumerInput>({
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
  });
}

describe("Project execution workflow", () => {
  it("supervisiona e executa quando o core libera a unidade", async () => {
    let seenInput: ExecutorInput | undefined;
    const executor: ExecutorPort = {
      async execute(input) {
        seenInput = input;
        return {
          status: "SUCCEEDED",
          changedFiles: ["src/app/index.ts"],
          executedCommands: ["npm test"],
          exitCode: 0,
        };
      },
    };

    const workflow = createProjectExecutionWorkflow(createAdapter(), executor);

    const result = await workflow.execute({
      ...createContext({
        allowedPaths: ["src/app", "src/shared"],
      }),
      limits: {
        timeoutMs: 250,
        maxCommands: 5,
        maxChangedFiles: 3,
      },
    });

    assert.equal(result.supervision.decision.state, "RUNNING");
    assert.deepEqual(result.execution, {
      status: "SUCCEEDED",
      changedFiles: ["src/app/index.ts"],
      executedCommands: ["npm test"],
      exitCode: 0,
    });
    assert.deepEqual(seenInput, {
      executionId: "exec-1",
      workUnit: {
        id: "unit-1",
        domain: "consumer",
        phase: "delivery",
        status: "READY",
        scope: {
          allowedPaths: ["src/app", "src/shared"],
          forbiddenPaths: [],
        },
      },
      limits: {
        timeoutMs: 250,
        maxCommands: 5,
        maxChangedFiles: 3,
      },
    });
  });

  it("não chama o executor quando a supervisão bloqueia", async () => {
    let executorCalls = 0;
    const executor: ExecutorPort = {
      async execute() {
        executorCalls += 1;
        return {
          status: "SUCCEEDED",
          changedFiles: [],
          executedCommands: [],
          exitCode: 0,
        };
      },
    };

    const workflow = createProjectExecutionWorkflow(
      createAdapter(),
      executor,
    );

    const result = await workflow.execute(
      createContext({
        authorized: false,
        authorizationReason: "consumer policy denied execution",
      }),
    );

    assert.equal(executorCalls, 0);
    assert.equal(result.supervision.decision.state, "BLOCKED");
    assert.ok(!("execution" in result));
    if (result.supervision.decision.state === "BLOCKED") {
      assert.equal(result.supervision.decision.nextAction, "REJECT_WORK_UNIT");
      assert.deepEqual(result.supervision.decision.reasons, [
        {
          code: "UNAUTHORIZED",
          category: "AUTHORIZATION",
          message: "consumer policy denied execution",
        },
      ]);
    }
  });
});
