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
  return {
    code: reason.code,
    category: reason.category,
    message: reason.message,
    ...(reason.details !== undefined ? { details: structuredClone(reason.details) } : {}),
  };
}

function cloneEvidence(evidence: SupervisorEvidence): SupervisorEvidence {
  return {
    code: evidence.code,
    category: evidence.category,
    message: evidence.message,
    source: evidence.source,
    ...(evidence.details !== undefined ? { details: structuredClone(evidence.details) } : {}),
  };
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
