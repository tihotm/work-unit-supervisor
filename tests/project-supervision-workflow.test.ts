import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProjectAdapter, type ProjectAdapterContext } from "../src/project-adapter/index.js";
import { createProjectSupervisionWorkflow } from "../src/workflow/index.js";

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

describe("Project supervision workflow", () => {
  it("compõe adapter e core em um resultado de supervisão RUNNING", async () => {
    const workflow = createProjectSupervisionWorkflow(
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

    const result = await workflow.supervise(createContext());

    assert.deepEqual(result, {
      schemaVersion: 1,
      execution: {
        executionId: "exec-1",
        workUnitId: "unit-1",
        domain: "consumer",
        phase: "delivery",
      },
      decision: {
        state: "RUNNING",
        reasons: [],
        evidences: [
          {
            code: "AUTHORIZED",
            category: "AUTHORIZATION",
            message: "Autorização declarativa confirmada para a unidade de trabalho.",
            source: "declarative-authorization",
          },
          {
            code: "NO_INCONSISTENCIES",
            category: "VALIDATION",
            message: "Nenhuma inconsistência detectada nos dados declarados.",
            source: "supervisor-core",
          },
          {
            code: "WORK_UNIT_STRUCTURE_VALID",
            category: "VALIDATION",
            message: "Estrutura da WorkUnit validada com sucesso.",
            source: "supervisor-core",
          },
        ],
      },
    });
  });

  it("preserva bloqueio factual do core quando o adapter compõe entrada inválida para autorização", async () => {
    const workflow = createProjectSupervisionWorkflow(
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

    const result = await workflow.supervise(
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
    assert.deepEqual(result.execution, {
      executionId: "exec-1",
      workUnitId: "unit-1",
      domain: "consumer",
      phase: "delivery",
    });
  });
});
