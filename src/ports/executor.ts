import type { WorkUnit } from "../core/work-unit.js";

export type ExecutorLimits = {
  readonly timeoutMs?: number;
  readonly maxCommands?: number;
  readonly maxChangedFiles?: number;
};

export type ExecutorInput = {
  readonly executionId: string;
  readonly workUnit: WorkUnit;
  readonly limits?: ExecutorLimits;
};

export type ExecutorReason = {
  readonly code: string;
  readonly message: string;
};

type ExecutorFacts = {
  readonly changedFiles: readonly string[];
  readonly executedCommands: readonly string[];
};

export type ExecutorSucceededResult = ExecutorFacts & {
  readonly status: "SUCCEEDED";
  readonly exitCode: 0;
  readonly reasons?: never;
};

export type ExecutorBlockedResult = ExecutorFacts & {
  readonly status: "BLOCKED";
  readonly reasons: readonly ExecutorReason[];
};

export type ExecutorFailedResult = ExecutorFacts & {
  readonly status: "FAILED";
  readonly reasons: readonly ExecutorReason[];
  readonly exitCode?: number;
};

export type ExecutorCancelledResult = ExecutorFacts & {
  readonly status: "CANCELLED";
  readonly reasons: readonly ExecutorReason[];
};

export type ExecutorResult =
  | ExecutorSucceededResult
  | ExecutorBlockedResult
  | ExecutorFailedResult
  | ExecutorCancelledResult;

export interface ExecutorPort {
  execute(input: ExecutorInput): Promise<ExecutorResult>;
}
