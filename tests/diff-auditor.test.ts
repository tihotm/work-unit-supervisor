import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { auditDiff, type DiffAuditInput, type DiffAuditReason, type DiffAuditResult, type DiffFileChange } from "../src/diff-auditor/index.js";
import { buildDiffAuditReport } from "../src/diff-auditor/diff-auditor-report.js";
import { type WorkUnit } from "../src/core/index.js";

const baseWorkUnit: WorkUnit = {
  id: "wu-1",
  domain: "catalog",
  phase: "enrichment",
  status: "RUNNING",
  scope: {
    allowedPaths: ["src/modules/car"],
    forbiddenPaths: ["src/modules/car/secrets"],
  },
};

function createInput(changes: readonly DiffFileChange[]): DiffAuditInput {
  return {
    workUnit: baseWorkUnit,
    changes,
  };
}

describe("Diff Auditor", () => {
  it("aprova diff admissível", () => {
    const result = auditDiff(
      createInput([
        { type: "MODIFIED", path: "src/modules/car/index.ts" },
      ]),
    );

    assert.equal(result.status, "ADMISSIBLE");
  });

  it("rejeita arquivo fora do escopo permitido", () => {
    const result = auditDiff(
      createInput([
        { type: "MODIFIED", path: "src/modules/other/index.ts" },
      ]),
    );

    assert.equal(result.status, "REJECTED");
    if (result.status === "REJECTED") {
      assert.ok(result.reasons.some((reason) => reason.code === "PATH_NOT_ALLOWED"));
    }
  });

  it("rejeita caminho proibido", () => {
    const result = auditDiff(
      createInput([
        { type: "MODIFIED", path: "src/modules/car/secrets/token.ts" },
      ]),
    );

    assert.equal(result.status, "REJECTED");
    if (result.status === "REJECTED") {
      assert.ok(result.reasons.some((reason) => reason.code === "PATH_FORBIDDEN"));
    }
  });

  it("mantém ordenação determinística das reasons", () => {
    const first = auditDiff(
      createInput([
        { type: "MODIFIED", path: "src/modules/other/b.ts" },
        { type: "MODIFIED", path: "src/modules/car/secrets/a.ts" },
      ]),
    );
    const second = auditDiff(
      createInput([
        { type: "MODIFIED", path: "src/modules/car/secrets/a.ts" },
        { type: "MODIFIED", path: "src/modules/other/b.ts" },
      ]),
    );

    assert.deepEqual(first, second);
  });

  it("não expõe payload arbitrário nem campos genéricos", async () => {
    const sourceFiles = [
      new URL("../../src/diff-auditor/diff-auditor-contracts.ts", import.meta.url),
      new URL("../../src/diff-auditor/diff-auditor.ts", import.meta.url),
      new URL("../../src/diff-auditor/diff-auditor-report.ts", import.meta.url),
      new URL("../../src/diff-auditor/index.ts", import.meta.url),
    ];

    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      const lower = source.toLowerCase();
      assert.ok(!lower.includes("metadata"));
      assert.ok(!lower.includes("details"));
      assert.ok(!lower.includes("record<string, unknown>"));
      assert.ok(!lower.includes("stdout"));
      assert.ok(!lower.includes("stderr"));
      assert.ok(!lower.includes("artifacts"));
    }
  });

  it("usa WorkUnit do Core diretamente", () => {
    const input: DiffAuditInput = createInput([{ type: "ADDED", path: "src/modules/car/new.ts" }]);
    assert.equal(input.workUnit.scope.allowedPaths[0], "src/modules/car");
  });

  it("não depende de infra ou legado", async () => {
    const sourceFiles = [
      new URL("../../src/diff-auditor/diff-auditor-contracts.ts", import.meta.url),
      new URL("../../src/diff-auditor/diff-auditor.ts", import.meta.url),
      new URL("../../src/diff-auditor/diff-auditor-report.ts", import.meta.url),
      new URL("../../src/diff-auditor/index.ts", import.meta.url),
    ];

    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      const lower = source.toLowerCase();
      assert.ok(!lower.includes("openhands"));
      assert.ok(!lower.includes("argus"));
      assert.ok(!lower.includes("git"));
      assert.ok(!lower.includes("github"));
      assert.ok(!lower.includes("prisma"));
      assert.ok(!lower.includes("fs/promises"));
      assert.ok(!lower.includes("child_process"));
      assert.ok(!lower.includes("catalogo"));
      assert.ok(!lower.includes("manufacturer"));
      assert.ok(!lower.includes("vehicle"));
      assert.ok(!lower.includes("enrichment"));
    }
  });

  it("bloqueia variantes inválidas no tipo", () => {
    const admissible: DiffAuditResult = { status: "ADMISSIBLE" };
    const rejected: DiffAuditResult = {
      status: "REJECTED",
      reasons: [{ code: "INVALID_INPUT", message: "invalid" }],
    };

    const invalidAdmissible: DiffAuditResult = { status: "ADMISSIBLE",
      // @ts-expect-error ADMISSIBLE must not expose reasons
      reasons: [],
    };

    // @ts-expect-error REJECTED requires reasons
    const invalidRejected: DiffAuditResult = { status: "REJECTED" };

    assert.equal(admissible.status, "ADMISSIBLE");
    assert.equal(rejected.status, "REJECTED");
    assert.equal(invalidAdmissible.status, "ADMISSIBLE");
    assert.equal(invalidRejected.status, "REJECTED");
  });

  it("gera report puro e determinístico", () => {
    const result = auditDiff(
      createInput([
        { type: "MODIFIED", path: "src/modules/other/index.ts" },
      ]),
    );

    const report = buildDiffAuditReport(result);
    assert.equal(report.title, "Diff Audit Report");
    assert.equal(report.status, "REJECTED");
    assert.equal(report.items.length, 1);
    assert.ok(report.items[0]?.content.includes("PATH_NOT_ALLOWED"));
  });
});
