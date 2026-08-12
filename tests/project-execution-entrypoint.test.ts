import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProjectAdapter, type ProjectAdapterContext } from "../src/project-adapter/index.js";
import { createProjectExecutionEntrypoint } from "../src/project-execution-entrypoint/index.js";
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

describe("Project execution entrypoint", () => {
  it("executa o workflow e normaliza sucesso em saída determinística", async () => {
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

    const entrypoint = createProjectExecutionEntrypoint(createAdapter(), executor);
    const result = await entrypoint.run(
      createContext({
        allowedPaths: ["src/app", "src/shared"],
      }),
    );

    assert.equal(entrypoint.projectName, "consumer-app");
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.exitCode, 0);
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
    });
  });

  it("retorna bloqueio fechado quando a supervisão bloqueia", async () => {
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

    const entrypoint = createProjectExecutionEntrypoint(createAdapter(), executor);
    const result = await entrypoint.run(
      createContext({
        authorized: false,
        authorizationReason: "consumer policy denied execution",
      }),
    );

    assert.equal(executorCalls, 0);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.exitCode, 1);
    if (result.status === "BLOCKED") {
      assert.equal(result.supervision.decision.state, "BLOCKED");
      assert.deepEqual(result.supervision.decision.reasons, [
        {
          code: "UNAUTHORIZED",
          category: "AUTHORIZATION",
          message: "consumer policy denied execution",
        },
      ]);
    }
  });

  it("falha fechado com erro determinístico quando o executor lança", async () => {
    const executor: ExecutorPort = {
      async execute() {
        throw new Error("runtime exploded");
      },
    };

    const entrypoint = createProjectExecutionEntrypoint(createAdapter(), executor);
    const result = await entrypoint.run(createContext());

    assert.equal(result.status, "FAILED");
    assert.equal(result.exitCode, 1);
    if ("error" in result) {
      assert.deepEqual(result.error, {
        code: "ENTRYPOINT_FAILURE",
        message: "runtime exploded",
      });
    } else {
      assert.fail("expected failed entrypoint result");
    }
  });
});
