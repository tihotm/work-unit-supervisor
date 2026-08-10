import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, relative } from "node:path";

function comparePath(value: string): string {
  const withoutPrefix = value.startsWith("\\\\?\\UNC\\")
    ? `\\\\${value.slice(8)}`
    : value.startsWith("\\\\?\\")
      ? value.slice(4)
      : value;
  const normalized = normalize(withoutPrefix);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const rootComparable = comparePath(rootReal);
  const candidateComparable = comparePath(candidateReal);
  const relativePath = relative(rootComparable, candidateComparable);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeWorkspaceRelativePath(workspacePath: string): string | null {
  const normalized = workspacePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    return null;
  }
  return normalized;
}

async function resolveWorkspaceRoot(rootDir: string): Promise<string> {
  const resolvedRoot = resolve(rootDir);
  const rootReal = await realpath(resolvedRoot);
  if (!isInsideRoot(rootReal, rootReal)) {
    throw new Error("WORKSPACE_PATH_INVALID");
  }
  return rootReal;
}

export async function resolveSafeWorkspacePath(rootDir: string, candidatePath: string): Promise<string> {
  if (!rootDir || !candidatePath) {
    throw new Error("WORKSPACE_PATH_INVALID");
  }

  const rootReal = await resolveWorkspaceRoot(rootDir);
  const resolvedTarget = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(rootReal, candidatePath);
  const targetReal = await realpath(resolvedTarget);

  if (!isInsideRoot(rootReal, targetReal)) {
    throw new Error("WORKSPACE_PATH_OUT_OF_BOUNDS");
  }

  return targetReal;
}

export async function assertWritableWorkspacePath(rootDir: string, targetPath: string): Promise<string> {
  if (!rootDir || !targetPath) {
    throw new Error("WORKSPACE_PATH_INVALID");
  }

  const rootReal = await resolveWorkspaceRoot(rootDir);
  const resolvedTarget = isAbsolute(targetPath) ? resolve(targetPath) : resolve(rootReal, targetPath);
  const parentReal = await realpath(dirname(resolvedTarget));

  if (!isInsideRoot(rootReal, parentReal)) {
    throw new Error("WORKSPACE_PATH_OUT_OF_BOUNDS");
  }

  return resolvedTarget;
}

export { normalizeWorkspaceRelativePath };
