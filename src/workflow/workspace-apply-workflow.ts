import type { DiffAuditReason, DiffAuditRejectedResult, DiffAuditResult } from "../diff-auditor/index.js";
import { applyWorkspacePlan, type WorkspaceApplyPlan, type WorkspaceApplyReason, type WorkspaceApplyResult } from "../infrastructure/workspace/index.js";

function mapAuditReason(reason: DiffAuditReason): WorkspaceApplyReason {
  switch (reason.code) {
    case "INVALID_CHANGE":
      return {
        code: "UNSUPPORTED_CHANGE_TYPE",
        message: reason.message,
      };
    case "INVALID_PATH":
    case "PATH_NOT_ALLOWED":
    case "PATH_FORBIDDEN":
      return {
        code: "INVALID_PATH",
        message: reason.message,
        path: reason.path,
      };
    case "INVALID_INPUT":
    case "INVALID_WORK_UNIT_STRUCTURE":
    case "INVALID_WORK_UNIT_STATUS":
      return {
        code: "INVALID_PLAN",
        message: reason.message,
      };
    default:
      return {
        code: "INVALID_PLAN",
        message: "Razão de auditoria inválida.",
      };
  }
}

function rejectAuditedPlan(plan: WorkspaceApplyPlan, auditResult: DiffAuditRejectedResult): WorkspaceApplyResult {
  return {
    executionId: plan.executionId,
    status: "REJECTED",
    reasons: auditResult.reasons.map(mapAuditReason),
  };
}

export async function applyAuditedWorkspacePlan(plan: WorkspaceApplyPlan, auditResult: DiffAuditResult): Promise<WorkspaceApplyResult> {
  if (auditResult.status === "REJECTED") {
    return rejectAuditedPlan(plan, auditResult);
  }

  return await applyWorkspacePlan(plan);
}
