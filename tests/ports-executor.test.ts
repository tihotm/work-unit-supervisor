import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ExecutorInput,
  type ExecutorPort,
  type ExecutorReason,
  type ExecutorResult,
  type ExecutorSucceededResult,
} from "../src/ports/index.js";
import { type WorkUnit } from "../src/core/index.js";

async function runNodeScript(scriptPath: string, cwd: string) {
  return await new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const validWorkUnit: WorkUnit = {
  id: "unit-1",
  domain: "core",
  phase: "execution",
  status: "READY",
  scope: {
    allowedPaths: ["src/core/**"],
    forbiddenPaths: ["src/infrastructure/**"],
  },
};

function createInput(overrides: Partial<ExecutorInput> = {}): ExecutorInput {
  return {
    executionId: "exec-1",
    workUnit: validWorkUnit,
    limits: {
      timeoutMs: 1_000,
      maxCommands: 10,
      maxChangedFiles: 5,
    },
    ...overrides,
  };
}

describe("Executor port contract", () => {
  it("permite que um fake implemente ExecutorPort", async () => {
    const fakeExecutor: ExecutorPort = {
      async execute(input) {
        assert.equal(input.executionId, "exec-1");
        assert.equal(input.workUnit.id, validWorkUnit.id);
        return {
          status: "SUCCEEDED",
          changedFiles: ["src/core/execution.ts"],
          executedCommands: ["npm test"],
          exitCode: 0,
        };
      },
    };

    const result = await fakeExecutor.execute(createInput());

    assert.equal(result.status, "SUCCEEDED");
    assert.deepEqual(result.changedFiles, ["src/core/execution.ts"]);
    assert.deepEqual(result.executedCommands, ["npm test"]);
    assert.equal(result.exitCode, 0);
  });

  it("aceita Core.WorkUnit diretamente no ExecutorInput", () => {
    const input: ExecutorInput = createInput();

    assert.equal(input.workUnit.domain, "core");
    assert.equal(input.workUnit.scope.allowedPaths[0], "src/core/**");
  });

  it("representa resultado de sucesso e de falha sem payload arbitrário", () => {
    const success: ExecutorSucceededResult = {
      status: "SUCCEEDED",
      changedFiles: [],
      executedCommands: [],
      exitCode: 0,
    };

    const failure: ExecutorResult = {
      status: "FAILED",
      changedFiles: ["src/core/work-unit.ts"],
      executedCommands: ["npm run build"],
      reasons: [{ code: "NON_ZERO_EXIT", message: "Processo retornou exit code 1." }],
      exitCode: 1,
    };

    assert.equal(success.status, "SUCCEEDED");
    assert.equal(failure.status, "FAILED");
    assert.ok("reasons" in failure);
  });

  it("não expõe payload arbitrário nem detalhes genéricos", async () => {
    type ReasonHasDetails = "details" extends keyof ExecutorReason ? true : false;
    const reasonHasDetails: ReasonHasDetails = false;
    void reasonHasDetails;

    const source = [
      new URL("../../src/ports/executor.ts", import.meta.url),
      new URL("../../src/ports/index.ts", import.meta.url),
    ];

    await Promise.all(source.map(async (file) => {
      const text = await readFile(file, "utf8");
      assert.ok(!text.includes("metadata"));
      assert.ok(!text.includes("details?:"));
      assert.ok(!text.includes("Record<string, unknown>"));
      assert.ok(!text.includes("stdout"));
      assert.ok(!text.includes("stderr"));
      assert.ok(!text.includes("artifacts"));
    }));
  });

  it("não contém referências BomPraTi nem Argus e não importa infraestrutura concreta", async () => {
    const files = [
      new URL("../../src/ports/executor.ts", import.meta.url),
      new URL("../../src/ports/index.ts", import.meta.url),
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const lower = source.toLowerCase();

      assert.ok(!lower.includes("bomprati"));
      assert.ok(!lower.includes("argus"));
      assert.ok(!lower.includes("infrastructure"));
      assert.ok(!lower.includes("prisma"));
      assert.ok(!lower.includes("github"));
      assert.ok(!lower.includes("planner"));
      assert.ok(!lower.includes("catalog"));
      assert.ok(!lower.includes("manufacturer"));
      assert.ok(!lower.includes("vehicle"));
      assert.ok(!lower.includes("process.env"));
      assert.ok(!lower.includes("node:fs"));
    }
  });

  it("bloqueia traversal fora do boundary de ports", async () => {
    const boundaryScript = fileURLToPath(new URL("../../scripts/check-import-boundary.mjs", import.meta.url));
    const validWorkspace = await createWorkspace({
      "src/core/work-unit.ts": "export const workUnit = 1;\n",
      "src/ports/executor.ts": 'import { workUnit } from "../core/work-unit.js";\nexport const executor = workUnit;\n',
      "src/ports/index.ts": 'export * from "./executor.js";\n',
    });
    const invalidWorkspace = await createWorkspace({
      "src/core/work-unit.ts": "export const workUnit = 1;\n",
      "src/ports/evil.ts": 'export * from "./../rogue.js";\n',
    });

    try {
      const validRun = await runNodeScript(boundaryScript, validWorkspace);
      assert.equal(validRun.code, 0, validRun.stderr);

      const invalidRun = await runNodeScript(boundaryScript, invalidWorkspace);
      assert.notEqual(invalidRun.code, 0);
      assert.match(invalidRun.stderr, /ports must only import core or local modules|blocked import boundary/i);
    } finally {
      await Promise.allSettled([
        rm(validWorkspace, { recursive: true, force: true }),
        rm(invalidWorkspace, { recursive: true, force: true }),
      ]);
    }
  });

  it("o Core continua sem importar ports", async () => {
    const coreDir = new URL("../../src/core/", import.meta.url);
    const entries = await readdir(coreDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }

      const source = await readFile(new URL(`../../src/core/${entry.name}`, import.meta.url), "utf8");
      assert.ok(!source.includes("../ports/"));
      assert.ok(!source.includes("./ports"));
    }
  });

  it("não permite variantes inválidas no tipo", () => {
    // @ts-expect-error FAILED requires reasons
    const invalidFailed: ExecutorResult = {
      status: "FAILED",
      changedFiles: [],
      executedCommands: [],
    };

    // @ts-expect-error SUCCEEDED must not expose reasons
    const invalidSucceeded: ExecutorResult = {
      status: "SUCCEEDED",
      changedFiles: [],
      executedCommands: [],
      exitCode: 0,
      reasons: [],
    };

    // @ts-expect-error BLOCKED requires reasons
    const invalidBlocked: ExecutorResult = {
      status: "BLOCKED",
      changedFiles: [],
      executedCommands: [],
    };

    assert.equal(invalidFailed.status, "FAILED");
    assert.equal(invalidSucceeded.status, "SUCCEEDED");
    assert.equal(invalidBlocked.status, "BLOCKED");
  });
});

async function createWorkspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "wus-ports-"));
  await Promise.all([
    mkdir(join(root, "src", "core"), { recursive: true }),
    mkdir(join(root, "src", "ports"), { recursive: true }),
  ]);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const target = join(root, ...relativePath.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }),
  );
  return root;
}
