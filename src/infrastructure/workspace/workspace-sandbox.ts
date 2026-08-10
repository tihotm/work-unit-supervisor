import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeWorkspaceRelativePath } from "./workspace-path-guard.js";

export type WorkspaceSandbox = {
  readonly workspaceId: string;
  readonly workspaceDir: string;
  cleanup(): Promise<void>;
};

export async function createWorkspaceSandbox(params: {
  readonly baseDir: string;
  readonly workspaceId: string;
}): Promise<WorkspaceSandbox> {
  if (!params.baseDir || !params.workspaceId) {
    throw new Error("WORKSPACE_SANDBOX_INVALID");
  }

  const normalizedWorkspaceId = normalizeWorkspaceRelativePath(params.workspaceId);
  if (!normalizedWorkspaceId) {
    throw new Error("WORKSPACE_SANDBOX_INVALID");
  }

  const resolvedBaseDir = resolve(params.baseDir);
  await mkdir(resolvedBaseDir, { recursive: true });
  const baseStats = await lstat(resolvedBaseDir);
  if (baseStats.isSymbolicLink()) {
    throw new Error("WORKSPACE_SANDBOX_BASE_AMBIGUOUS");
  }
  const workspaceDir = join(resolvedBaseDir, normalizedWorkspaceId);
  await mkdir(workspaceDir, { recursive: true }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("WORKSPACE_SANDBOX_CONFLICT");
    }
    throw error;
  });
  const workspaceStats = await lstat(workspaceDir);
  if (workspaceStats.isSymbolicLink()) {
    throw new Error("WORKSPACE_SANDBOX_AMBIGUOUS");
  }

  return {
    workspaceId: normalizedWorkspaceId,
    workspaceDir,
    async cleanup() {
      await rm(workspaceDir, { recursive: true, force: true });
    },
  };
}
