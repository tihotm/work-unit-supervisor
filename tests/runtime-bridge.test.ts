import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createRuntimeBridge, type RuntimeBridgeEngine, type RuntimeBridgeInput, type RuntimeBridgeResult } from "../src/executors/runtime-bridge.js";
import type { WorkUnit } from "../src/core/work-unit.js";

function createWorkUnit(): WorkUnit {
  return {
    id: "wu-1",
    domain: "runtime",
    phase: "bridge",
    status: "RUNNING",
    scope: {
      allowedPaths: ["src/app"],
      forbiddenPaths: ["src/app/secrets"],
    },
  };
}

function createInput(): RuntimeBridgeInput {
  return {
    executionId: "exec-1",
    workspaceDir: "C:/tmp/workspace",
    workUnit: createWorkUnit(),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("Runtime bridge", () => {
  it("inicia uma execução e acompanha status factual", async () => {
    const gate = createDeferred<RuntimeBridgeResult>();
    const engine: RuntimeBridgeEngine = {
      async execute(_input) {
        return await gate.promise;
      },
      async cancel() {
        return undefined;
      },
    };

    const bridge = createRuntimeBridge(engine);
    const session = await bridge.start(createInput());

    assert.deepEqual(await session.status(), {
      executionId: "exec-1",
      status: "RUNNING",
    });

    gate.resolve({
      executionId: "exec-1",
      status: "SUCCEEDED",
      exitCode: 0,
      executedCommands: ["edit-file"],
    });

    assert.deepEqual(await session.result(), {
      executionId: "exec-1",
      status: "SUCCEEDED",
      exitCode: 0,
      executedCommands: ["edit-file"],
    });

    assert.deepEqual(await session.status(), {
      executionId: "exec-1",
      status: "SUCCEEDED",
      exitCode: 0,
      executedCommands: ["edit-file"],
    });
  });

  it("cancela usando executionId e não muta o input original", async () => {
    let cancelledExecutionId = "";
    let seenInput: RuntimeBridgeInput | undefined;
    const engine: RuntimeBridgeEngine = {
      async execute(input) {
        seenInput = input;
        const allowedPaths = input.workUnit.scope.allowedPaths as string[];
        allowedPaths.push("mutated");
        return {
          executionId: input.executionId,
          status: "FAILED",
          reasons: [{ code: "FAILED", message: "boom" }],
          executedCommands: ["cmd"],
        };
      },
      async cancel(executionId) {
        cancelledExecutionId = executionId;
      },
    };

    const bridge = createRuntimeBridge(engine);
    const input = createInput();
    const original = structuredClone(input);
    const session = await bridge.start(input);

    await session.cancel();
    const result = await session.result();

    assert.equal(cancelledExecutionId, "exec-1");
    assert.equal(seenInput?.workUnit.scope.allowedPaths.includes("mutated"), true);
    assert.deepEqual(input, original);
    assert.deepEqual(result, {
      executionId: "exec-1",
      status: "FAILED",
      reasons: [{ code: "FAILED", message: "boom" }],
      executedCommands: ["cmd"],
    });
  });

  it("representa falha factual quando o engine rejeita", async () => {
    const engine: RuntimeBridgeEngine = {
      async execute() {
        throw new Error("runtime exploded");
      },
      async cancel() {
        return undefined;
      },
    };

    const bridge = createRuntimeBridge(engine);
    const session = await bridge.start(createInput());
    const result = await session.result();

    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.equal(result.reasons[0]?.code, "RUNTIME_BRIDGE_FAILURE");
    }
  });

  it("trata throw síncrono do engine como falha factual", async () => {
    const engine: RuntimeBridgeEngine = {
      execute() {
        throw new Error("sync exploded");
      },
      async cancel() {
        return undefined;
      },
    };

    const bridge = createRuntimeBridge(engine);
    const session = await bridge.start(createInput());
    assert.deepEqual(await session.status(), {
      executionId: "exec-1",
      status: "RUNNING",
    });

    const result = await session.result();
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.equal(result.reasons[0]?.code, "RUNTIME_BRIDGE_FAILURE");
      assert.match(result.reasons[0]?.message ?? "", /sync exploded/);
    }
    assert.equal(session.executionId, "exec-1");
  });

  it("não compartilha referências mutáveis de saída", async () => {
    const engine: RuntimeBridgeEngine = {
      async execute(input) {
        return {
          executionId: input.executionId,
          status: "FAILED",
          reasons: [{ code: "FAILED", message: "boom" }],
          executedCommands: ["cmd"],
        };
      },
      async cancel() {
        return undefined;
      },
    };

    const bridge = createRuntimeBridge(engine);
    const session = await bridge.start(createInput());
    const result = await session.result();
    const executedCommands = result.executedCommands as string[];
    executedCommands.push("mutated");

    const nextResult = await session.result();
    assert.deepEqual(nextResult.executedCommands, ["cmd"]);
  });

  it("não expõe política, OpenHands ou detalhes arbitrários no source", async () => {
    const source = await readFile(new URL("../../src/executors/runtime-bridge.ts", import.meta.url), "utf8");
    const lower = source.toLowerCase();

    assert.ok(!lower.includes("admissible"));
    assert.ok(!lower.includes("rejected"));
    assert.ok(!lower.includes("openhands"));
    assert.ok(!lower.includes("bomprati"));
    assert.ok(!lower.includes("argus"));
    assert.ok(!lower.includes("quality gate"));
    assert.ok(!lower.includes("diff auditor"));
    assert.ok(!lower.includes("metadata"));
    assert.ok(!lower.includes("details"));
    assert.ok(!lower.includes("stdout"));
    assert.ok(!lower.includes("stderr"));
    assert.ok(!lower.includes("artifacts"));
  });

  it("boundary check bloqueia core -> executors", async () => {
    const tempSourcePath = resolve(process.cwd(), "src/core/.tmp-runtime-bridge-boundary-test.ts");
    try {
      await writeFile(tempSourcePath, 'import "../executors/runtime-bridge.js";\n', "utf8");
      assert.throws(() => {
        execFileSync(process.execPath, ["scripts/check-import-boundary.mjs"], {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      }, /core must not import ports, diff auditor, executors, or infrastructure/i);
    } finally {
      await rm(tempSourcePath, { force: true });
    }
  });

  it("mantém o contrato fechado no tipo", () => {
    const success: RuntimeBridgeResult = {
      executionId: "exec-1",
      status: "SUCCEEDED",
      exitCode: 0,
      executedCommands: [],
    };
    const failed: RuntimeBridgeResult = {
      executionId: "exec-1",
      status: "FAILED",
      reasons: [{ code: "FAILED", message: "boom" }],
      executedCommands: [],
    };

    // @ts-expect-error SUCCEEDED requires exitCode
    const invalidSuccess: RuntimeBridgeResult = {
      executionId: "exec-1",
      status: "SUCCEEDED",
      executedCommands: [],
    };

    // @ts-expect-error FAILED requires reasons
    const invalidFailed: RuntimeBridgeResult = {
      executionId: "exec-1",
      status: "FAILED",
      executedCommands: [],
    };

    assert.equal(success.status, "SUCCEEDED");
    assert.equal(failed.status, "FAILED");
    assert.equal(invalidSuccess.status, "SUCCEEDED");
    assert.equal(invalidFailed.status, "FAILED");
  });
});
