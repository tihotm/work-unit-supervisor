import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { gitCommand } from "../src/infrastructure/git/git-commit-adapter.js";
import { createGitPushAdapter } from "../src/infrastructure/git/git-push-adapter.js";

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];

async function runGit(repoDir: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", ["-C", repoDir, ...args], {
    encoding: "buffer",
    windowsHide: true,
  });
  return {
    stdout: Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? ""),
    stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
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
      await rm(root, { recursive: true, force: true });
    }
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function initCommittedRepo(): Promise<{
  readonly repo: string;
  readonly remote: string;
  readonly firstCommitSha: string;
  readonly headSha: string;
}> {
  const repo = await createTempRoot("wus-git-push-repo-");
  const remote = await createTempRoot("wus-git-push-remote-");
  await runGit(repo, ["init"]);
  await runGit(repo, ["checkout", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "Work Unit Supervisor"]);
  await runGit(repo, ["config", "user.email", "wus@example.test"]);
  await runGit(remote, ["init", "--bare"]);
  await runGit(repo, ["remote", "add", "origin", remote]);

  await writeFile(join(repo, "tracked.txt"), "before");
  await runGit(repo, ["add", "--", "tracked.txt"]);
  await runGit(repo, ["commit", "--message", "first"]);
  const firstCommitSha = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();

  await writeFile(join(repo, "tracked.txt"), "after");
  await runGit(repo, ["add", "--", "tracked.txt"]);
  await runGit(repo, ["commit", "--message", "second"]);
  const headSha = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();

  return { repo, remote, firstCommitSha, headSha };
}

async function gitPushLockPath(repoRoot: string): Promise<string> {
  const canonicalRoot = (await runGit(repoRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const normalized = canonicalRoot.replaceAll("/", "\\");
  const digest = sha256Text(process.platform === "win32" ? normalized.toLowerCase() : normalized);
  return join(tmpdir(), "work-unit-supervisor", "git-commit-locks", `${digest}.lock`);
}

async function setHeadBranch(repoDir: string, branch: string): Promise<void> {
  await runGit(repoDir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
}

afterEach(async () => {
  await cleanupTempRoots();
});

describe("Git push adapter", () => {
  it("publica o commit atual no remote e verifica o ref remoto", async () => {
    const { repo, headSha } = await initCommittedRepo();
    const adapter = createGitPushAdapter();

    const result = await adapter.push({
      executionId: "exec-push",
      repositoryDir: repo,
      branch: "main",
      commitSha: headSha,
      remoteName: "origin",
      expectedBranch: "main",
    });

    assert.deepEqual(result, {
      executionId: "exec-push",
      status: "PUSHED",
      branch: "main",
      remoteName: "origin",
      commitSha: headSha,
      pushedRef: "refs/heads/main",
    });

    const remoteRef = await runGit(repo, ["ls-remote", "--heads", "origin", "main"]);
    assert.match(remoteRef.stdout.trim(), new RegExp(`^${headSha}\\s+refs/heads/main$`));
  });

  it("rejeita branch divergente sem fazer push", async () => {
    const { repo, headSha } = await initCommittedRepo();
    const adapter = createGitPushAdapter();

    const result = await adapter.push({
      executionId: "exec-branch-mismatch",
      repositoryDir: repo,
      branch: "main",
      commitSha: headSha,
      remoteName: "origin",
      expectedBranch: "release",
    });

    assert.equal(result.status, "REJECTED");
    assert.equal(result.reasons[0]?.code, "BRANCH_MISMATCH");

    const remoteRef = await runGit(repo, ["ls-remote", "--heads", "origin", "main"]);
    assert.equal(remoteRef.stdout.trim(), "");
  });

  it("rejeita commitSha divergente sem fazer push", async () => {
    const { repo, firstCommitSha } = await initCommittedRepo();
    const adapter = createGitPushAdapter();

    const result = await adapter.push({
      executionId: "exec-sha-mismatch",
      repositoryDir: repo,
      branch: "main",
      commitSha: firstCommitSha,
      remoteName: "origin",
      expectedBranch: "main",
    });

    assert.equal(result.status, "REJECTED");
    assert.equal(result.reasons[0]?.code, "COMMIT_SHA_MISMATCH");

    const remoteRef = await runGit(repo, ["ls-remote", "--heads", "origin", "main"]);
    assert.equal(remoteRef.stdout.trim(), "");
  });

  it("rejeita lock ocupado para o mesmo repo físico", async () => {
    const { repo, headSha } = await initCommittedRepo();
    const adapter = createGitPushAdapter();
    const lockPath = await gitPushLockPath(repo);
    await mkdir(join(lockPath, ".."), { recursive: true });
    const heldLock = await open(lockPath, "wx");

    try {
      const result = await adapter.push({
        executionId: "exec-lock",
        repositoryDir: repo,
        branch: "main",
        commitSha: headSha,
        remoteName: "origin",
        expectedBranch: "main",
      });

      assert.equal(result.status, "REJECTED");
      assert.equal(result.reasons[0]?.code, "TARGET_LOCKED");
    } finally {
      await heldLock.close();
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  });

  it("rejeita branch que muda depois da validação pós-lock e antes do push", async () => {
    const { repo, headSha } = await initCommittedRepo();
    const adapter = createGitPushAdapter();
    const realRun = gitCommand.run;
    let branchChecks = 0;

    gitCommand.run = async (repoRoot: string, args: readonly string[]) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        branchChecks += 1;
        if (branchChecks === 2) {
          await setHeadBranch(repoRoot, "release");
        }
      }
      return realRun(repoRoot, args);
    };

    try {
      const result = await adapter.push({
        executionId: "exec-branch-toctou",
        repositoryDir: repo,
        branch: "main",
        commitSha: headSha,
        remoteName: "origin",
        expectedBranch: "main",
      });

      assert.equal(result.status, "REJECTED");
      assert.equal(result.reasons[0]?.code, "BRANCH_MISMATCH");
      const remoteRef = await runGit(repo, ["ls-remote", "--heads", "origin", "main"]);
      assert.equal(remoteRef.stdout.trim(), "");
    } finally {
      gitCommand.run = realRun;
    }
  });
});
