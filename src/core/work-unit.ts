export type WorkUnitStatus = "READY" | "RUNNING";

export type WorkUnitScope = {
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
};

export type WorkUnit = {
  readonly id: string;
  readonly domain: string;
  readonly phase: string;
  readonly status: WorkUnitStatus;
  readonly scope: WorkUnitScope;
};
