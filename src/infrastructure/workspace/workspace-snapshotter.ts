import { createHash } from "node:crypto";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";

export type WorkspaceSnapshotEntry = {
  readonly relativePath: string;
  readonly contentHash: string;
};

export type WorkspaceSnapshot = readonly WorkspaceSnapshotEntry[];

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareCanonicalPaths(left: string, right: string): boolean {
  const normalizedLeft = normalize(left).replaceAll("/", "\\");
  const normalizedRight = normalize(right).replaceAll("/", "\\");
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const rootComparable = normalize(rootReal);
  const candidateComparable = normalize(candidateReal);
  const relativePath = relative(rootComparable, candidateComparable);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("..\\"));
}

function toRelativePath(rootCanonical: string, absolutePath: string): string {
  return relative(rootCanonical, absolutePath).split(sep).join("/");
}

async function hashFile(filePath: string): Promise<string> {
  const fileHandle = await open(filePath, "r");
  try {
    const bytes = await fileHandle.readFile();
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await fileHandle.close();
  }
}

async function validateWorkspaceRoot(rootDir: string): Promise<string> {
  const rootStats = await lstat(rootDir);
  if (rootStats.isSymbolicLink()) {
    throw new Error("WORKSPACE_SNAPSHOT_ROOT_REJECTED");
  }
  if (!rootStats.isDirectory()) {
    throw new Error("WORKSPACE_SNAPSHOT_ROOT_INVALID");
  }

  return await realpath(rootDir);
}

async function resolvePinnedWorkspacePath(rootCanonical: string, candidatePath: string): Promise<string> {
  const resolvedTarget = resolve(candidatePath);
  const targetReal = await realpath(resolvedTarget);
  if (!isInsideRoot(rootCanonical, targetReal)) {
    throw new Error("WORKSPACE_SNAPSHOT_OUT_OF_BOUNDS");
  }

  return targetReal;
}

async function assertPinnedDirectoryIdentity(expectedCanonical: string, currentDir: string): Promise<string> {
  const currentReal = await realpath(currentDir);
  if (!compareCanonicalPaths(expectedCanonical, currentReal)) {
    throw new Error("WORKSPACE_SNAPSHOT_DIRECTORY_CHANGED");
  }

  return currentReal;
}

async function walkWorkspace(
  rootCanonical: string,
  currentDir: string,
  entries: WorkspaceSnapshotEntry[],
): Promise<void> {
  const currentCanonical = await assertPinnedDirectoryIdentity(currentDir, currentDir);
  const dirEntries = await readdir(currentCanonical, { withFileTypes: true });
  dirEntries.sort((left, right) => compareStrings(left.name, right.name));

  for (const entry of dirEntries) {
    const stableCurrentDir = await assertPinnedDirectoryIdentity(currentCanonical, currentCanonical);
    const absolutePath = join(stableCurrentDir, entry.name);
    const entryStats = await lstat(absolutePath);
    if (entryStats.isSymbolicLink()) {
      throw new Error("WORKSPACE_SNAPSHOT_SYMLINK_REJECTED");
    }

    if (entry.isDirectory()) {
      const safeDirectory = await resolvePinnedWorkspacePath(rootCanonical, absolutePath);
      await walkWorkspace(rootCanonical, safeDirectory, entries);
      continue;
    }

    if (!entry.isFile()) {
      throw new Error("WORKSPACE_SNAPSHOT_UNSUPPORTED_ENTRY");
    }

    const safeFile = await resolvePinnedWorkspacePath(rootCanonical, absolutePath);
    entries.push({
      relativePath: toRelativePath(rootCanonical, safeFile),
      contentHash: await hashFile(safeFile),
    });
  }
}

export async function captureWorkspaceSnapshot(rootDir: string): Promise<WorkspaceSnapshot> {
  const rootCanonical = await validateWorkspaceRoot(rootDir);
  const entries: WorkspaceSnapshotEntry[] = [];
  await walkWorkspace(rootCanonical, rootCanonical, entries);
  entries.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  return entries;
}
