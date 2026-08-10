import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertWritableWorkspacePath, captureWorkspaceSnapshot, createWorkspaceSandbox, mapWorkspaceDiff, normalizeWorkspaceRelativePath, resolveSafeWorkspacePath, type WorkspaceFileChange, type WorkspaceSnapshot } from "../../infrastructure/workspace/index.js";
import { auditDiff, type DiffAuditReason, type DiffAuditResult } from "../../diff-auditor/index.js";
import type { ExecutorInput, ExecutorPort, ExecutorReason, ExecutorResult } from "../../ports/executor.js";
import type { WorkUnit } from "../../core/work-unit.js";
import type { RuntimeBridge, RuntimeBridgeResult, RuntimeBridgeSession } from "../runtime-bridge.js";

export type OpenHandsExecutorAdapterOptions = {
  readonly sandboxBaseDir: string;
  readonly runtimeBridge: RuntimeBridge;
  readonly diffAuditor?: (input: {
    readonly workUnit: WorkUnit;
    readonly changes: readonly WorkspaceFileChange[];
  }) => DiffAuditResult;
};

function cloneWorkUnit(workUnit: WorkUnit): WorkUnit {
  return structuredClone(workUnit);
}

function cloneLimits(limits: ExecutorInput["limits"]): ExecutorInput["limits"] {
  return limits ? { ...limits } : undefined;
}

function normalizeMaterializationPath(rawPath: string): string | null {
  const normalized = rawPath.replaceAll("\\", "/").trim().replace(/\/\*\*?$/, "");
  if (!normalized) {
    return null;
  }

  if (normalized.includes("*") || normalized.includes("?")) {
    return null;
  }

  return normalizeWorkspaceRelativePath(normalized);
}

function materializationRoots(paths: readonly string[], scopeName: "allowedPaths" | "forbiddenPaths"): string[] {
  const roots = new Set<string>();

  for (const rawPath of paths) {
    const normalized = normalizeMaterializationPath(rawPath);
    if (!normalized) {
      throw new Error(`OPENHANDS_INVALID_MATERIALIZATION_SCOPE:${scopeName}`);
    }
    roots.add(normalized);
  }

  return [...roots].sort();
}

function isPathInsideScope(path: string, scope: readonly string[]): boolean {
  return scope.some((candidate) => path === candidate || path.startsWith(`${candidate}/`));
}

async function materializeAllowedPath(
  sourceRoot: string,
  workspaceDir: string,
  relativePath: string,
  forbiddenRoots: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new Error("OPENHANDS_EXECUTOR_TIMEOUT");
  }

  if (isPathInsideScope(relativePath, forbiddenRoots)) {
    return;
  }

  const sourcePath = await resolveSafeWorkspacePath(sourceRoot, relativePath);
  const stats = await lstat(sourcePath);

  if (stats.isDirectory()) {
    const destinationDir = join(workspaceDir, relativePath);
    await mkdir(destinationDir, { recursive: true });
    await assertWritableWorkspacePath(workspaceDir, destinationDir);

    const entries = await readdir(sourcePath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      await materializeAllowedPath(sourceRoot, workspaceDir, `${relativePath}/${entry.name}`, forbiddenRoots, signal);
    }

    return;
  }

  const destinationPath = join(workspaceDir, relativePath);
  await mkdir(dirname(destinationPath), { recursive: true });
  await assertWritableWorkspacePath(workspaceDir, destinationPath);

  const readStream = createReadStream(sourcePath);
  const writeStream = createWriteStream(destinationPath);
  const timeoutError = new Error("OPENHANDS_EXECUTOR_TIMEOUT");
  const onAbort = (): void => {
    readStream.destroy(timeoutError);
    writeStream.destroy(timeoutError);
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const chunk of readStream) {
      if (signal.aborted) {
        throw timeoutError;
      }

      if (!writeStream.write(chunk)) {
        await once(writeStream, "drain");
      }
    }

    writeStream.end();
    await once(writeStream, "finish");
  } catch (error) {
    readStream.destroy();
    writeStream.destroy();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function materializeWorkspace(
  workspaceDir: string,
  workUnit: WorkUnit,
  signal: AbortSignal,
): Promise<void> {
  const sourceRoot = await realpath(resolve(process.cwd()));
  const allowedRoots = materializationRoots(workUnit.scope.allowedPaths, "allowedPaths");
  const forbiddenRoots = materializationRoots(workUnit.scope.forbiddenPaths, "forbiddenPaths");

  for (const allowedRoot of allowedRoots) {
    if (signal.aborted) {
      throw new Error("OPENHANDS_EXECUTOR_TIMEOUT");
    }

    if (isPathInsideScope(allowedRoot, forbiddenRoots)) {
      continue;
    }

    await materializeAllowedPath(sourceRoot, workspaceDir, allowedRoot, forbiddenRoots, signal);
  }
}

function toExecutorReason(reason: DiffAuditReason | ExecutorReason): ExecutorReason {
  return {
    code: reason.code,
    message: reason.message,
  };
}

function toExecutorReasons(reasons: readonly (DiffAuditReason | ExecutorReason)[]): ExecutorReason[] {
  return reasons.map(toExecutorReason);
}

function toChangedFiles(changes: readonly WorkspaceFileChange[]): string[] {
  return changes.map((change) => change.path);
}

function createBlockedResult(
  changedFiles: readonly string[],
  executedCommands: readonly string[],
  reasons: readonly (DiffAuditReason | ExecutorReason)[],
): ExecutorResult {
  return {
    status: "BLOCKED",
    changedFiles: [...changedFiles],
    executedCommands: [...executedCommands],
    reasons: toExecutorReasons(reasons),
  };
}

function createFailedResult(
  changedFiles: readonly string[],
  executedCommands: readonly string[],
  reasons: readonly ExecutorReason[],
  exitCode?: number,
): ExecutorResult {
  const base = {
    status: "FAILED" as const,
    changedFiles: [...changedFiles],
    executedCommands: [...executedCommands],
    reasons: reasons.map(toExecutorReason),
  };

  if (typeof exitCode === "number") {
    return {
      ...base,
      exitCode,
    };
  }

  return base;
}

function createCancelledResult(
  changedFiles: readonly string[],
  executedCommands: readonly string[],
  reasons: readonly ExecutorReason[],
): ExecutorResult {
  return {
    status: "CANCELLED",
    changedFiles: [...changedFiles],
    executedCommands: [...executedCommands],
    reasons: reasons.map(toExecutorReason),
  };
}

function createSucceededResult(
  changedFiles: readonly string[],
  executedCommands: readonly string[],
): ExecutorResult {
  return {
    status: "SUCCEEDED",
    changedFiles: [...changedFiles],
    executedCommands: [...executedCommands],
    exitCode: 0,
  };
}

function buildRuntimeFailureReason(error: unknown): ExecutorReason {
  return {
    code: "OPENHANDS_EXECUTOR_FAILURE",
    message: error instanceof Error ? error.message : String(error),
  };
}

function countChangedFiles(changes: readonly WorkspaceFileChange[]): number {
  return changes.length;
}

export class OpenHandsExecutorAdapter implements ExecutorPort {
  private readonly sandboxBaseDir: string;
  private readonly runtimeBridge: RuntimeBridge;
  private readonly diffAuditor: (input: { readonly workUnit: WorkUnit; readonly changes: readonly WorkspaceFileChange[] }) => DiffAuditResult;

  constructor(options: OpenHandsExecutorAdapterOptions) {
    if (!options.sandboxBaseDir) {
      throw new Error("OPENHANDS_SANDBOX_BASE_DIR_REQUIRED");
    }
    if (!options.runtimeBridge) {
      throw new Error("OPENHANDS_RUNTIME_BRIDGE_REQUIRED");
    }

    this.sandboxBaseDir = options.sandboxBaseDir;
    this.runtimeBridge = options.runtimeBridge;
    this.diffAuditor = options.diffAuditor ?? auditDiff;
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const workUnit = cloneWorkUnit(input.workUnit);
    const limits = cloneLimits(input.limits);
    const cancellationController = new AbortController();
    const sandbox = await createWorkspaceSandbox({
      baseDir: this.sandboxBaseDir,
      workspaceId: input.executionId,
    });

    let runtimeSession: RuntimeBridgeSession | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let cancelRequested = false;
    const cancellationReasons: ExecutorReason[] = [];
    let beforeSnapshot: WorkspaceSnapshot = [];
    let afterSnapshot: WorkspaceSnapshot = [];
    let changes: WorkspaceFileChange[] = [];
    let runtimeResult: RuntimeBridgeResult | undefined;

    const requestCancel = async (): Promise<void> => {
      if (cancelRequested) {
        return;
      }

      cancelRequested = true;
      cancellationController.abort();
      cancellationReasons.push({
        code: "TIMEOUT",
        message: "Execução excedeu o tempo máximo permitido.",
      });
      if (runtimeSession) {
        await runtimeSession.cancel().catch((error: unknown) => {
          cancellationReasons.push({
            code: "CANCEL_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };

    try {
      if (typeof limits?.timeoutMs === "number" && limits.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          void requestCancel();
        }, limits.timeoutMs);
      }

      await materializeWorkspace(sandbox.workspaceDir, workUnit, cancellationController.signal);
      beforeSnapshot = await captureWorkspaceSnapshot(sandbox.workspaceDir);
      if (cancelRequested) {
        throw new Error("OPENHANDS_EXECUTOR_TIMEOUT");
      }
      runtimeSession = await this.runtimeBridge.start({
        executionId: input.executionId,
        workspaceDir: sandbox.workspaceDir,
        workUnit,
        signal: cancellationController.signal,
      });
      if (cancelRequested) {
        await runtimeSession.cancel().catch((error: unknown) => {
          cancellationReasons.push({
            code: "CANCEL_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }

      runtimeResult = await runtimeSession.result();

      afterSnapshot = await captureWorkspaceSnapshot(sandbox.workspaceDir);
      changes = [...mapWorkspaceDiff(beforeSnapshot, afterSnapshot)];
      const changedFiles = toChangedFiles(changes);
      const executedCommands = [...runtimeResult.executedCommands];

      if (cancelRequested) {
        if (runtimeResult.status === "CANCELLED") {
          return createCancelledResult(changedFiles, executedCommands, [
            ...cancellationReasons,
            ...runtimeResult.reasons.map(toExecutorReason),
          ]);
        }

        return createCancelledResult(changedFiles, executedCommands, cancellationReasons);
      }

      if (runtimeResult.status === "FAILED") {
        return createFailedResult(
          changedFiles,
          executedCommands,
          runtimeResult.reasons.map(toExecutorReason),
          runtimeResult.exitCode,
        );
      }

      if (runtimeResult.status === "CANCELLED") {
        return createCancelledResult(
          changedFiles,
          executedCommands,
          runtimeResult.reasons.map(toExecutorReason),
        );
      }

      if (typeof limits?.maxCommands === "number" && executedCommands.length > limits.maxCommands) {
        return createBlockedResult(changedFiles, executedCommands, [
          {
            code: "MAX_COMMANDS_EXCEEDED",
            message: `Número máximo de comandos excedido: ${executedCommands.length} > ${limits.maxCommands}.`,
          },
        ]);
      }

      if (typeof limits?.maxChangedFiles === "number" && countChangedFiles(changes) > limits.maxChangedFiles) {
        return createBlockedResult(changedFiles, executedCommands, [
          {
            code: "MAX_CHANGED_FILES_EXCEEDED",
            message: `Número máximo de arquivos alterados excedido: ${countChangedFiles(changes)} > ${limits.maxChangedFiles}.`,
          },
        ]);
      }

      const diffDecision = this.diffAuditor({ workUnit, changes });
      if (diffDecision.status === "REJECTED") {
        return createBlockedResult(
          changedFiles,
          executedCommands,
          diffDecision.reasons,
        );
      }

      return createSucceededResult(changedFiles, executedCommands);
    } catch (error) {
      if (cancelRequested) {
        return createCancelledResult(
          toChangedFiles(changes),
          runtimeResult ? [...runtimeResult.executedCommands] : [],
          cancellationReasons.length > 0 ? [...cancellationReasons] : [buildRuntimeFailureReason(error)],
        );
      }

      return createFailedResult(
        toChangedFiles(changes),
        runtimeResult ? [...runtimeResult.executedCommands] : [],
        [buildRuntimeFailureReason(error)],
        runtimeResult && runtimeResult.status === "FAILED" ? runtimeResult.exitCode : undefined,
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      await sandbox.cleanup().catch(() => undefined);
    }
  }
}
