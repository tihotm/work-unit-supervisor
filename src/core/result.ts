import type { WorkUnit } from "./work-unit.js";
import type { SupervisorDecision, SupervisorEvidence, SupervisorReason } from "./supervisor.js";

export type SupervisorExecution = {
  readonly executionId: string;
  readonly workUnitId: string;
  readonly domain: string;
  readonly phase: string;
};

export type SupervisorResult = {
  readonly schemaVersion: 1;
  readonly execution: SupervisorExecution;
  readonly decision: SupervisorDecision;
};

function cloneReason(reason: SupervisorReason): SupervisorReason {
  switch (reason.code) {
    case "PATH_CONFLICT":
      return {
        ...reason,
        conflictingPaths: [...reason.conflictingPaths],
      };
    default:
      return { ...reason };
  }
}

function cloneEvidence(evidence: SupervisorEvidence): SupervisorEvidence {
  return { ...evidence };
}

function cloneDecision(decision: SupervisorDecision): SupervisorDecision {
  if (decision.state === "RUNNING") {
    return {
      state: decision.state,
      reasons: decision.reasons.map(cloneReason),
      evidences: decision.evidences.map(cloneEvidence),
    };
  }

  return {
    state: decision.state,
    nextAction: decision.nextAction,
    reasons: decision.reasons.map(cloneReason),
    evidences: decision.evidences.map(cloneEvidence),
  };
}

export function buildSupervisorResult(
  executionId: string,
  workUnit: WorkUnit,
  decision: SupervisorDecision,
): SupervisorResult {
  return {
    schemaVersion: 1,
    execution: {
      executionId,
      workUnitId: workUnit.id,
      domain: workUnit.domain,
      phase: workUnit.phase,
    },
    decision: cloneDecision(decision),
  };
}
