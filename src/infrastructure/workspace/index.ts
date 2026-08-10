export { createWorkspaceSandbox, type WorkspaceSandbox } from "./workspace-sandbox.js";
export {
  captureWorkspaceSnapshot,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotEntry,
} from "./workspace-snapshotter.js";
export {
  mapWorkspaceDiff,
  type WorkspaceDiff,
  type WorkspaceFileChange,
} from "./workspace-diff-mapper.js";
export {
  assertWritableWorkspacePath,
  normalizeWorkspaceRelativePath,
  resolveSafeWorkspacePath,
} from "./workspace-path-guard.js";
export {
  acquireWorkspaceApplyLock,
  applyWorkspacePlan,
  createWorkspaceApplyPlan,
  type WorkspaceApplyAppliedResult,
  type WorkspaceApplyFailedResult,
  type WorkspaceApplyLock,
  type WorkspaceApplyPlan,
  type WorkspaceApplyPlanInput,
  type WorkspaceApplyReason,
  type WorkspaceApplyReasonCode,
  type WorkspaceApplyRejectedResult,
  type WorkspaceApplyResult,
} from "./workspace-applier.js";
