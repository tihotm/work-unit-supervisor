import type { WorkUnit } from "../core/work-unit.js";
import type { DiffAuditInput, DiffAuditReason, DiffAuditResult, DiffFileChange } from "./diff-auditor-contracts.js";

const SUPERVISABLE_STATUSES = new Set<WorkUnit["status"]>(["READY", "RUNNING"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function normalizePath(rawPath: string): string | null {
  let normalized = rawPath.trim().replaceAll("\\", "/");

  if (normalized === "") {
    return null;
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  normalized = normalized.replace(/\/+/g, "/");

  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-zA-Z]:\//.test(normalized)
  ) {
    return null;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    return null;
  }

  return normalized;
}

function isPathInside(path: string, scope: readonly string[]): boolean {
  for (const candidate of scope) {
    const normalizedScope = normalizePath(candidate);
    if (!normalizedScope) {
      continue;
    }

    if (path === normalizedScope || path.startsWith(`${normalizedScope}/`)) {
      return true;
    }
  }

  return false;
}

function isDiffChange(value: unknown): value is DiffFileChange {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    type?: unknown;
    path?: unknown;
    oldPath?: unknown;
    newPath?: unknown;
  };
  if (candidate.type === "ADDED" || candidate.type === "MODIFIED" || candidate.type === "DELETED") {
    return isNonEmptyString(candidate.path);
  }

  if (candidate.type === "RENAMED" || candidate.type === "COPIED") {
    return isNonEmptyString(candidate.oldPath) && isNonEmptyString(candidate.newPath);
  }

  return false;
}

function normalizeChangePaths(change: DiffFileChange): readonly string[] | null {
  if (change.type === "ADDED" || change.type === "MODIFIED" || change.type === "DELETED") {
    const normalized = normalizePath(change.path);
    return normalized ? [normalized] : null;
  }

  const renamed = change as Extract<DiffFileChange, { type: "RENAMED" | "COPIED" }>;
  const oldPath = normalizePath(renamed.oldPath);
  const newPath = normalizePath(renamed.newPath);

  if (!oldPath || !newPath) {
    return null;
  }

  return oldPath === newPath ? [oldPath] : [oldPath, newPath];
}

function compareReasons(a: DiffAuditReason, b: DiffAuditReason): number {
  const codeCmp = a.code.localeCompare(b.code);
  if (codeCmp !== 0) {
    return codeCmp;
  }

  const pathA = "path" in a ? a.path : "";
  const pathB = "path" in b ? b.path : "";
  const pathCmp = pathA.localeCompare(pathB);
  if (pathCmp !== 0) {
    return pathCmp;
  }

  return a.message.localeCompare(b.message);
}

function reject(reasons: DiffAuditReason[]): DiffAuditResult {
  return {
    status: "REJECTED",
    reasons: [...reasons].sort(compareReasons),
  };
}

function validateWorkUnit(workUnit: WorkUnit): DiffAuditReason[] {
  const reasons: DiffAuditReason[] = [];
  const hasValidCoreFields =
    isNonEmptyString(workUnit.id) &&
    isNonEmptyString(workUnit.domain) &&
    isNonEmptyString(workUnit.phase);
  const hasValidScope =
    workUnit.scope !== null &&
    typeof workUnit.scope === "object" &&
    isStringArray(workUnit.scope.allowedPaths) &&
    isStringArray(workUnit.scope.forbiddenPaths);

  if (!hasValidCoreFields || !hasValidScope) {
    reasons.push({
      code: "INVALID_WORK_UNIT_STRUCTURE",
      message: "A WorkUnit não possui estrutura válida para auditoria de diff.",
    });
  }

  if (!SUPERVISABLE_STATUSES.has(workUnit.status)) {
    reasons.push({
      code: "INVALID_WORK_UNIT_STATUS",
      message: `Status '${String(workUnit.status)}' não é supervisionável.`,
    });
  }

  return reasons;
}

function auditChange(
  workUnit: WorkUnit,
  change: DiffFileChange,
  reasons: DiffAuditReason[],
): void {
  const paths = normalizeChangePaths(change);
  if (!paths) {
    reasons.push({
      code: "INVALID_CHANGE",
      message: `Alteração inválida para o tipo '${change.type}'.`,
    });
    return;
  }

  for (const path of paths) {
    if (isPathInside(path, workUnit.scope.forbiddenPaths)) {
      reasons.push({
        code: "PATH_FORBIDDEN",
        message: `O caminho '${path}' está proibido pelo WorkUnit.`,
        path,
      });
      continue;
    }

    if (!isPathInside(path, workUnit.scope.allowedPaths)) {
      reasons.push({
        code: "PATH_NOT_ALLOWED",
        message: `O caminho '${path}' não está no escopo permitido do WorkUnit.`,
        path,
      });
    }
  }
}

export function auditDiff(input: DiffAuditInput): DiffAuditResult {
  if (!input || typeof input !== "object") {
    return reject([
      {
        code: "INVALID_INPUT",
        message: "Entrada inválida para o auditor de diff.",
      },
    ]);
  }

  const candidate = input as Partial<DiffAuditInput>;
  if (!candidate.workUnit || !Array.isArray(candidate.changes)) {
    return reject([
      {
        code: "INVALID_INPUT",
        message: "WorkUnit ou changes ausentes da entrada do auditor.",
      },
    ]);
  }

  const reasons = validateWorkUnit(candidate.workUnit);
  if (reasons.length > 0) {
    return reject(reasons);
  }

  for (const change of candidate.changes) {
    if (!isDiffChange(change)) {
      reasons.push({
        code: "INVALID_CHANGE",
        message: "Uma ou mais alterações não possuem a estrutura factual esperada.",
      });
      continue;
    }

    auditChange(candidate.workUnit, change, reasons);
  }

  if (reasons.length > 0) {
    return reject(reasons);
  }

  return {
    status: "ADMISSIBLE",
  };
}
