import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gitCommand } from "./git-commit-adapter.js";

const LOCK_NAMESPACE = join(tmpdir(), "work-unit-supervisor", "git-commit-locks");

export type GitPushReasonCode =
  | "INVALID_REQUEST"
  | "NOT_A_GIT_REPOSITORY"
  | "DETACHED_HEAD"
  | "BRANCH_MISMATCH"
  | "COMMIT_SHA_MISMATCH"
  | "TARGET_LOCKED"
  | "PUSH_FAILED"
  | "REMOTE_REF_MISMATCH";

export type GitPushReason = {
  readonly code: GitPushReasonCode;
  readonly message: string;
};

export type GitPushRequest = {
  readonly executionId: string;
  readonly repositoryDir: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly remoteName: string;
  readonly expectedBranch?: string;
};

export type GitPushPushedResult = {
  readonly executionId: string;
  readonly status: "PUSHED";
  readonly branch: string;
  readonly remoteName: string;
  readonly commitSha: string;
  readonly pushedRef: string;
};

export type GitPushRejectedResult = {
  readonly executionId: string;
  readonly status: "REJECTED";
  readonly reasons: readonly GitPushReason[];
};

export type GitPushFailedResult = {
  readonly executionId: string;
  readonly status: "FAILED";
  readonly reasons: readonly GitPushReason[];
};

export type GitPushResult = GitPushPushedResult | GitPushRejectedResult | GitPushFailedResult;

export interface GitPushAdapter {
  push(request: GitPushRequest): Promise<GitPushResult>;
}

type GitCommandResult = {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

type PushState = {
  readonly repoRoot: string;
  readonly repoLockIdentity: string;
  readonly branch: string;
  readonly expectedBranch: string | undefined;
  readonly commitSha: string;
  readonly remoteName: string;
};

type GitLock = {
  readonly lockPath: string;
  readonly handle: FileHandle;
  release(): Promise<void>;
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

async function runGit(repoRoot: string, args: readonly string[]): Promise<GitCommandResult> {
  return gitCommand.run(repoRoot, args);
}

function buildReason(code: GitPushReasonCode, message: string): GitPushReason {
  return { code, message };
}

function buildRejected(executionId: string, code: GitPushReasonCode, message: string): GitPushRejectedResult {
  return {
    executionId,
    status: "REJECTED",
    reasons: [buildReason(code, message)],
  };
}

function buildFailed(executionId: string, code: GitPushReasonCode, message: string): GitPushFailedResult {
  return {
    executionId,
    status: "FAILED",
    reasons: [buildReason(code, message)],
  };
}

async function canonicalizeRepositoryRoot(repositoryDir: string): Promise<string> {
  if (typeof repositoryDir !== "string" || repositoryDir.trim().length === 0) {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  const resolvedRepositoryDir = resolve(repositoryDir);
  const canonicalRepositoryDir = await realpath(resolvedRepositoryDir).catch(() => undefined);
  if (!canonicalRepositoryDir) {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  const repositoryStat = await lstat(canonicalRepositoryDir).catch(() => undefined);
  if (!repositoryStat || !repositoryStat.isDirectory()) {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  const toplevel = await runGit(canonicalRepositoryDir, ["rev-parse", "--show-toplevel"]);
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
  if (insideWorkTree.code !== 0) {
    throw new Error("NOT_A_GIT_REPOSITORY");
  }

  return canonicalRoot;
}

async function acquirePushLock(repoIdentity: string): Promise<GitLock> {
  await mkdir(LOCK_NAMESPACE, { recursive: true });
  const lockPath = join(LOCK_NAMESPACE, `${createHash("sha256").update(normalizeCanonicalPath(repoIdentity)).digest("hex")}.lock`);
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(String(process.pid));

    return {
      lockPath,
      handle,
      async release() {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true });
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
  const result = await runGit(repoRoot, ["branch", "--show-current"]);
  const branch = result.stdout.toString("utf8").trim();
  if (!branch) {
    throw new Error("DETACHED_HEAD");
  }
  return branch;
}

async function getCurrentCommitSha(repoRoot: string): Promise<string> {
  const result = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  const commitSha = result.stdout.toString("utf8").trim();
  if (!commitSha) {
    throw new Error("PUSH_FAILED");
  }
  return commitSha;
}

async function validateBranchAndHead(state: PushState): Promise<void> {
  const branch = await getCurrentBranch(state.repoRoot);
  if (branch !== state.branch) {
    throw new Error("BRANCH_MISMATCH");
  }
  if (state.expectedBranch !== undefined && branch !== state.expectedBranch) {
    throw new Error("BRANCH_MISMATCH");
  }
  const commitSha = await getCurrentCommitSha(state.repoRoot);
  if (commitSha !== state.commitSha) {
    throw new Error("COMMIT_SHA_MISMATCH");
  }
}

async function validateRemoteExists(repoRoot: string, remoteName: string): Promise<void> {
  if (typeof remoteName !== "string" || remoteName.trim().length === 0) {
    throw new Error("INVALID_REQUEST");
  }
  const result = await runGit(repoRoot, ["remote"]);
  const remotes = result.stdout
    .toString("utf8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!remotes.includes(remoteName)) {
    throw new Error("INVALID_REQUEST");
  }
}

async function pushCommit(state: PushState): Promise<void> {
  const result = await runGit(state.repoRoot, [
    "push",
    "-u",
    state.remoteName,
    `${state.commitSha}:refs/heads/${state.branch}`,
  ]);
  if (result.code !== 0) {
    throw new Error("PUSH_FAILED");
  }
}

async function readRemoteBranchSha(repoRoot: string, remoteName: string, branch: string): Promise<string> {
  const result = await runGit(repoRoot, ["ls-remote", "--heads", remoteName, branch]);
  if (result.code !== 0) {
    throw new Error("PUSH_FAILED");
  }

  const line = result.stdout.toString("utf8").trim();
  if (!line) {
    throw new Error("REMOTE_REF_MISMATCH");
  }

  const [sha, ref] = line.split(/\s+/);
  if (ref !== `refs/heads/${branch}` || !sha) {
    throw new Error("REMOTE_REF_MISMATCH");
  }

  return sha;
}

async function buildPushState(request: GitPushRequest): Promise<PushState> {
  if (typeof request.executionId !== "string" || request.executionId.trim().length === 0) {
    throw new Error("INVALID_REQUEST");
  }
  if (typeof request.branch !== "string" || request.branch.trim().length === 0) {
    throw new Error("INVALID_REQUEST");
  }
  if (typeof request.commitSha !== "string" || request.commitSha.trim().length === 0) {
    throw new Error("INVALID_REQUEST");
  }

  const repoRoot = await canonicalizeRepositoryRoot(request.repositoryDir);
  await validateRemoteExists(repoRoot, request.remoteName);
  const branch = await getCurrentBranch(repoRoot);
  if (branch !== request.branch) {
    throw new Error("BRANCH_MISMATCH");
  }
  if (request.expectedBranch !== undefined && branch !== request.expectedBranch) {
    throw new Error("BRANCH_MISMATCH");
  }
  const commitSha = await getCurrentCommitSha(repoRoot);
  if (commitSha !== request.commitSha) {
    throw new Error("COMMIT_SHA_MISMATCH");
  }

  const repoLockIdentity = normalizeCanonicalPath(repoRoot);
  return {
    repoRoot,
    repoLockIdentity,
    branch,
    expectedBranch: request.expectedBranch,
    commitSha,
    remoteName: request.remoteName,
  };
}

export function createGitPushAdapter(): GitPushAdapter {
  return {
    async push(request: GitPushRequest): Promise<GitPushResult> {
      let lock: GitLock | undefined;
      try {
        const state = await buildPushState(request);
        lock = await acquirePushLock(state.repoLockIdentity);
        await validateBranchAndHead(state);
        await pushCommit(state);
        const remoteCommitSha = await readRemoteBranchSha(state.repoRoot, state.remoteName, state.branch);
        if (remoteCommitSha !== state.commitSha) {
          throw new Error("REMOTE_REF_MISMATCH");
        }
        return {
          executionId: request.executionId,
          status: "PUSHED",
          branch: state.branch,
          remoteName: state.remoteName,
          commitSha: state.commitSha,
          pushedRef: `refs/heads/${state.branch}`,
        };
      } catch (error) {
        const code = typeof error === "string"
          ? error
          : error instanceof Error && typeof error.message === "string"
            ? error.message
            : undefined;
        if (code === "NOT_A_GIT_REPOSITORY" || code === "DETACHED_HEAD" || code === "BRANCH_MISMATCH" || code === "COMMIT_SHA_MISMATCH" || code === "INVALID_REQUEST" || code === "TARGET_LOCKED") {
          return buildRejected(request.executionId, code, code);
        }
        return buildFailed(request.executionId, code === "TARGET_LOCKED" ? "TARGET_LOCKED" : code === "REMOTE_REF_MISMATCH" ? "REMOTE_REF_MISMATCH" : "PUSH_FAILED", code ?? "PUSH_FAILED");
      } finally {
        if (lock) {
          await lock.release().catch(() => undefined);
        }
      }
    },
  };
}
