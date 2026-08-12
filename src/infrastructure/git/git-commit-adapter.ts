import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, realpath, readFile, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { WorkspaceFileChange } from "../workspace/workspace-diff-mapper.js";
import { normalizeWorkspaceRelativePath, resolveSafeWorkspacePath } from "../workspace/workspace-path-guard.js";
import type { WorkspaceSnapshot, WorkspaceSnapshotEntry } from "../workspace/workspace-snapshotter.js";

const execFileAsync = promisify(execFile);
const LOCK_NAMESPACE = join(tmpdir(), "work-unit-supervisor", "git-commit-locks");

export type GitCommitReasonCode =
  | "NOT_A_GIT_REPOSITORY"
  | "INDEX_NOT_CLEAN"
  | "DETACHED_HEAD"
  | "BRANCH_MISMATCH"
  | "INVALID_PATH"
  | "UNSUPPORTED_CHANGE"
  | "CHANGE_IDENTITY_MISMATCH"
  | "STAGE_FAILED"
  | "STAGED_CHANGE_SET_MISMATCH"
  | "TARGET_LOCKED"
  | "COMMIT_FAILED"
  | "HOOK_MUTATED_WORKSPACE";

export type GitCommitReason = {
  readonly code: GitCommitReasonCode;
  readonly message: string;
  readonly path?: string;
};

export type GitCommitRequest = {
  readonly executionId: string;
  readonly repositoryDir: string;
  readonly changes: readonly WorkspaceFileChange[];
  readonly expectedSnapshot: WorkspaceSnapshot;
  readonly commitMessage: string;
  readonly expectedBranch?: string;
};

export type GitCommitCommittedResult = {
  readonly executionId: string;
  readonly status: "COMMITTED";
  readonly commitSha: string;
  readonly branch: string;
  readonly committedPaths: readonly string[];
};

export type GitCommitRejectedResult = {
  readonly executionId: string;
  readonly status: "REJECTED";
  readonly reasons: readonly GitCommitReason[];
};

export type GitCommitFailedResult = {
  readonly executionId: string;
  readonly status: "FAILED";
  readonly reasons: readonly GitCommitReason[];
};

export type GitCommitResult = GitCommitCommittedResult | GitCommitRejectedResult | GitCommitFailedResult;

export interface GitCommitAdapter {
  commit(request: GitCommitRequest): Promise<GitCommitResult>;
}

type GitCommandResult = {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

type NormalizedCommitChange = {
  readonly type: WorkspaceFileChange["type"];
  readonly path: string;
};

type CommitState = {
  readonly repoRoot: string;
  readonly repoLockIdentity: string;
  readonly branch: string;
  readonly expectedBranch: string | undefined;
  readonly normalizedChanges: readonly NormalizedCommitChange[];
  readonly expectedSnapshotByPath: ReadonlyMap<string, WorkspaceSnapshotEntry>;
  readonly expectedPaths: readonly string[];
  readonly commitMessage: string;
};

type GitLock = {
  readonly lockPath: string;
  release(): Promise<void>;
};

export const gitCommand = {
  async run(repoRoot: string, args: readonly string[]): Promise<GitCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync("git", ["-C", repoRoot, ...args], {
        encoding: "buffer",
        windowsHide: true,
      });
      return {
        code: 0,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
        stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
      };
    } catch (error) {
      if (typeof error === "object" && error !== null && "stdout" in error && "stderr" in error) {
        const commandError = error as {
          code?: number | string;
          stdout?: Buffer | string;
          stderr?: Buffer | string;
        };
        return {
          code: typeof commandError.code === "number" ? commandError.code : 1,
          stdout: Buffer.isBuffer(commandError.stdout) ? commandError.stdout : Buffer.from(commandError.stdout ?? ""),
          stderr: Buffer.isBuffer(commandError.stderr) ? commandError.stderr : Buffer.from(commandError.stderr ?? ""),
        };
      }
      throw error;
    }
  },
};

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeCanonicalPath(value: string): string {
  const stripped = value.startsWith("\\\\?\\UNC\\")
    ? `\\\\${value.slice(8)}`
    : value.startsWith("\\\\?\\")
      ? value.slice(4)
      : value;
  const normalized = stripped.replaceAll("/", "\\");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runGit(repoRoot: string, args: readonly string[]): Promise<GitCommandResult> {
  return gitCommand.run(repoRoot, args);
}

function buildReason(code: GitCommitReasonCode, message: string, path?: string): GitCommitReason {
  return path ? { code, message, path } : { code, message };
}

function buildRejected(executionId: string, code: GitCommitReasonCode, message: string, path?: string): GitCommitRejectedResult {
  return {
    executionId,
    status: "REJECTED",
    reasons: [buildReason(code, message, path)],
  };
}

function buildFailed(executionId: string, code: GitCommitReasonCode, message: string, path?: string): GitCommitFailedResult {
  return {
    executionId,
    status: "FAILED",
    reasons: [buildReason(code, message, path)],
  };
}

function buildExactPathSet(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort(compareStrings);
}

function ensureExactPathSet(actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length) {
    throw new Error("STAGED_CHANGE_SET_MISMATCH");
  }

  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error("STAGED_CHANGE_SET_MISMATCH");
    }
  }
}

function normalizeCommitMessage(commitMessage: string): string {
  if (typeof commitMessage !== "string" || commitMessage.trim().length === 0) {
    throw new Error("COMMIT_FAILED");
  }
  return commitMessage;
}

function normalizeCommitChange(change: WorkspaceFileChange): NormalizedCommitChange {
  switch (change.type) {
    case "ADDED":
    case "MODIFIED":
    case "DELETED": {
      const relativePath = normalizeWorkspaceRelativePath(change.path);
      if (!relativePath) {
        throw new Error("INVALID_PATH");
      }
      return { type: change.type, path: relativePath };
    }
    default:
      throw new Error("UNSUPPORTED_CHANGE");
  }
}

function normalizeCommitChanges(changes: readonly WorkspaceFileChange[]): readonly NormalizedCommitChange[] {
  const byPath = new Map<string, NormalizedCommitChange>();

  for (const change of changes) {
    const normalized = normalizeCommitChange(change);
    if (byPath.has(normalized.path)) {
      throw new Error("CHANGE_IDENTITY_MISMATCH");
    }
    byPath.set(normalized.path, normalized);
  }

  return [...byPath.values()].sort((left, right) => {
    const pathCompare = compareStrings(left.path, right.path);
    if (pathCompare !== 0) {
      return pathCompare;
    }
    return compareStrings(left.type, right.type);
  });
}

function normalizeExpectedSnapshot(snapshot: WorkspaceSnapshot): ReadonlyMap<string, WorkspaceSnapshotEntry> {
  const entries = new Map<string, WorkspaceSnapshotEntry>();

  for (const entry of snapshot) {
    const relativePath = normalizeWorkspaceRelativePath(entry.relativePath);
    if (!relativePath) {
      throw new Error("INVALID_PATH");
    }
    if (entries.has(relativePath)) {
      throw new Error("CHANGE_IDENTITY_MISMATCH");
    }
    entries.set(relativePath, {
      relativePath,
      contentHash: entry.contentHash,
    });
  }

  return entries;
}

function fingerprintChanges(changes: readonly NormalizedCommitChange[]): string {
  const canonical = [...changes]
    .map((change) => `${change.type}\u0000${change.path}`)
    .join("\n");
  return hashText(canonical);
}

function fingerprintSnapshot(snapshot: ReadonlyMap<string, WorkspaceSnapshotEntry>): string {
  const canonical = [...snapshot.values()]
    .map((entry) => `${entry.relativePath}\u0000${entry.contentHash}`)
    .sort((left, right) => compareStrings(left, right))
    .join("\n");
  return hashText(canonical);
}

async function canonicalizeRepositoryRoot(repositoryDir: string): Promise<string> {
  if (!repositoryDir) {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  const resolvedRepositoryDir = resolve(repositoryDir);
  const toplevel = await runGit(resolvedRepositoryDir, ["rev-parse", "--show-toplevel"]);
  if (toplevel.code !== 0) {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  const root = toplevel.stdout.toString("utf8").trim();
  if (!root) {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (!canonicalRoot) {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  const insideWorkTree = await runGit(canonicalRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.code !== 0 || insideWorkTree.stdout.toString("utf8").trim() !== "true") {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  return canonicalRoot;
}

async function acquireCommitLock(repoIdentity: string): Promise<GitLock> {
  await mkdir(LOCK_NAMESPACE, { recursive: true });
  const lockPath = join(LOCK_NAMESPACE, `${hashText(normalizeCanonicalPath(repoIdentity))}.lock`);

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

async function getCurrentBranch(repoRoot: string): Promise<string> {
  const result = await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.code !== 0) {
    throw new Error("DETACHED_HEAD");
  }

  const branch = result.stdout.toString("utf8").trim();
  if (!branch) {
    throw new Error("DETACHED_HEAD");
  }

  return branch;
}

async function validateExpectedBranch(repoRoot: string, expectedBranch?: string): Promise<string> {
  const branch = await getCurrentBranch(repoRoot);
  if (expectedBranch && branch !== expectedBranch) {
    throw new Error("BRANCH_MISMATCH");
  }

  return branch;
}

async function ensureIndexClean(repoRoot: string): Promise<void> {
  const result = await runGit(repoRoot, ["diff", "--cached", "--quiet", "--no-renames"]);
  if (result.code === 0) {
    return;
  }
  if (result.code === 1) {
    throw new Error("INDEX_NOT_CLEAN");
  }
  throw new Error(result.stderr.toString("utf8") || "INDEX_NOT_CLEAN");
}

async function readGitStatusPorcelain(repoRoot: string): Promise<string> {
  const result = await runGit(repoRoot, ["status", "--porcelain=v1", "-z"]);
  if (result.code !== 0) {
    throw new Error("COMMIT_FAILED");
  }

  return result.stdout.toString("utf8");
}

async function readCurrentFileHash(repoRoot: string, relativePath: string): Promise<string> {
  const absolutePath = await resolveSafeWorkspacePath(repoRoot, relativePath).catch(() => undefined);
  if (!absolutePath) {
    throw new Error("CHANGE_IDENTITY_MISMATCH");
  }

  const stats = await lstat(absolutePath).catch(() => undefined);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("CHANGE_IDENTITY_MISMATCH");
  }

  const bytes = await readFile(absolutePath);
  return hashBytes(bytes);
}

async function validateCurrentChangeState(
  repoRoot: string,
  change: NormalizedCommitChange,
  expectedSnapshotByPath: ReadonlyMap<string, WorkspaceSnapshotEntry>,
): Promise<void> {
  const expectedEntry = expectedSnapshotByPath.get(change.path);

  if (change.type === "DELETED") {
    if (expectedEntry) {
      throw new Error("CHANGE_IDENTITY_MISMATCH");
    }

    const absolutePath = resolve(repoRoot, change.path);
    const currentStats = await lstat(absolutePath).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return undefined;
      }
      throw error;
    });

    if (!currentStats) {
      return;
    }

    if (currentStats.isSymbolicLink()) {
      throw new Error("INVALID_PATH");
    }

    if (currentStats.isDirectory() || currentStats.isFile()) {
      throw new Error("CHANGE_IDENTITY_MISMATCH");
    }

    throw new Error("INVALID_PATH");
  }

  if (!expectedEntry) {
    throw new Error("CHANGE_IDENTITY_MISMATCH");
  }

  const currentHash = await readCurrentFileHash(repoRoot, change.path);
  if (currentHash !== expectedEntry.contentHash) {
    throw new Error("CHANGE_IDENTITY_MISMATCH");
  }
}

async function stageChange(repoRoot: string, change: NormalizedCommitChange): Promise<void> {
  const result = await runGit(repoRoot, ["add", "--", change.path]);
  if (result.code !== 0) {
    throw new Error("STAGE_FAILED");
  }
}

async function readStagedPathSet(repoRoot: string): Promise<readonly string[]> {
  const result = await runGit(repoRoot, ["diff", "--cached", "--name-only", "-z", "--no-renames"]);
  if (result.code !== 0) {
    throw new Error("STAGED_CHANGE_SET_MISMATCH");
  }

  return buildExactPathSet(result.stdout.toString("utf8").split("\0").filter((path) => path.length > 0));
}

async function readStagedBlobHash(repoRoot: string, relativePath: string): Promise<string> {
  const result = await runGit(repoRoot, ["show", `:${relativePath}`]);
  if (result.code !== 0) {
    throw new Error("CHANGE_IDENTITY_MISMATCH");
  }
  return hashBytes(result.stdout);
}

async function validateStagedChange(
  repoRoot: string,
  change: NormalizedCommitChange,
  expectedSnapshotByPath: ReadonlyMap<string, WorkspaceSnapshotEntry>,
): Promise<void> {
  const expectedEntry = expectedSnapshotByPath.get(change.path);

  if (change.type === "DELETED") {
    const indexLookup = await runGit(repoRoot, ["ls-files", "--stage", "--", change.path]);
    if (indexLookup.code !== 0) {
      throw new Error("STAGED_CHANGE_SET_MISMATCH");
    }
    if (indexLookup.stdout.toString("utf8").trim().length > 0) {
      throw new Error("STAGED_CHANGE_SET_MISMATCH");
    }
    return;
  }

  if (!expectedEntry) {
    throw new Error("CHANGE_IDENTITY_MISMATCH");
  }

  const stagedHash = await readStagedBlobHash(repoRoot, change.path);
  if (stagedHash !== expectedEntry.contentHash) {
    throw new Error("CHANGE_IDENTITY_MISMATCH");
  }
}

async function restoreStagedChanges(repoRoot: string, stagedPaths: readonly string[]): Promise<void> {
  if (stagedPaths.length === 0) {
    return;
  }

  const result = await runGit(repoRoot, ["restore", "--staged", "--", ...stagedPaths]);
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8") || "STAGE_FAILED");
  }
}

async function commitStagedChanges(repoRoot: string, commitMessage: string): Promise<void> {
  const result = await runGit(repoRoot, ["commit", "--message", commitMessage]);
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8") || "COMMIT_FAILED");
  }
}

async function getCommitSha(repoRoot: string): Promise<string> {
  return (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.toString("utf8").trim();
}

async function readCommittedPathSet(repoRoot: string): Promise<readonly string[]> {
  const result = await runGit(repoRoot, ["show", "--pretty=format:", "--name-only", "-z", "--no-renames", "HEAD"]);
  if (result.code !== 0) {
    throw new Error("COMMIT_FAILED");
  }

  return buildExactPathSet(result.stdout.toString("utf8").split("\0").filter((path) => path.length > 0));
}

async function validateCommittedContent(
  repoRoot: string,
  expectedPaths: readonly string[],
  expectedSnapshotByPath: ReadonlyMap<string, WorkspaceSnapshotEntry>,
): Promise<void> {
  const committedPaths = await readCommittedPathSet(repoRoot);
  ensureExactPathSet(committedPaths, expectedPaths);

  for (const path of expectedPaths) {
    const expectedEntry = expectedSnapshotByPath.get(path);
    if (!expectedEntry) {
      const pathInTree = await runGit(repoRoot, ["ls-tree", "--name-only", "HEAD", "--", path]);
      if (pathInTree.code !== 0 || pathInTree.stdout.toString("utf8").trim().length > 0) {
        throw new Error("CHANGE_IDENTITY_MISMATCH");
      }
      continue;
    }

    const actualBlob = await runGit(repoRoot, ["show", `HEAD:${path}`]);
    if (actualBlob.code !== 0) {
      throw new Error("CHANGE_IDENTITY_MISMATCH");
    }
    if (hashBytes(actualBlob.stdout) !== expectedEntry.contentHash) {
      throw new Error("CHANGE_IDENTITY_MISMATCH");
    }
  }
}

function buildRejectedForError(executionId: string, error: unknown): GitCommitRejectedResult | GitCommitFailedResult {
  const message = error instanceof Error ? error.message : String(error);

  switch (message) {
    case "NOT_A_GIT_REPOSITORY":
    case "INDEX_NOT_CLEAN":
    case "DETACHED_HEAD":
    case "BRANCH_MISMATCH":
    case "INVALID_PATH":
    case "UNSUPPORTED_CHANGE":
    case "CHANGE_IDENTITY_MISMATCH":
    case "STAGED_CHANGE_SET_MISMATCH":
    case "TARGET_LOCKED":
      return buildRejected(executionId, message, `Git commit rejeitado: ${message}.`);
    case "STAGE_FAILED":
    case "COMMIT_FAILED":
    case "HOOK_MUTATED_WORKSPACE":
      return buildFailed(executionId, message, `Git commit falhou: ${message}.`);
    default:
      return buildFailed(executionId, "COMMIT_FAILED", message);
  }
}

async function validateRequestShape(request: GitCommitRequest): Promise<void> {
  if (!request || typeof request !== "object") {
    throw new Error("COMMIT_FAILED");
  }

  if (typeof request.executionId !== "string" || request.executionId.trim().length === 0) {
    throw new Error("COMMIT_FAILED");
  }

  if (typeof request.repositoryDir !== "string" || request.repositoryDir.trim().length === 0) {
    throw new Error("COMMIT_FAILED");
  }

  if (typeof request.commitMessage !== "string" || request.commitMessage.trim().length === 0) {
    throw new Error("COMMIT_FAILED");
  }

  if (!Array.isArray(request.changes) || !Array.isArray(request.expectedSnapshot)) {
    throw new Error("COMMIT_FAILED");
  }
}

async function buildCommitState(request: GitCommitRequest): Promise<CommitState> {
  await validateRequestShape(request);

  const repoRoot = await canonicalizeRepositoryRoot(request.repositoryDir);
  const repoLockIdentity = normalizeCanonicalPath(repoRoot);
  const normalizedChanges = normalizeCommitChanges(request.changes);
  const expectedSnapshotByPath = normalizeExpectedSnapshot(request.expectedSnapshot);
  const expectedPaths = buildExactPathSet(normalizedChanges.map((change) => change.path));

  if (normalizedChanges.length === 0) {
    throw new Error("STAGED_CHANGE_SET_MISMATCH");
  }

  void fingerprintChanges(normalizedChanges);
  void fingerprintSnapshot(expectedSnapshotByPath);

  const branch = await validateExpectedBranch(repoRoot, request.expectedBranch);

  await ensureIndexClean(repoRoot);

  for (const change of normalizedChanges) {
    await validateCurrentChangeState(repoRoot, change, expectedSnapshotByPath);
  }

  return {
    repoRoot,
    repoLockIdentity,
    branch,
    expectedBranch: request.expectedBranch,
    normalizedChanges,
    expectedSnapshotByPath,
    expectedPaths,
    commitMessage: normalizeCommitMessage(request.commitMessage),
  };
}

async function cleanupAdapterStaging(repoRoot: string, stagedPaths: readonly string[]): Promise<void> {
  try {
    await restoreStagedChanges(repoRoot, stagedPaths);
  } catch {
    return;
  }
}

export function createGitCommitAdapter(): GitCommitAdapter {
  return {
    async commit(request: GitCommitRequest): Promise<GitCommitResult> {
      let lock: GitLock | undefined;
      let repoRoot: string | undefined;
      let commitCreated = false;
      const stagedPaths: string[] = [];

      try {
        const state = await buildCommitState(request);
        repoRoot = state.repoRoot;
        lock = await acquireCommitLock(state.repoLockIdentity);

        let branch = await validateExpectedBranch(state.repoRoot, state.expectedBranch);

        await ensureIndexClean(state.repoRoot);

        for (const change of state.normalizedChanges) {
          await validateCurrentChangeState(state.repoRoot, change, state.expectedSnapshotByPath);
          await stageChange(state.repoRoot, change);
          stagedPaths.push(change.path);
          await validateStagedChange(state.repoRoot, change, state.expectedSnapshotByPath);
        }

        const stagedPathSet = await readStagedPathSet(state.repoRoot);
        ensureExactPathSet(stagedPathSet, state.expectedPaths);

        for (const change of state.normalizedChanges) {
          await validateStagedChange(state.repoRoot, change, state.expectedSnapshotByPath);
        }

        branch = await validateExpectedBranch(state.repoRoot, state.expectedBranch);

        const statusBeforeCommit = await readGitStatusPorcelain(state.repoRoot);
        try {
          branch = await validateExpectedBranch(state.repoRoot, state.expectedBranch);
          await commitStagedChanges(state.repoRoot, state.commitMessage);
          commitCreated = true;
        } catch (error) {
          const statusAfterFailure = await readGitStatusPorcelain(state.repoRoot);
          await cleanupAdapterStaging(state.repoRoot, stagedPaths);
          if (statusAfterFailure !== statusBeforeCommit) {
            return buildFailed(request.executionId, "HOOK_MUTATED_WORKSPACE", "Hook or external process mutated the workspace/index during commit.");
          }
          throw error;
        }

        const commitSha = await getCommitSha(state.repoRoot);
        const committedPaths = await readCommittedPathSet(state.repoRoot);
        ensureExactPathSet(committedPaths, state.expectedPaths);
        await validateCommittedContent(state.repoRoot, state.expectedPaths, state.expectedSnapshotByPath);

        return {
          executionId: request.executionId,
          status: "COMMITTED",
          commitSha,
          branch,
          committedPaths,
        };
      } catch (error) {
        if (!commitCreated && repoRoot && stagedPaths.length > 0) {
          await cleanupAdapterStaging(repoRoot, stagedPaths);
        }

        if (commitCreated) {
          const message = error instanceof Error ? error.message : String(error);
          switch (message) {
            case "CHANGE_IDENTITY_MISMATCH":
            case "STAGED_CHANGE_SET_MISMATCH":
            case "STAGE_FAILED":
            case "COMMIT_FAILED":
            case "HOOK_MUTATED_WORKSPACE":
              return buildFailed(request.executionId, message, `Git commit falhou: ${message}.`);
            default:
              return buildFailed(request.executionId, "COMMIT_FAILED", message);
          }
        }

        return buildRejectedForError(request.executionId, error);
      } finally {
        if (lock) {
          await lock.release().catch(() => undefined);
        }
      }
    },
  };
}
