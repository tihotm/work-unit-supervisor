import type { WorkUnit } from "../core/work-unit.js";

export type RuntimeBridgeReason = {
  readonly code: string;
  readonly message: string;
};

export type RuntimeBridgeInput = {
  readonly executionId: string;
  readonly workspaceDir: string;
  readonly workUnit: WorkUnit;
  readonly signal?: AbortSignal;
};

export type RuntimeBridgeRunningObservation = {
  readonly executionId: string;
  readonly status: "RUNNING";
};

export type RuntimeBridgeSucceededResult = {
  readonly executionId: string;
  readonly status: "SUCCEEDED";
  readonly exitCode: 0;
  readonly reasons?: never;
  readonly executedCommands: readonly string[];
};

export type RuntimeBridgeFailedResult = {
  readonly executionId: string;
  readonly status: "FAILED";
  readonly reasons: readonly RuntimeBridgeReason[];
  readonly exitCode?: number;
  readonly executedCommands: readonly string[];
};

export type RuntimeBridgeCancelledResult = {
  readonly executionId: string;
  readonly status: "CANCELLED";
  readonly reasons: readonly RuntimeBridgeReason[];
  readonly executedCommands: readonly string[];
};

export type RuntimeBridgeResult =
  | RuntimeBridgeSucceededResult
  | RuntimeBridgeFailedResult
  | RuntimeBridgeCancelledResult;

export type RuntimeBridgeObservation = RuntimeBridgeRunningObservation | RuntimeBridgeResult;

export interface RuntimeBridgeSession {
  readonly executionId: string;
  status(): Promise<RuntimeBridgeObservation>;
  cancel(): Promise<void>;
  result(): Promise<RuntimeBridgeResult>;
}

export interface RuntimeBridgeEngine {
  execute(input: RuntimeBridgeInput): Promise<RuntimeBridgeResult>;
  cancel(executionId: string): Promise<void>;
}

export interface RuntimeBridge {
  start(input: RuntimeBridgeInput): Promise<RuntimeBridgeSession>;
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

function cloneInput(input: RuntimeBridgeInput): RuntimeBridgeInput {
  return {
    executionId: input.executionId,
    workspaceDir: input.workspaceDir,
    workUnit: cloneWorkUnit(input.workUnit),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function cloneReason(reason: RuntimeBridgeReason): RuntimeBridgeReason {
  return {
    code: reason.code,
    message: reason.message,
  };
}

function cloneResult(result: RuntimeBridgeResult): RuntimeBridgeResult {
  const executedCommands = [...result.executedCommands];
  if (result.status === "SUCCEEDED") {
    return {
      executionId: result.executionId,
      status: "SUCCEEDED",
      exitCode: result.exitCode,
      executedCommands,
    };
  }

  if (result.status === "FAILED") {
    const failedResult: RuntimeBridgeFailedResult = {
      executionId: result.executionId,
      status: "FAILED",
      reasons: result.reasons.map(cloneReason),
      executedCommands,
    };
    if (typeof result.exitCode === "number") {
      return {
        ...failedResult,
        exitCode: result.exitCode,
      };
    }
    return failedResult;
  }

  return {
    executionId: result.executionId,
    status: "CANCELLED",
    reasons: result.reasons.map(cloneReason),
    executedCommands,
  };
}

function cloneObservation(observation: RuntimeBridgeObservation): RuntimeBridgeObservation {
  if (observation.status === "RUNNING") {
    return {
      executionId: observation.executionId,
      status: "RUNNING",
    };
  }

  return cloneResult(observation);
}

function createFailedResult(executionId: string, error: unknown): RuntimeBridgeFailedResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    executionId,
    status: "FAILED",
    reasons: [
      {
        code: "RUNTIME_BRIDGE_FAILURE",
        message,
      },
    ],
    executedCommands: [],
  };
}

export function createRuntimeBridge(engine: RuntimeBridgeEngine): RuntimeBridge {
  if (!engine || typeof engine.execute !== "function" || typeof engine.cancel !== "function") {
    throw new Error("RUNTIME_BRIDGE_ENGINE_INVALID");
  }

  return {
    async start(input: RuntimeBridgeInput): Promise<RuntimeBridgeSession> {
      const executionInput = cloneInput(input);
      let observation: RuntimeBridgeObservation = {
        executionId: executionInput.executionId,
        status: "RUNNING",
      };

      const resultPromise = Promise.resolve()
        .then(() => engine.execute(executionInput))
        .then(
        (result) => {
          observation = cloneResult(result);
          return cloneResult(result);
        },
        (error) => {
          observation = createFailedResult(executionInput.executionId, error);
          return cloneResult(observation);
        },
      );

      return {
        executionId: executionInput.executionId,
        async status(): Promise<RuntimeBridgeObservation> {
          return cloneObservation(observation);
        },
        async cancel(): Promise<void> {
          await engine.cancel(executionInput.executionId);
        },
        async result(): Promise<RuntimeBridgeResult> {
          return cloneResult(await resultPromise);
        },
      };
    },
  };
}
