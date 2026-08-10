import type { WorkspaceSnapshot } from "./workspace-snapshotter.js";

export type WorkspaceFileChange = {
  readonly type: "ADDED" | "MODIFIED" | "DELETED";
  readonly path: string;
};

export type WorkspaceDiff = readonly WorkspaceFileChange[];

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareChanges(left: WorkspaceFileChange, right: WorkspaceFileChange): number {
  const pathCompare = compareStrings(left.path, right.path);
  if (pathCompare !== 0) {
    return pathCompare;
  }

  return compareStrings(left.type, right.type);
}

function buildSnapshotMap(snapshot: WorkspaceSnapshot, snapshotName: string): Map<string, WorkspaceSnapshot[number]> {
  const map = new Map<string, WorkspaceSnapshot[number]>();
  for (const entry of snapshot) {
    if (map.has(entry.relativePath)) {
      throw new Error(`WORKSPACE_DIFF_DUPLICATE_RELATIVE_PATH:${snapshotName}:${entry.relativePath}`);
    }
    map.set(entry.relativePath, entry);
  }
  return map;
}

export function mapWorkspaceDiff(beforeSnapshot: WorkspaceSnapshot, afterSnapshot: WorkspaceSnapshot): WorkspaceDiff {
  const beforeMap = buildSnapshotMap(beforeSnapshot, "before");
  const afterMap = buildSnapshotMap(afterSnapshot, "after");
  const changes: WorkspaceFileChange[] = [];

  for (const [relativePath, beforeEntry] of beforeMap.entries()) {
    const afterEntry = afterMap.get(relativePath);
    if (!afterEntry) {
      changes.push({ type: "DELETED", path: relativePath });
      continue;
    }

    if (beforeEntry.contentHash !== afterEntry.contentHash) {
      changes.push({ type: "MODIFIED", path: relativePath });
    }
  }

  for (const [relativePath] of afterMap.entries()) {
    if (!beforeMap.has(relativePath)) {
      changes.push({ type: "ADDED", path: relativePath });
    }
  }

  changes.sort(compareChanges);
  return changes;
}
