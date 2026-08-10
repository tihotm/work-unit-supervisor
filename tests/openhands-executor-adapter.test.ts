import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { OpenHandsExecutorAdapter } from "../src/executors/openhands/openhands-executor-adapter.js";
import type { ExecutorInput, ExecutorPort } from "../src/ports/index.js";
import type { RuntimeBridge, RuntimeBridgeInput, RuntimeBridgeSession } from "../src/executors/runtime-bridge.js";
import type { DiffAuditInput, DiffAuditReason, DiffAuditResult } from "../src/diff-auditor/index.js";
import type { WorkUnit } from "../src/core/index.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function createTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

function createWorkUnit(): WorkUnit {
  return {
    id: "wu-1",
    domain: "openhands",
    phase: "adapter",
    status: "READY",
    scope: {
      allowedPaths: ["src/core/work-unit.ts", "src/infrastructure/workspace/workspace-sandbox.ts"],
      forbiddenPaths: ["src/infrastructure/workspace/workspace-sandbox.ts"],
    },
  };
}

function createMissingMaterializationWorkUnit(): WorkUnit {
  return {
    id: "wu-1",
    domain: "openhands",
    phase: "adapter",
    status: "READY",
    scope: {
      allowedPaths: ["src/core/this-file-does-not-exist.txt"],
      forbiddenPaths: [],
    },
  };
}

function createInput(overrides: Partial<ExecutorInput> = {}): ExecutorInput {
  return {
    executionId: "exec-1",
    workUnit: createWorkUnit(),
    limits: {
      timeoutMs: 1_000,
      maxCommands: 10,
      maxChangedFiles: 10,
    },
    ...overrides,
  };
}

function createRuntimeBridgeSession(input: RuntimeBridgeInput, overrides: Partial<RuntimeBridgeSession> = {}): RuntimeBridgeSession {
  return {
    executionId: input.executionId,
    async status() {
      return {
        executionId: input.executionId,
        status: "RUNNING",
      };
    },
    async cancel() {
      return undefined;
    },
    async result() {
      return {
        executionId: input.executionId,
        status: "SUCCEEDED",
        exitCode: 0,
        executedCommands: [],
      };
    },
    ...overrides,
  };
}

function createRuntimeBridge(
  sessionFactory: (input: RuntimeBridgeInput) => RuntimeBridgeSession | Promise<RuntimeBridgeSession>,
): RuntimeBridge {
  return {
    async start(input) {
      return await sessionFactory(input);
    },
  };
}

function createAdmissibleDiff(): DiffAuditResult {
  return {
    status: "ADMISSIBLE",
  };
}

describe("OpenHands executor adapter", () => {
  it("implementa ExecutorPort", () => {
    const baseDir = join(tmpdir(), "wus-openhands-port");
    const adapter: ExecutorPort = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) => createRuntimeBridgeSession(input)),
    });

    assert.equal(typeof adapter.execute, "function");
  });

  it("SUCCEEDED + diff admissível resulta em SUCCEEDED e usa snapshot/diff factual", async () => {
    const baseDir = await createTempDir("wus-openhands-success-");
    const diffInputs: DiffAuditInput[] = [];
    const events: string[] = [];
    const bridge = createRuntimeBridge(async (input) => {
      const materializedFile = join(input.workspaceDir, "src", "core", "work-unit.ts");
      const forbiddenFile = join(input.workspaceDir, "src", "infrastructure", "workspace", "workspace-sandbox.ts");

      await assert.doesNotReject(() => readFile(materializedFile, "utf8"));
      await assert.rejects(() => readFile(forbiddenFile, "utf8"));
      events.push("start");

      return createRuntimeBridgeSession(input, {
        async result() {
          events.push("result");
          await writeFile(materializedFile, "after");
          return {
            executionId: input.executionId,
            status: "SUCCEEDED",
            exitCode: 0,
            executedCommands: ["edit-file"],
          };
        },
      });
    });

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: bridge,
      diffAuditor: (input) => {
        diffInputs.push({
          workUnit: input.workUnit,
          changes: input.changes,
        });
        return createAdmissibleDiff();
      },
    });

    const result = await adapter.execute(createInput());

    assert.deepEqual(result, {
      status: "SUCCEEDED",
      changedFiles: ["src/core/work-unit.ts"],
      executedCommands: ["edit-file"],
      exitCode: 0,
    });
    assert.equal(diffInputs.length, 1);
    assert.deepEqual(diffInputs[0]?.changes, [{ type: "MODIFIED", path: "src/core/work-unit.ts" }]);
    assert.deepEqual(events, ["start", "result"]);
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("SUCCEEDED + diff rejeitado resulta em BLOCKED", async () => {
    const baseDir = await createTempDir("wus-openhands-blocked-");
    const reasons: DiffAuditReason[] = [
      {
        code: "PATH_FORBIDDEN",
        message: "bloqueado",
        path: "src/app/file.txt",
      },
    ];

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) =>
        createRuntimeBridgeSession(input, {
          async result() {
            await mkdir(join(input.workspaceDir, "src", "app"), { recursive: true });
            await writeFile(join(input.workspaceDir, "src", "app", "file.txt"), "after");
            return {
              executionId: input.executionId,
              status: "SUCCEEDED",
              exitCode: 0,
              executedCommands: ["edit-file"],
            };
          },
        }),
      ),
      diffAuditor: () => ({
        status: "REJECTED",
        reasons,
      }),
    });

    const result = await adapter.execute(createInput());

    assert.equal(result.status, "BLOCKED");
    if (result.status === "BLOCKED") {
      assert.deepEqual(result.changedFiles, ["src/app/file.txt"]);
      assert.deepEqual(result.executedCommands, ["edit-file"]);
      assert.ok(result.reasons.some((reason) => reason.code === "PATH_FORBIDDEN"));
    }
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("runtime FAILED resulta em FAILED sem consultar admissibilidade", async () => {
    const baseDir = await createTempDir("wus-openhands-failed-");
    let diffCalls = 0;

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) =>
        createRuntimeBridgeSession(input, {
          async result() {
            return {
              executionId: input.executionId,
              status: "FAILED",
              reasons: [{ code: "RUNTIME_FAILURE", message: "boom" }],
              executedCommands: ["edit-file"],
              exitCode: 1,
            };
          },
        }),
      ),
      diffAuditor: () => {
        diffCalls += 1;
        return createAdmissibleDiff();
      },
    });

    const result = await adapter.execute(createInput());

    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.executedCommands, ["edit-file"]);
    }
    assert.equal(diffCalls, 0);
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("runtime CANCELLED resulta em CANCELLED", async () => {
    const baseDir = await createTempDir("wus-openhands-cancelled-");

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) =>
        createRuntimeBridgeSession(input, {
          async result() {
            return {
              executionId: input.executionId,
              status: "CANCELLED",
              reasons: [{ code: "RUNTIME_CANCELLED", message: "cancelled" }],
              executedCommands: [],
            };
          },
        }),
      ),
    });

    const result = await adapter.execute(createInput());

    assert.equal(result.status, "CANCELLED");
    if (result.status === "CANCELLED") {
      assert.deepEqual(result.reasons, [{ code: "RUNTIME_CANCELLED", message: "cancelled" }]);
    }
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("materialização ausente impede o startup e limpa o sandbox", async () => {
    const baseDir = await createTempDir("wus-openhands-materialize-failure-");
    let startCalls = 0;

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge(async (input) => {
        startCalls += 1;
        return createRuntimeBridgeSession(input);
      }),
    });

    const result = await adapter.execute({
      ...createInput(),
      workUnit: createMissingMaterializationWorkUnit(),
    });

    assert.equal(result.status, "FAILED");
    assert.equal(startCalls, 0);
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("allowedPaths inválido falha fechado antes do startup", async () => {
    const baseDir = await createTempDir("wus-openhands-invalid-allowed-");
    let startCalls = 0;

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) => {
        startCalls += 1;
        return createRuntimeBridgeSession(input);
      }),
    });

    const result = await adapter.execute({
      ...createInput(),
      workUnit: {
        ...createWorkUnit(),
        scope: {
          allowedPaths: ["../escape"],
          forbiddenPaths: [],
        },
      },
    });

    assert.equal(result.status, "FAILED");
    assert.equal(startCalls, 0);
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("forbiddenPaths inválido falha fechado antes do startup", async () => {
    const baseDir = await createTempDir("wus-openhands-invalid-forbidden-");
    let startCalls = 0;

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) => {
        startCalls += 1;
        return createRuntimeBridgeSession(input);
      }),
    });

    const result = await adapter.execute({
      ...createInput(),
      workUnit: {
        ...createWorkUnit(),
        scope: {
          allowedPaths: ["src/core/work-unit.ts"],
          forbiddenPaths: ["../escape"],
        },
      },
    });

    assert.equal(result.status, "FAILED");
    assert.equal(startCalls, 0);
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("timeout propaga cancel e não chama cancel duas vezes", async () => {
    const baseDir = await createTempDir("wus-openhands-timeout-");
    let cancelCalls = 0;
    const started = deferred<void>();
    const release = deferred<void>();
    let seenSignal: AbortSignal | undefined;

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) => {
        seenSignal = input.signal;
        started.resolve();
        return createRuntimeBridgeSession(input, {
          async cancel() {
            cancelCalls += 1;
            release.resolve();
          },
          async result() {
            await new Promise<void>((resolve) => {
              if (input.signal?.aborted) {
                resolve();
                return;
              }
              input.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            await release.promise;
            return {
              executionId: input.executionId,
              status: "CANCELLED",
              reasons: [{ code: "RUNTIME_CANCELLED", message: "cancelled" }],
              executedCommands: [],
            };
          },
        });
      }),
    });

    const execution = adapter.execute({ ...createInput(), limits: { timeoutMs: 100, maxCommands: 10, maxChangedFiles: 10 } });
    await started.promise;
    const result = await execution;

    assert.equal(result.status, "CANCELLED");
    assert.equal(cancelCalls, 1);
    assert.equal(seenSignal?.aborted, true);
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("timeout interrompe a cópia regular de arquivo e impede o startup", async () => {
    const baseDir = await createTempDir("wus-openhands-copy-abort-");
    const repoTmpRoot = join(process.cwd(), "tmp");
    await mkdir(repoTmpRoot, { recursive: true });
    const sourceRoot = await mkdtemp(join(repoTmpRoot, "wus-openhands-copy-abort-"));
    const sourceFile = join(sourceRoot, "big.bin");
    await writeFile(sourceFile, Buffer.alloc(16 * 1024 * 1024, 1));

    let startCalls = 0;

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) => {
        startCalls += 1;
        return createRuntimeBridgeSession(input);
      }),
    });

    const result = await adapter.execute({
      ...createInput(),
      limits: { timeoutMs: 1, maxCommands: 10, maxChangedFiles: 10 },
      workUnit: {
        ...createWorkUnit(),
        scope: {
          allowedPaths: [`${relative(process.cwd(), sourceFile)}`],
          forbiddenPaths: [],
        },
      },
    });

    assert.equal(result.status, "CANCELLED");
    assert.equal(startCalls, 0);
    assert.deepEqual(await readdir(baseDir), []);

    await rm(sourceRoot, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  it("timeout cobre startup pendente e aborta antes de iniciar execução factual", async () => {
    const baseDir = await createTempDir("wus-openhands-timeout-startup-");
    let startCalls = 0;
    let seenSignal: AbortSignal | undefined;

    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: baseDir,
      runtimeBridge: createRuntimeBridge((input) => {
        startCalls += 1;
        seenSignal = input.signal;
        return new Promise<RuntimeBridgeSession>((_resolve, reject) => {
          if (input.signal?.aborted) {
            reject(new Error("startup aborted"));
            return;
          }
          input.signal?.addEventListener("abort", () => reject(new Error("startup aborted")), { once: true });
        });
      }),
    });

    const result = await adapter.execute({
      ...createInput(),
      limits: { timeoutMs: 100, maxCommands: 10, maxChangedFiles: 10 },
    });

    assert.equal(result.status, "CANCELLED");
    assert.equal(startCalls, 1);
    assert.equal(seenSignal?.aborted, true);
    assert.deepEqual(await readdir(baseDir), []);

    await rm(baseDir, { recursive: true, force: true });
  });

  it("não expõe OpenHands SDK concreto, config ou payload arbitrário no source", async () => {
    const sources = [
      new URL("../../src/executors/openhands/openhands-executor-adapter.ts", import.meta.url),
      new URL("../../src/executors/index.ts", import.meta.url),
    ];

    for (const sourceUrl of sources) {
      const source = await readFile(sourceUrl, "utf8");
      const lower = source.toLowerCase();

      assert.ok(!lower.includes("process.env"));
      assert.ok(!lower.includes("oauth"));
      assert.ok(!lower.includes("subscription"));
      assert.ok(!lower.includes("stdout"));
      assert.ok(!lower.includes("stderr"));
      assert.ok(!lower.includes("artifacts"));
      assert.ok(!lower.includes("metadata"));
      assert.ok(!lower.includes("details"));
      assert.ok(!lower.includes("record<string, unknown>"));
      assert.ok(!lower.includes("bomprati"));
      assert.ok(!lower.includes("argus"));
      assert.ok(!lower.includes("github"));
    }
  });

  it("mantém contrato fechado no tipo", () => {
    const adapter = new OpenHandsExecutorAdapter({
      sandboxBaseDir: join(tmpdir(), "wus-openhands-types"),
      runtimeBridge: createRuntimeBridge((input) => createRuntimeBridgeSession(input)),
    });

    type AdapterImplementsPort = OpenHandsExecutorAdapter extends ExecutorPort ? true : false;
    const adapterImplementsPort: AdapterImplementsPort = true;

    assert.equal(typeof adapter.execute, "function");
    assert.equal(adapterImplementsPort, true);
  });
});
