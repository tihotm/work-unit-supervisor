import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { createGitCommitAdapter, gitCommand, type GitCommitRequest } from "../src/infrastructure/git/git-commit-adapter.js";

const execFileAsync = promisify(execFile);
const realExecFile = execFile;
const realGitCommandRun = gitCommand.run;
const createdRoots: string[] = [];

async function runGit(repoDir: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    stdout: String(stdout ?? ""),
    stderr: String(stderr ?? ""),
  };
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

async function cleanupTempRoots(): Promise<void> {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

afterEach(async () => {
  await cleanupTempRoots();
});

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function initRepo(initialFiles: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await createTempRoot("wus-git-commit-");
  await mkdir(root, { recursive: true });
  await runGit(root, ["init"]);
  await runGit(root, ["checkout", "-b", "main"]);
  await runGit(root, ["config", "user.name", "Work Unit Supervisor"]);
  await runGit(root, ["config", "user.email", "wus@example.test"]);

  for (const [relativePath, content] of Object.entries(initialFiles)) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }

  const initialPaths = Object.keys(initialFiles).sort();
  if (initialPaths.length > 0) {
    await runGit(root, ["add", "--", ...initialPaths]);
    await runGit(root, ["commit", "--message", "init"]);
  }

  return root;
}

function buildRequest(params: {
  repositoryDir: string;
  executionId: string;
  commitMessage: string;
  changes: GitCommitRequest["changes"];
  expectedSnapshot: GitCommitRequest["expectedSnapshot"];
  expectedBranch?: string;
}): GitCommitRequest {
  return {
    executionId: params.executionId,
    repositoryDir: params.repositoryDir,
    changes: params.changes,
    expectedSnapshot: params.expectedSnapshot,
    commitMessage: params.commitMessage,
    ...(params.expectedBranch !== undefined ? { expectedBranch: params.expectedBranch } : {}),
  };
}

async function readCommitMessage(repoDir: string): Promise<string> {
  return (await runGit(repoDir, ["log", "-1", "--pretty=format:%s"])).stdout.trim();
}

async function readCachedPaths(repoDir: string): Promise<string[]> {
  return (await runGit(repoDir, ["diff", "--cached", "--name-only", "-z", "--no-renames"])).stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
}

async function gitCommitLockPath(repoRoot: string): Promise<string> {
  const canonicalRoot = await runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
  const normalized = canonicalRoot.stdout.trim().replaceAll("/", "\\");
  const digest = sha256Text(process.platform === "win32" ? normalized.toLowerCase() : normalized);
  return join(tmpdir(), "work-unit-supervisor", "git-commit-locks", `${digest}.lock`);
}

async function setHeadBranch(repoDir: string, branch: string): Promise<void> {
  await runGit(repoDir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
}

async function findRealGitExecutable(): Promise<string> {
  const result = await execFileAsync("where.exe", ["git"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const path = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!path) {
    throw new Error("git executable not found");
  }
  return path;
}

async function waitForCachedPath(repoDir: string, expectedPath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const stagedPaths = await readCachedPaths(repoDir);
    if (stagedPaths.includes(expectedPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for staged path: ${expectedPath}`);
}

describe("Git commit adapter", () => {
  it("commit ADDED com contento e paths exatos", async () => {
    const repo = await initRepo({ "baseline.txt": "base" });
    const adapter = createGitCommitAdapter();
    await writeFile(join(repo, "added.txt"), "hello");

    const result = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-added",
        commitMessage: "feat: add file",
        changes: [{ type: "ADDED", path: "added.txt" }],
        expectedSnapshot: [{ relativePath: "added.txt", contentHash: sha256Text("hello") }],
      }),
    );

    assert.equal(result.status, "COMMITTED");
    if (result.status === "COMMITTED") {
      assert.equal(result.executionId, "exec-added");
      assert.equal(result.branch, "main");
      assert.equal(result.commitSha, (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim());
      assert.deepEqual(result.committedPaths, ["added.txt"]);
    }
    assert.equal(await readFile(join(repo, "added.txt"), "utf8"), "hello");
    assert.equal(await readCommitMessage(repo), "feat: add file");
  });

  it("commit MODIFIED e preserva sujeira fora do change set", async () => {
    const repo = await initRepo({ "tracked.txt": "before", "dirty.txt": "outside" });
    const adapter = createGitCommitAdapter();
    await writeFile(join(repo, "tracked.txt"), "after");
    await writeFile(join(repo, "dirty.txt"), "outside-modified");

    const result = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-modified",
        commitMessage: "feat: modify file",
        changes: [{ type: "MODIFIED", path: "tracked.txt" }],
        expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("after") }],
      }),
    );

    assert.equal(result.status, "COMMITTED");
    if (result.status === "COMMITTED") {
      assert.deepEqual(result.committedPaths, ["tracked.txt"]);
    }
    assert.equal(await readFile(join(repo, "dirty.txt"), "utf8"), "outside-modified");
  });

  it("commit DELETED e retorna paths reais do commit", async () => {
    const repo = await initRepo({ "gone.txt": "before" });
    const adapter = createGitCommitAdapter();
    await rm(join(repo, "gone.txt"));

    const result = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-deleted",
        commitMessage: "feat: delete file",
        changes: [{ type: "DELETED", path: "gone.txt" }],
        expectedSnapshot: [],
      }),
    );

    assert.equal(result.status, "COMMITTED");
    if (result.status === "COMMITTED") {
      assert.deepEqual(result.committedPaths, ["gone.txt"]);
    }
    const tree = await runGit(repo, ["ls-tree", "--name-only", "HEAD", "--", "gone.txt"]);
    assert.equal(tree.stdout.trim(), "");
  });

  it("rejeita DELETED com junction/symlink inseguro e aceita ausência legítima", async () => {
    const repo = await initRepo({ "gone.txt": "before" });
    const adapter = createGitCommitAdapter();
    const outsideRoot = await createTempRoot("wus-git-commit-outside-");
    const outsideTarget = join(outsideRoot, "target");
    await mkdir(outsideTarget, { recursive: true });
    await rm(join(repo, "gone.txt"));
    await symlink(outsideTarget, join(repo, "gone.txt"), process.platform === "win32" ? "junction" : "dir");

    const rejectedResult = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-deleted-link",
        commitMessage: "feat: delete file",
        changes: [{ type: "DELETED", path: "gone.txt" }],
        expectedSnapshot: [],
      }),
    );

    assert.equal(rejectedResult.status, "REJECTED");
    if (rejectedResult.status === "REJECTED") {
      assert.equal(rejectedResult.reasons[0]?.code, "INVALID_PATH");
    }
    const stagedPaths = await readCachedPaths(repo);
    assert.deepEqual(stagedPaths, []);

    await rm(join(repo, "gone.txt"), { force: true }).catch(() => undefined);
    await rm(outsideRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(repo, "gone.txt"), { force: true }).catch(() => undefined);

    const absentRepo = await initRepo({ "nested/gone.txt": "before" });
    const absentAdapter = createGitCommitAdapter();
    await rm(join(absentRepo, "nested", "gone.txt"));

    const absentResult = await absentAdapter.commit(
      buildRequest({
        repositoryDir: absentRepo,
        executionId: "exec-deleted-absent",
        commitMessage: "feat: delete file",
        changes: [{ type: "DELETED", path: "nested/gone.txt" }],
        expectedSnapshot: [],
      }),
    );

    assert.equal(absentResult.status, "COMMITTED");
  });

  it("rejeita index staged preexistente", async () => {
    const repo = await initRepo({ "tracked.txt": "before" });
    const adapter = createGitCommitAdapter();
    await writeFile(join(repo, "tracked.txt"), "after");
    await runGit(repo, ["add", "--", "tracked.txt"]);

    const result = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-index-not-clean",
        commitMessage: "feat: modify file",
        changes: [{ type: "MODIFIED", path: "tracked.txt" }],
        expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("after") }],
      }),
    );

    assert.equal(result.status, "REJECTED");
    if (result.status === "REJECTED") {
      assert.equal(result.reasons[0]?.code, "INDEX_NOT_CLEAN");
    }
  });

  it("rejeita detached HEAD", async () => {
    const repo = await initRepo({ "tracked.txt": "before" });
    const adapter = createGitCommitAdapter();
    await runGit(repo, ["checkout", "--detach"]);
    await writeFile(join(repo, "tracked.txt"), "after");

    const result = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-detached",
        commitMessage: "feat: modify file",
        changes: [{ type: "MODIFIED", path: "tracked.txt" }],
        expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("after") }],
      }),
    );

    assert.equal(result.status, "REJECTED");
    if (result.status === "REJECTED") {
      assert.equal(result.reasons[0]?.code, "DETACHED_HEAD");
    }
  });

  it("rejeita branch esperada divergente", async () => {
    const repo = await initRepo({ "tracked.txt": "before" });
    const adapter = createGitCommitAdapter();
    await writeFile(join(repo, "tracked.txt"), "after");

    const result = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-branch-mismatch",
        commitMessage: "feat: modify file",
        expectedBranch: "release",
        changes: [{ type: "MODIFIED", path: "tracked.txt" }],
        expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("after") }],
      }),
    );

    assert.equal(result.status, "REJECTED");
    if (result.status === "REJECTED") {
      assert.equal(result.reasons[0]?.code, "BRANCH_MISMATCH");
    }
  });

  it("rejeita expectedBranch quando a branch muda antes da aquisição do lock", async () => {
    const repo = await initRepo({ "tracked.txt": "before" });
    const adapter = createGitCommitAdapter();
    await runGit(repo, ["branch", "release"]);
    await writeFile(join(repo, "tracked.txt"), "after");

    const lockPath = await gitCommitLockPath(repo);
    await mkdir(dirname(lockPath), { recursive: true });
    const heldLock = await open(lockPath, "wx");

    const commitPromise = adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-branch-prelock",
        commitMessage: "feat: modify file",
        expectedBranch: "main",
        changes: [{ type: "MODIFIED", path: "tracked.txt" }],
        expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("after") }],
      }),
    );

    await setHeadBranch(repo, "release");
    await heldLock.close();
    await rm(lockPath, { force: true }).catch(() => undefined);

    const result = await commitPromise;

    assert.equal(result.status, "REJECTED");
    if (result.status === "REJECTED") {
      assert.equal(result.reasons[0]?.code, "BRANCH_MISMATCH");
    }
    assert.deepEqual(await readCachedPaths(repo), []);
  });

  it("rejeita expectedBranch quando a branch muda depois do stage e antes do commit", async () => {
    const repo = await initRepo({ "tracked.txt": "before" });
    const adapter = createGitCommitAdapter();
    await runGit(repo, ["branch", "release"]);
    await writeFile(join(repo, "tracked.txt"), "after");

    const commitPromise = adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-branch-poststage",
        commitMessage: "feat: modify file",
        expectedBranch: "main",
        changes: [{ type: "MODIFIED", path: "tracked.txt" }],
        expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("after") }],
      }),
    );

    await waitForCachedPath(repo, "tracked.txt");
    await setHeadBranch(repo, "release");

    const result = await commitPromise;

    assert.equal(result.status, "REJECTED");
    if (result.status === "REJECTED") {
      assert.equal(result.reasons[0]?.code, "BRANCH_MISMATCH");
    }
    assert.deepEqual(await readCachedPaths(repo), []);
  });

  it("rejeita expectedBranch quando a branch muda depois do status e antes do commit real", async () => {
    const repo = await initRepo({ "tracked.txt": "before" });
    await runGit(repo, ["branch", "release"]);
    await writeFile(join(repo, "tracked.txt"), "after");

    let branchFlipped = false;
    gitCommand.run = async (repoRoot: string, args: readonly string[]) => {
      if (!branchFlipped && args[0] === "status" && args[1] === "--porcelain=v1" && args[2] === "-z") {
        branchFlipped = true;
        await runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/release"]);
      }

      return realGitCommandRun(repoRoot, args);
    };

    try {
      const adapter = createGitCommitAdapter();
      const result = await adapter.commit(
        buildRequest({
          repositoryDir: repo,
          executionId: "exec-branch-final-toctou",
          commitMessage: "feat: modify file",
          expectedBranch: "main",
          changes: [{ type: "MODIFIED", path: "tracked.txt" }],
          expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("after") }],
        }),
      );

      assert.equal(result.status, "REJECTED");
      if (result.status === "REJECTED") {
        assert.equal(result.reasons[0]?.code, "BRANCH_MISMATCH");
      }
      assert.deepEqual(await readCachedPaths(repo), []);
      assert.equal((await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim(), (await runGit(repo, ["rev-parse", "main"])).stdout.trim());
    } finally {
      gitCommand.run = realGitCommandRun;
    }
  });

  it("rejeita path absoluto, traversal e tipo não suportado", async () => {
    const repo = await initRepo({ "tracked.txt": "before" });
    const adapter = createGitCommitAdapter();

    const absoluteResult = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-absolute",
        commitMessage: "feat: invalid path",
        changes: [{ type: "ADDED", path: join(repo, "escape.txt") }],
        expectedSnapshot: [{ relativePath: "escape.txt", contentHash: sha256Text("escape") }],
      }),
    );

    assert.equal(absoluteResult.status, "REJECTED");
    if (absoluteResult.status === "REJECTED") {
      assert.equal(absoluteResult.reasons[0]?.code, "INVALID_PATH");
    }

    const traversalResult = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-traversal",
        commitMessage: "feat: invalid path",
        changes: [{ type: "ADDED", path: "../escape.txt" }],
        expectedSnapshot: [{ relativePath: "escape.txt", contentHash: sha256Text("escape") }],
      }),
    );

    assert.equal(traversalResult.status, "REJECTED");
    if (traversalResult.status === "REJECTED") {
      assert.equal(traversalResult.reasons[0]?.code, "INVALID_PATH");
    }

    const unsupportedResult = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-unsupported",
        commitMessage: "feat: invalid path",
        changes: [{ type: "RENAMED", path: "tracked.txt" } as never],
        expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("before") }],
      }),
    );

    assert.equal(unsupportedResult.status, "REJECTED");
    if (unsupportedResult.status === "REJECTED") {
      assert.equal(unsupportedResult.reasons[0]?.code, "UNSUPPORTED_CHANGE");
    }
  });

  it("rejeita mudança quando o conteúdo esperado diverge antes do stage", async () => {
    const repo = await initRepo({ "tracked.txt": "before" });
    const adapter = createGitCommitAdapter();
    await writeFile(join(repo, "tracked.txt"), "tampered");

    const result = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-toctou",
        commitMessage: "feat: modify file",
        changes: [{ type: "MODIFIED", path: "tracked.txt" }],
        expectedSnapshot: [{ relativePath: "tracked.txt", contentHash: sha256Text("after") }],
      }),
    );

    assert.equal(result.status, "REJECTED");
    if (result.status === "REJECTED") {
      assert.equal(result.reasons[0]?.code, "CHANGE_IDENTITY_MISMATCH");
    }
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "tampered");
  });

  it("usa o mesmo lock para aliases do mesmo repo físico e mantém repos diferentes independentes", async () => {
    const repoA = await initRepo({ "a.txt": "base-a" });
    const repoB = await initRepo({ "b.txt": "base-b" });
    const adapter = createGitCommitAdapter();
    await writeFile(join(repoA, "a.txt"), "after-a");
    await writeFile(join(repoB, "b.txt"), "after-b");

    const aliasA = process.platform === "win32"
      ? repoA.replace(/^([a-z]):/i, (_, drive: string) => `${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}:`)
      : repoA;

    const lockPath = await gitCommitLockPath(repoA);
    await mkdir(dirname(lockPath), { recursive: true });
    const heldLock = await open(lockPath, "wx");

    try {
      const lockedResult = await adapter.commit(
        buildRequest({
          repositoryDir: aliasA,
          executionId: "exec-locked",
          commitMessage: "feat: modify file",
          changes: [{ type: "MODIFIED", path: "a.txt" }],
          expectedSnapshot: [{ relativePath: "a.txt", contentHash: sha256Text("after-a") }],
        }),
      );

      assert.equal(lockedResult.status, "REJECTED");
      if (lockedResult.status === "REJECTED") {
        assert.equal(lockedResult.reasons[0]?.code, "TARGET_LOCKED");
      }

      const independentResult = await adapter.commit(
        buildRequest({
          repositoryDir: repoB,
          executionId: "exec-independent",
          commitMessage: "feat: modify file",
          changes: [{ type: "MODIFIED", path: "b.txt" }],
          expectedSnapshot: [{ relativePath: "b.txt", contentHash: sha256Text("after-b") }],
        }),
      );

      assert.equal(independentResult.status, "COMMITTED");
    } finally {
      await heldLock.close();
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  });

  it("aceita paths iniciados por hífen e commitMessage com metacaracteres sem shell injection", async () => {
    const repo = await initRepo({ "baseline.txt": "base" });
    const adapter = createGitCommitAdapter();
    await writeFile(join(repo, "-danger.txt"), "safe");
    await writeFile(join(repo, "sentinel.txt"), "sentinel");

    const result = await adapter.commit(
      buildRequest({
        repositoryDir: repo,
        executionId: "exec-shell-safe",
        commitMessage: "feat: add ; $(touch hacked)",
        changes: [{ type: "ADDED", path: "-danger.txt" }],
        expectedSnapshot: [{ relativePath: "-danger.txt", contentHash: sha256Text("safe") }],
      }),
    );

    assert.equal(result.status, "COMMITTED");
    if (result.status === "COMMITTED") {
      assert.deepEqual(result.committedPaths, ["-danger.txt"]);
    }
    await assert.doesNotReject(() => readFile(join(repo, "sentinel.txt"), "utf8"));
    await assert.rejects(() => readFile(join(repo, "hacked"), "utf8"));
  });
});
