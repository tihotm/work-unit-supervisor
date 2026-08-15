import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProjectAdapter, type ProjectAdapterContext } from "../src/project-adapter/index.js";

type ConsumerInput = {
  readonly workUnitId: string;
  readonly domain: string;
  readonly phase: string;
  readonly allowedPaths: string[];
  readonly forbiddenPaths: string[];
  readonly authorized: boolean;
  readonly authorizationReason?: string;
  readonly preconditions: Array<{ id: string; isSatisfied: boolean }>;
  readonly capabilities: string[];
  readonly requiredCapabilities: string[];
  readonly requiredEvidences: Array<{ id: string; isPresent: boolean }>;
};

function createContext(overrides: Partial<ConsumerInput> = {}): ProjectAdapterContext<ConsumerInput> {
  const input: ConsumerInput = {
    workUnitId: "unit-1",
    domain: "consumer",
    phase: "delivery",
    allowedPaths: ["src/app"],
    forbiddenPaths: ["src/app/forbidden"],
    authorized: true,
    preconditions: [{ id: "db-ready", isSatisfied: true }],
    capabilities: ["EXECUTOR", "DIFF_AUDITOR"],
    requiredCapabilities: ["EXECUTOR"],
    requiredEvidences: [{ id: "audit-report", isPresent: true }],
    ...overrides,
  };

  return {
    executionId: "exec-1",
    input,
  };
}

describe("Project adapter boundary", () => {
  it("compõe contexto do consumidor em SupervisorInput sem tocar no core", () => {
    const adapter = createProjectAdapter<ConsumerInput>({
      projectName: "  consumer-app  ",
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
      buildPreconditions: (context) => context.input.preconditions,
      buildCapabilities: (context) => context.input.capabilities,
      buildRequiredCapabilities: (context) => context.input.requiredCapabilities,
      buildRequiredEvidences: (context) => context.input.requiredEvidences,
    });

    const result = adapter.toSupervisorInput(createContext());

    assert.equal(adapter.projectName, "consumer-app");
    assert.deepEqual(result, {
      workUnit: {
        id: "unit-1",
        domain: "consumer",
        phase: "delivery",
        status: "READY",
        scope: {
          allowedPaths: ["src/app"],
          forbiddenPaths: ["src/app/forbidden"],
        },
      },
      authorization: {
        isAuthorized: true,
      },
      preconditions: [{ id: "db-ready", isSatisfied: true }],
      capabilities: ["EXECUTOR", "DIFF_AUDITOR"],
      requiredCapabilities: ["EXECUTOR"],
      requiredEvidences: [{ id: "audit-report", isPresent: true }],
    });
  });

  it("faz cópias defensivas das listas e do WorkUnit composto", () => {
    const context = createContext();
    const adapter = createProjectAdapter<ConsumerInput>({
      projectName: "consumer-app",
      buildWorkUnit: (input) => ({
        id: input.input.workUnitId,
        domain: input.input.domain,
        phase: input.input.phase,
        status: "READY",
        scope: {
          allowedPaths: input.input.allowedPaths,
          forbiddenPaths: input.input.forbiddenPaths,
        },
      }),
      buildAuthorization: (input) => ({
        isAuthorized: input.input.authorized,
        ...(input.input.authorizationReason !== undefined
          ? { reason: input.input.authorizationReason }
          : {}),
      }),
      buildPreconditions: (input) => input.input.preconditions,
      buildCapabilities: (input) => input.input.capabilities,
      buildRequiredCapabilities: (input) => input.input.requiredCapabilities,
      buildRequiredEvidences: (input) => input.input.requiredEvidences,
    });

    const result = adapter.toSupervisorInput(context);

    assert.notStrictEqual(result.workUnit, context.input);
    assert.notStrictEqual(result.workUnit.scope.allowedPaths, context.input.allowedPaths);
    assert.notStrictEqual(result.workUnit.scope.forbiddenPaths, context.input.forbiddenPaths);
    assert.notStrictEqual(result.preconditions, context.input.preconditions);
    assert.notStrictEqual(result.capabilities, context.input.capabilities);
    assert.notStrictEqual(result.requiredCapabilities, context.input.requiredCapabilities);
    assert.notStrictEqual(result.requiredEvidences, context.input.requiredEvidences);

    context.input.allowedPaths.push("src/app/new");
    context.input.preconditions[0]!.isSatisfied = false;
    context.input.capabilities.push("OPENHANDS");
    context.input.requiredCapabilities.push("OBSERVABILITY");
    context.input.requiredEvidences[0]!.isPresent = false;

    assert.deepEqual(result.workUnit.scope.allowedPaths, ["src/app"]);
    assert.deepEqual(result.preconditions, [{ id: "db-ready", isSatisfied: true }]);
    assert.deepEqual(result.capabilities, ["EXECUTOR", "DIFF_AUDITOR"]);
    assert.deepEqual(result.requiredCapabilities, ["EXECUTOR"]);
    assert.deepEqual(result.requiredEvidences, [{ id: "audit-report", isPresent: true }]);
  });

  it("falha fechado para nome de projeto vazio", () => {
    assert.throws(
      () =>
        createProjectAdapter<ConsumerInput>({
          projectName: "   ",
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
          }),
        }),
      /INVALID_PROJECT_NAME/,
    );
  });
});
