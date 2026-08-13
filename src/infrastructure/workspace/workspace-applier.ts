import { createHash } from "node:crypto";
import { open, copyFile, lstat, mkdir, realpath, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { captureWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-snapshotter.js";
import { mapWorkspaceDiff, type WorkspaceFileChange } from "./workspace-diff-mapper.js";
import { assertWritableWorkspacePath, normalizeWorkspaceRelativePath, resolveSafeWorkspacePath } from "./workspace-path-guard.js";

export type WorkspaceApplyReasonCode =
  | "INVALID_PLAN"
  | "INVALID_PATH"
  | "UNSUPPORTED_CHANGE_TYPE"
  | "CHANGE_IDENTITY_MISMATCH"
  | "BASE_DIVERGED"
  | "TARGET_LOCKED"
  | "SOURCE_DIVERGED"
  | "APPLY_FAILED"
  | "ROLLBACK_FAILED"
  | "RECOVERY_INCOMPLETE";

export type WorkspaceApplyReason = {
  readonly code: WorkspaceApplyReasonCode;
  readonly message: string;
  readonly path?: string;
};

export type WorkspaceApplyAppliedResult = {
  readonly executionId: string;
  readonly status: "APPLIED";
  readonly appliedPaths: readonly string[];
};

export type WorkspaceApplyRejectedResult = {
  readonly executionId: string;
  readonly status: "REJECTED";
  readonly reasons: readonly WorkspaceApplyReason[];
};

export type WorkspaceApplyFailedResult = {
  readonly executionId: string;
  readonly status: "FAILED";
  readonly reasons: readonly WorkspaceApplyReason[];
};

export type WorkspaceApplyResult =
  | WorkspaceApplyAppliedResult
  | WorkspaceApplyRejectedResult
  | WorkspaceApplyFailedResult;

export type WorkspaceApplyPlanInput = {
  readonly executionId: string;
  readonly sourceWorkspaceDir: string;
  readonly targetWorkspaceDir: string;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly baseSnapshot: WorkspaceSnapshot;
  readonly sourceSnapshot: WorkspaceSnapshot;
  readonly changes: readonly WorkspaceFileChange[];
};

export type WorkspaceApplyPlan = {
  readonly executionId: string;
  readonly sourceWorkspaceDir: string;
  readonly targetWorkspaceDir: string;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly baseSnapshot: WorkspaceSnapshot;
  readonly sourceSnapshot: WorkspaceSnapshot;
  readonly baseFingerprint: string;
  readonly sourceFingerprint: string;
  readonly changeFingerprint: string;
  readonly changes: readonly WorkspaceFileChange[];
};

export type WorkspaceApplyLock = {
  readonly lockPath: string;
  release(): Promise<void>;
};

type NormalizedPathScope = {
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
};

type ApplyStep = {
  readonly change: WorkspaceFileChange;
  readonly relativePath: string;
  readonly targetPath: string;
  readonly sourcePath?: string;
  readonly backupPath?: string;
  readonly tempPath?: string;
  readonly createdDirectories: readonly string[];
};

type PreApplyTargetState = {
  readonly mirrorRoot: string;
  readonly directoryPaths: readonly string[];
};

const LOCK_NAMESPACE = join(tmpdir(), "work-unit-supervisor", "workspace-applier-locks");

export const workspaceApplyRuntime = {
  rmdir,
} as const;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const relativePath = relative(rootReal, candidateReal);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function resolveValidatedWorkspaceRoot(rootDir: string): Promise<string> {
  const resolvedRoot = resolve(rootDir);
  const rootStats = await lstat(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("INVALID_PATH");
  }

  return await realpath(resolvedRoot);
}

async function removeCreatedDirectories(createdDirectories: readonly string[]): Promise<void> {
  const uniqueDirectories = [...new Set(createdDirectories)].sort((left, right) => {
    const leftDepth = left.split(sep).length;
    const rightDepth = right.split(sep).length;
    if (leftDepth !== rightDepth) {
      return rightDepth - leftDepth;
    }
    return compareStrings(right, left);
  });

  let failure: unknown;
  for (const directory of uniqueDirectories) {
    try {
      await workspaceApplyRuntime.rmdir(directory);
    } catch (error) {
      if (failure === undefined) {
        failure = error;
      }
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
}

async function captureWorkspaceDirectories(rootDir: string): Promise<string[]> {
  const rootCanonical = await resolveValidatedWorkspaceRoot(rootDir);
  const directories: string[] = [];

  async function walk(currentDir: string, relativeDir: string): Promise<void> {
    const dirEntries = await readdir(currentDir, { withFileTypes: true });
    dirEntries.sort((left, right) => compareStrings(left.name, right.name));

    for (const entry of dirEntries) {
      const absolutePath = join(currentDir, entry.name);
      const entryStats = await lstat(absolutePath);
      if (entryStats.isSymbolicLink()) {
        throw new Error("INVALID_PATH");
      }

      if (entry.isDirectory()) {
        const childRelativeDir = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        directories.push(childRelativeDir);
        await walk(absolutePath, childRelativeDir);
        continue;
      }

      if (!entry.isFile()) {
        throw new Error("INVALID_PATH");
      }
    }
  }

  await walk(rootCanonical, "");
  return directories;
}

async function capturePreApplyTargetState(plan: WorkspaceApplyPlan, mirrorRoot: string): Promise<PreApplyTargetState> {
  await mkdir(mirrorRoot, { recursive: true });
  const directoryPaths = await captureWorkspaceDirectories(plan.targetWorkspaceDir);

  for (const entry of plan.baseSnapshot) {
    const sourcePath = await resolveSafeWorkspacePath(plan.targetWorkspaceDir, entry.relativePath);
    const mirrorPath = resolve(mirrorRoot, entry.relativePath);
    await mkdir(dirname(mirrorPath), { recursive: true });
    await copyFile(sourcePath, mirrorPath);
  }

  return {
    mirrorRoot,
    directoryPaths,
  };
}

async function restoreTargetFromMirror(plan: WorkspaceApplyPlan, preApplyTargetState: PreApplyTargetState): Promise<void> {
  const basePaths = new Set(plan.baseSnapshot.map((entry) => entry.relativePath));
  const currentSnapshot = await captureWorkspaceSnapshot(plan.targetWorkspaceDir);

  for (const entry of currentSnapshot) {
    if (basePaths.has(entry.relativePath)) {
      continue;
    }

    const currentPath = await resolveSafeWorkspacePath(plan.targetWorkspaceDir, entry.relativePath);
    await rm(currentPath, { force: true }).catch(() => undefined);
  }

  for (const entry of plan.baseSnapshot) {
    const mirrorPath = resolve(preApplyTargetState.mirrorRoot, entry.relativePath);
    const targetPath = resolve(plan.targetWorkspaceDir, entry.relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    const safeTargetPath = await assertWritableWorkspacePath(plan.targetWorkspaceDir, targetPath);
    await copyFile(mirrorPath, safeTargetPath);
  }

  const currentDirectories = await captureWorkspaceDirectories(plan.targetWorkspaceDir);
  const baseDirectoryPaths = new Set(preApplyTargetState.directoryPaths);
  const extraDirectories = currentDirectories.filter((directoryPath) => !baseDirectoryPaths.has(directoryPath));
  await removeCreatedDirectories(extraDirectories);
}

async function verifyRestoredTargetState(
  plan: WorkspaceApplyPlan,
  preApplyTargetState: PreApplyTargetState,
): Promise<boolean> {
  const restoredSnapshot = await captureWorkspaceSnapshot(plan.targetWorkspaceDir);
  if (JSON.stringify(restoredSnapshot) !== JSON.stringify(plan.baseSnapshot)) {
    return false;
  }

  const restoredDirectories = await captureWorkspaceDirectories(plan.targetWorkspaceDir);
  const expectedDirectories = [...preApplyTargetState.directoryPaths].sort(compareStrings);
  const sortedRestoredDirectories = [...restoredDirectories].sort(compareStrings);
  return JSON.stringify(sortedRestoredDirectories) === JSON.stringify(expectedDirectories);
}

async function restoreTargetStateWithVerification(
  plan: WorkspaceApplyPlan,
  preApplyTargetState: PreApplyTargetState,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await restoreTargetFromMirror(plan, preApplyTargetState);
    if (await verifyRestoredTargetState(plan, preApplyTargetState)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (await verifyRestoredTargetState(plan, preApplyTargetState)) {
        return true;
      }
    }
  }

  return false;
}

function buildReason(code: WorkspaceApplyReasonCode, message: string, path?: string): WorkspaceApplyReason {
  return path
    ? { code, message, path }
    : { code, message };
}

function buildRejected(executionId: string, code: WorkspaceApplyReasonCode, message: string, path?: string): WorkspaceApplyRejectedResult {
  return {
    executionId,
    status: "REJECTED",
    reasons: [buildReason(code, message, path)],
  };
}

function buildFailed(executionId: string, code: WorkspaceApplyReasonCode, message: string, path?: string): WorkspaceApplyFailedResult {
  return {
    executionId,
    status: "FAILED",
    reasons: [buildReason(code, message, path)],
  };
}

function normalizeSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return [...snapshot]
    .map((entry) => ({
      relativePath: entry.relativePath,
      contentHash: entry.contentHash,
    }))
    .sort((left, right) => {
      const pathCompare = compareStrings(left.relativePath, right.relativePath);
      if (pathCompare !== 0) {
        return pathCompare;
      }
      return compareStrings(left.contentHash, right.contentHash);
    });
}

function fingerprintSnapshot(snapshot: WorkspaceSnapshot): string {
  const canonical = normalizeSnapshot(snapshot)
    .map((entry) => `${entry.relativePath}\u0000${entry.contentHash}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeChange(change: WorkspaceFileChange): WorkspaceFileChange {
  switch (change.type) {
    case "ADDED":
    case "MODIFIED":
    case "DELETED": {
      const relativePath = normalizeWorkspaceRelativePath(change.path);
      if (!relativePath) {
        throw new Error("INVALID_PATH");
      }
      return {
        type: change.type,
        path: relativePath,
      };
    }
    default:
      throw new Error("UNSUPPORTED_CHANGE_TYPE");
  }
}

function normalizeChangeSet(changes: readonly WorkspaceFileChange[]): WorkspaceFileChange[] {
  const normalizedByPath = new Map<string, WorkspaceFileChange>();

  for (const change of changes) {
    const normalized = normalizeChange(change);
    if (normalizedByPath.has(normalized.path)) {
      throw new Error("INVALID_PLAN");
    }
    normalizedByPath.set(normalized.path, normalized);
  }

  return [...normalizedByPath.values()].sort((left, right) => {
    const pathCompare = compareStrings(left.path, right.path);
    if (pathCompare !== 0) {
      return pathCompare;
    }
    return compareStrings(left.type, right.type);
  });
}

function fingerprintChangeSet(changes: readonly WorkspaceFileChange[]): string {
  const canonical = [...changes]
    .map((change) => `${change.type}\u0000${change.path}`)
    .sort((left, right) => compareStrings(left, right))
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeScope(rawPaths: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const rawPath of rawPaths) {
    const relativePath = normalizeWorkspaceRelativePath(rawPath);
    if (!relativePath) {
      throw new Error("INVALID_PATH");
    }
    normalized.add(relativePath);
  }
  return [...normalized].sort(compareStrings);
}

function isPathInsideScope(path: string, scope: readonly string[]): boolean {
  return scope.some((candidate) => path === candidate || path.startsWith(`${candidate}/`));
}

function fingerprintWorkspacePlan(snapshot: WorkspaceSnapshot): string {
  return fingerprintSnapshot(snapshot);
}

function readWorkspaceSnapshotEntry(snapshot: WorkspaceSnapshot, relativePath: string): WorkspaceSnapshot[number] | undefined {
  return snapshot.find((entry) => entry.relativePath === relativePath);
}

async function buildLockPath(targetWorkspaceDir: string): Promise<string> {
  const targetCanonical = await resolveValidatedWorkspaceRoot(targetWorkspaceDir);
  const hash = createHash("sha256").update(targetCanonical).digest("hex");
  return join(LOCK_NAMESPACE, `${hash}.lock`);
}

async function buildStagingRoot(plan: WorkspaceApplyPlan): Promise<string> {
  const targetCanonical = await resolveValidatedWorkspaceRoot(plan.targetWorkspaceDir);
  const targetHash = createHash("sha256").update(targetCanonical).digest("hex");
  const executionHash = createHash("sha256").update(plan.executionId).digest("hex");
  return join(dirname(targetCanonical), `.wus-apply-${executionHash}-${targetHash}`);
}

function buildApplyFailureReason(error: unknown): WorkspaceApplyReason {
  if (error instanceof Error) {
    switch (error.message) {
      case "INVALID_PLAN":
        return buildReason("INVALID_PLAN", "O plano de apply é inválido.");
      case "INVALID_PATH":
        return buildReason("INVALID_PATH", "Um caminho inválido foi detectado no plano de apply.");
      case "UNSUPPORTED_CHANGE_TYPE":
        return buildReason("UNSUPPORTED_CHANGE_TYPE", "O plano contém um tipo de alteração não suportado.");
      case "CHANGE_IDENTITY_MISMATCH":
        return buildReason("CHANGE_IDENTITY_MISMATCH", "O conjunto de mudanças não corresponde à identidade auditada.");
      case "BASE_DIVERGED":
        return buildReason("BASE_DIVERGED", "A base do target divergiu da base auditada.");
      case "TARGET_LOCKED":
        return buildReason("TARGET_LOCKED", "O workspace alvo já está bloqueado.");
      case "SOURCE_DIVERGED":
        return buildReason("SOURCE_DIVERGED", "A origem do apply divergiu do snapshot auditado.");
      default:
        return buildReason("APPLY_FAILED", error.message);
    }
  }

  return buildReason("APPLY_FAILED", String(error));
}

function mapApplyError(executionId: string, error: unknown): WorkspaceApplyResult {
  const reason = buildApplyFailureReason(error);

  switch (reason.code) {
    case "INVALID_PLAN":
    case "INVALID_PATH":
    case "UNSUPPORTED_CHANGE_TYPE":
    case "CHANGE_IDENTITY_MISMATCH":
    case "BASE_DIVERGED":
    case "TARGET_LOCKED":
    case "SOURCE_DIVERGED":
      return buildRejected(executionId, reason.code, reason.message, reason.path);
    default:
      return buildFailed(executionId, reason.code, reason.message, reason.path);
  }
}

function validatePlanShape(plan: WorkspaceApplyPlan): void {
  if (!plan.executionId || !plan.sourceWorkspaceDir || !plan.targetWorkspaceDir) {
    throw new Error("INVALID_PLAN");
  }

  if (!plan.allowedPaths || !plan.forbiddenPaths) {
    throw new Error("INVALID_PLAN");
  }
}

function validatePlanPaths(plan: WorkspaceApplyPlan, normalizedChanges: readonly WorkspaceFileChange[]): NormalizedPathScope {
  const allowedPaths = normalizeScope(plan.allowedPaths);
  const forbiddenPaths = normalizeScope(plan.forbiddenPaths);

  for (const change of normalizedChanges) {
    if (!isPathInsideScope(change.path, allowedPaths) || isPathInsideScope(change.path, forbiddenPaths)) {
      throw new Error("INVALID_PATH");
    }
  }

  return {
    allowedPaths,
    forbiddenPaths,
  };
}

export async function acquireWorkspaceApplyLock(targetWorkspaceDir: string): Promise<WorkspaceApplyLock> {
  if (!targetWorkspaceDir) {
    throw new Error("INVALID_PLAN");
  }

  await mkdir(LOCK_NAMESPACE, { recursive: true });
  const lockPath = await buildLockPath(targetWorkspaceDir);

  try {
    const handle = await open(lockPath, "wx");
    return {
      lockPath,
      async release() {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
    if (code === "EEXIST") {
      throw new Error("TARGET_LOCKED");
    }
    throw error;
  }
}

async function captureValidSnapshot(rootDir: string, failureCode: "BASE_DIVERGED" | "SOURCE_DIVERGED"): Promise<WorkspaceSnapshot> {
  try {
    return await captureWorkspaceSnapshot(rootDir);
  } catch {
    throw new Error(failureCode);
  }
}

async function validateCurrentTargetBase(plan: WorkspaceApplyPlan): Promise<WorkspaceSnapshot> {
  const currentTargetSnapshot = await captureValidSnapshot(plan.targetWorkspaceDir, "BASE_DIVERGED");
  if (fingerprintWorkspacePlan(currentTargetSnapshot) !== plan.baseFingerprint) {
    throw new Error("BASE_DIVERGED");
  }
  return currentTargetSnapshot;
}

async function validateCurrentSourceState(plan: WorkspaceApplyPlan): Promise<WorkspaceSnapshot> {
  const currentSourceSnapshot = await captureValidSnapshot(plan.sourceWorkspaceDir, "SOURCE_DIVERGED");
  if (fingerprintWorkspacePlan(currentSourceSnapshot) !== plan.sourceFingerprint) {
    throw new Error("SOURCE_DIVERGED");
  }
  return currentSourceSnapshot;
}

async function prepareWritableTargetPath(rootDir: string, relativePath: string): Promise<{
  readonly targetPath: string;
  readonly createdDirectories: readonly string[];
}> {
  const rootReal = await resolveValidatedWorkspaceRoot(rootDir);
  const targetPath = resolve(rootReal, relativePath);
  if (!isInsideRoot(rootReal, targetPath)) {
    throw new Error("INVALID_PATH");
  }

  const createdDirectories: string[] = [];
  const parentPath = dirname(targetPath);
  const relativeParent = relative(rootReal, parentPath);
  const parentSegments = relativeParent ? relativeParent.split(sep).filter(Boolean) : [];

  let currentDirectory = rootReal;

  try {
    for (const segment of parentSegments) {
      const nextDirectory = join(currentDirectory, segment);
      const nextStats = await lstat(nextDirectory).catch(() => undefined);

      if (nextStats) {
        if (!nextStats.isDirectory() || nextStats.isSymbolicLink()) {
          throw new Error("INVALID_PATH");
        }

        const nextReal = await realpath(nextDirectory);
        if (!isInsideRoot(rootReal, nextReal)) {
          throw new Error("INVALID_PATH");
        }

        currentDirectory = nextReal;
        continue;
      }

      const parentStats = await lstat(currentDirectory);
      if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
        throw new Error("INVALID_PATH");
      }

      const parentReal = await realpath(currentDirectory);
      if (!isInsideRoot(rootReal, parentReal)) {
        throw new Error("INVALID_PATH");
      }

      await mkdir(nextDirectory);
      createdDirectories.push(nextDirectory);
      currentDirectory = nextDirectory;
    }

    const validatedTargetPath = await assertWritableWorkspacePath(rootDir, targetPath);
    return {
      targetPath: validatedTargetPath,
      createdDirectories,
    };
  } catch (error) {
    await removeCreatedDirectories(createdDirectories);
    throw error;
  }
}

async function stageBackup(sourcePath: string, backupPath: string): Promise<void> {
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(sourcePath, backupPath);
}

async function copySourceFileToTarget(rootDir: string, relativePath: string, sourcePath: string, tempPath: string): Promise<void> {
  await mkdir(dirname(tempPath), { recursive: true });
  const targetPath = await assertWritableWorkspacePath(rootDir, resolve(rootDir, relativePath));
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function rollbackSteps(steps: readonly ApplyStep[], createdDirectories: readonly string[]): Promise<void> {
  let failure: unknown;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.change.type === "ADDED") {
      try {
        await rm(step.targetPath, { force: true });
      } catch (error) {
        if (failure === undefined) {
          failure = error;
        }
      }
      if (step.tempPath) {
        try {
          await rm(step.tempPath, { force: true });
        } catch (error) {
          if (failure === undefined) {
            failure = error;
          }
        }
      }
      continue;
    }

    if (step.backupPath) {
      try {
        await rm(step.targetPath, { force: true });
      } catch (error) {
        if (failure === undefined) {
          failure = error;
        }
      }
      try {
        await copyFile(step.backupPath, step.targetPath);
      } catch (error) {
        if (failure === undefined) {
          failure = error;
        }
      }
    }
  }

  try {
    await removeCreatedDirectories(createdDirectories);
  } catch (error) {
    if (failure === undefined) {
      failure = error;
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
}

async function prepareChangeStep(
  plan: WorkspaceApplyPlan,
  change: WorkspaceFileChange,
  currentTargetSnapshot: WorkspaceSnapshot,
  currentSourceSnapshot: WorkspaceSnapshot,
  stagingRoot: string,
): Promise<ApplyStep> {
  const baseEntry = readWorkspaceSnapshotEntry(plan.baseSnapshot, change.path);
  const sourceEntry = readWorkspaceSnapshotEntry(plan.sourceSnapshot, change.path);
  const currentTargetEntry = readWorkspaceSnapshotEntry(currentTargetSnapshot, change.path);
  const currentSourceEntry = readWorkspaceSnapshotEntry(currentSourceSnapshot, change.path);
  const hashSuffix = createHash("sha256").update(change.path).digest("hex");
  const backupPath = join(stagingRoot, `${hashSuffix}.bak`);
  const tempPath = join(stagingRoot, `${hashSuffix}.tmp`);
  const targetPath = resolve(plan.targetWorkspaceDir, change.path);

  switch (change.type) {
    case "ADDED": {
      if (baseEntry || currentTargetEntry) {
        throw new Error("BASE_DIVERGED");
      }
      if (!sourceEntry || !currentSourceEntry || sourceEntry.contentHash !== currentSourceEntry.contentHash) {
        throw new Error("SOURCE_DIVERGED");
      }
      const sourcePath = await resolveSafeWorkspacePath(plan.sourceWorkspaceDir, change.path);
      const existingTarget = await lstat(targetPath).catch(() => undefined);
      if (existingTarget) {
        throw new Error("BASE_DIVERGED");
      }
      const { targetPath: safeTargetPath, createdDirectories } = await prepareWritableTargetPath(plan.targetWorkspaceDir, change.path);
      return {
        change,
        relativePath: change.path,
        sourcePath,
        targetPath: safeTargetPath,
        tempPath,
        createdDirectories,
      };
    }
    case "MODIFIED": {
      if (!baseEntry || !currentTargetEntry || currentTargetEntry.contentHash !== baseEntry.contentHash) {
        throw new Error("BASE_DIVERGED");
      }
      if (!sourceEntry || !currentSourceEntry || sourceEntry.contentHash !== currentSourceEntry.contentHash) {
        throw new Error("SOURCE_DIVERGED");
      }
      const sourcePath = await resolveSafeWorkspacePath(plan.sourceWorkspaceDir, change.path);
      const existingTarget = await lstat(targetPath).catch(() => undefined);
      if (!existingTarget || !existingTarget.isFile()) {
        throw new Error("BASE_DIVERGED");
      }
      const safeTargetPath = await assertWritableWorkspacePath(plan.targetWorkspaceDir, targetPath);
      return {
        change,
        relativePath: change.path,
        sourcePath,
        targetPath: safeTargetPath,
        backupPath,
        tempPath,
        createdDirectories: [],
      };
    }
    case "DELETED": {
      if (!baseEntry || !currentTargetEntry || currentTargetEntry.contentHash !== baseEntry.contentHash) {
        throw new Error("BASE_DIVERGED");
      }
      if (sourceEntry || currentSourceEntry) {
        throw new Error("SOURCE_DIVERGED");
      }
      const existingTarget = await lstat(targetPath).catch(() => undefined);
      if (!existingTarget || !existingTarget.isFile()) {
        throw new Error("BASE_DIVERGED");
      }
      const safeTargetPath = await assertWritableWorkspacePath(plan.targetWorkspaceDir, targetPath);
      return {
        change,
        relativePath: change.path,
        targetPath: safeTargetPath,
        backupPath,
        createdDirectories: [],
      };
    }
    default:
      throw new Error("UNSUPPORTED_CHANGE_TYPE");
  }
}

export function createWorkspaceApplyPlan(input: WorkspaceApplyPlanInput): WorkspaceApplyPlan {
  validatePlanShape({
    executionId: input.executionId,
    sourceWorkspaceDir: input.sourceWorkspaceDir,
    targetWorkspaceDir: input.targetWorkspaceDir,
    allowedPaths: input.allowedPaths,
    forbiddenPaths: input.forbiddenPaths,
    baseSnapshot: input.baseSnapshot,
    sourceSnapshot: input.sourceSnapshot,
    changes: input.changes,
    baseFingerprint: "",
    sourceFingerprint: "",
    changeFingerprint: "",
  });

  const baseSnapshot = normalizeSnapshot(input.baseSnapshot);
  const sourceSnapshot = normalizeSnapshot(input.sourceSnapshot);
  const normalizedChanges = normalizeChangeSet(input.changes);
  const expectedChanges = mapWorkspaceDiff(baseSnapshot, sourceSnapshot);

  if (fingerprintChangeSet(normalizedChanges) !== fingerprintChangeSet(expectedChanges)) {
    throw new Error("CHANGE_IDENTITY_MISMATCH");
  }

  const allowedPaths = normalizeScope(input.allowedPaths);
  const forbiddenPaths = normalizeScope(input.forbiddenPaths);

  for (const change of normalizedChanges) {
    if (!isPathInsideScope(change.path, allowedPaths) || isPathInsideScope(change.path, forbiddenPaths)) {
      throw new Error("INVALID_PATH");
    }
  }

  return {
    executionId: input.executionId,
    sourceWorkspaceDir: resolve(input.sourceWorkspaceDir),
    targetWorkspaceDir: resolve(input.targetWorkspaceDir),
    allowedPaths,
    forbiddenPaths,
    baseSnapshot,
    sourceSnapshot,
    baseFingerprint: fingerprintWorkspacePlan(baseSnapshot),
    sourceFingerprint: fingerprintWorkspacePlan(sourceSnapshot),
    changeFingerprint: fingerprintChangeSet(normalizedChanges),
    changes: normalizedChanges,
  };
}

export async function applyWorkspacePlan(plan: WorkspaceApplyPlan): Promise<WorkspaceApplyResult> {
  const appliedSteps: ApplyStep[] = [];
  const appliedPaths: string[] = [];
  const createdDirectories: string[] = [];
  let lock: WorkspaceApplyLock | undefined;
  let stagingRoot: string | undefined;
  let preApplyTargetState: PreApplyTargetState | undefined;

  try {
    validatePlanShape(plan);
    const normalizedChanges = normalizeChangeSet(plan.changes);
    validatePlanPaths(plan, normalizedChanges);

    if (fingerprintChangeSet(normalizedChanges) !== plan.changeFingerprint) {
      return buildRejected(plan.executionId, "CHANGE_IDENTITY_MISMATCH", "O conjunto de mudanças não corresponde ao plano auditado.");
    }

    if (fingerprintWorkspacePlan(plan.baseSnapshot) !== plan.baseFingerprint) {
      return buildRejected(plan.executionId, "INVALID_PLAN", "A identidade da base registrada no plano é inválida.");
    }

    if (fingerprintWorkspacePlan(plan.sourceSnapshot) !== plan.sourceFingerprint) {
      return buildRejected(plan.executionId, "INVALID_PLAN", "A identidade da fonte registrada no plano é inválida.");
    }

    await validateCurrentTargetBase(plan);
    await validateCurrentSourceState(plan);

    try {
      lock = await acquireWorkspaceApplyLock(plan.targetWorkspaceDir);
    } catch (error) {
      if (error instanceof Error && error.message === "TARGET_LOCKED") {
        return buildRejected(plan.executionId, "TARGET_LOCKED", "O workspace alvo já está em uso por outro apply.");
      }
      throw error;
    }

    await validateCurrentTargetBase(plan);
    await validateCurrentSourceState(plan);

    stagingRoot = await buildStagingRoot(plan);
    await mkdir(stagingRoot, { recursive: true });
    preApplyTargetState = await capturePreApplyTargetState(plan, join(stagingRoot, "target-mirror"));

    for (const change of normalizedChanges) {
      const currentTargetSnapshot = await validateCurrentTargetBase(plan);
      const currentSourceSnapshot = await validateCurrentSourceState(plan);
      const step = await prepareChangeStep(plan, change, currentTargetSnapshot, currentSourceSnapshot, stagingRoot);
      for (const directory of step.createdDirectories) {
        if (!createdDirectories.includes(directory)) {
          createdDirectories.push(directory);
        }
      }
      if (step.change.type === "ADDED") {
        if (!step.sourcePath || !step.tempPath) {
          throw new Error("INVALID_PLAN");
        }
        await copySourceFileToTarget(plan.targetWorkspaceDir, step.relativePath, step.sourcePath, step.tempPath);
        appliedSteps.push(step);
        appliedPaths.push(step.relativePath);
        continue;
      }

      if (step.change.type === "MODIFIED") {
      if (!step.sourcePath || !step.backupPath || !step.tempPath) {
        throw new Error("INVALID_PLAN");
      }
      await stageBackup(step.targetPath, step.backupPath);
      const safeTargetPath = await assertWritableWorkspacePath(plan.targetWorkspaceDir, step.targetPath);
      await rm(safeTargetPath, { force: true });
      appliedSteps.push(step);
      try {
        await copySourceFileToTarget(plan.targetWorkspaceDir, step.relativePath, step.sourcePath, step.tempPath);
        appliedPaths.push(step.relativePath);
        continue;
      } catch (error) {
        await copyFile(step.backupPath, step.targetPath).catch(() => undefined);
        throw error;
        }
      }

      if (!step.backupPath) {
        throw new Error("INVALID_PLAN");
      }
      await stageBackup(step.targetPath, step.backupPath);
      const safeTargetPath = await assertWritableWorkspacePath(plan.targetWorkspaceDir, step.targetPath);
      await rm(safeTargetPath, { force: true });
      appliedSteps.push(step);
      appliedPaths.push(step.relativePath);
    }

    const finalTargetSnapshot = await captureWorkspaceSnapshot(plan.targetWorkspaceDir);
    if (fingerprintWorkspacePlan(finalTargetSnapshot) !== plan.sourceFingerprint) {
      throw new Error("CHANGE_IDENTITY_MISMATCH");
    }

    return {
      executionId: plan.executionId,
      status: "APPLIED",
      appliedPaths: [...appliedPaths].sort(compareStrings),
    };
  } catch (error) {
    const failureReason = buildApplyFailureReason(error);
    try {
      await rollbackSteps(appliedSteps, createdDirectories);
      if (preApplyTargetState) {
        try {
          const restored = await restoreTargetStateWithVerification(plan, preApplyTargetState);
          if (!restored) {
            return {
              executionId: plan.executionId,
              status: "FAILED",
              reasons: [
                failureReason,
                buildReason("RECOVERY_INCOMPLETE", "O workspace alvo não pôde ser restaurado ao snapshot pré-apply."),
              ],
            };
          }
        } catch (recoveryError) {
          return {
            executionId: plan.executionId,
            status: "FAILED",
            reasons: [
              failureReason,
              buildReason(
                "RECOVERY_INCOMPLETE",
                recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
              ),
            ],
          };
        }
      }
    } catch (rollbackError) {
      return {
        executionId: plan.executionId,
        status: "FAILED",
        reasons: [
          failureReason,
          buildReason("ROLLBACK_FAILED", rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
        ],
      };
    }

    return mapApplyError(plan.executionId, error);
  } finally {
    if (lock) {
      await lock.release().catch(() => undefined);
    }
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
