import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSupervisorResult,
  decideSupervisor,
  type SupervisorInput,
  type WorkUnit,
} from "../src/core/index.js";
import { readFile } from "node:fs/promises";

const validWorkUnit: WorkUnit = {
  id: "unit-1",
  domain: "core",
  phase: "decision",
  status: "READY",
  scope: {
    allowedPaths: ["src/core/**"],
    forbiddenPaths: ["src/infrastructure/**"],
  },
};

function createInput(overrides: Partial<SupervisorInput> = {}): SupervisorInput {
  return {
    workUnit: { ...validWorkUnit, scope: { ...validWorkUnit.scope } },
    authorization: { isAuthorized: true },
    preconditions: [],
    capabilities: ["EXECUTOR", "DIFF_AUDITOR"],
    requiredCapabilities: ["EXECUTOR"],
    requiredEvidences: [],
    ...overrides,
  };
}

describe("Supervisor result model", () => {
  it("transforma uma decisão READY em um resultado serializável estável", () => {
    const decision = decideSupervisor(createInput());
    const result = buildSupervisorResult("exec-1", validWorkUnit, decision);

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.execution.executionId, "exec-1");
    assert.equal(result.decision.state, "RUNNING");
    assert.deepEqual(result.decision, decision);
  });

  it("transforma uma decisão bloqueada em um envelope estável", () => {
    const decision = decideSupervisor(
      createInput({
        authorization: { isAuthorized: false, reason: "blocked" },
      })
    );
    const result = buildSupervisorResult("exec-1", validWorkUnit, decision);

    assert.equal(result.decision.state, "BLOCKED");
    assert.equal(result.decision.nextAction, "REJECT_WORK_UNIT");
    assert.deepEqual(result.decision, decision);
  });

  it("preserva a ordem determinística de reasons e evidences", () => {
    const decision = decideSupervisor(
      createInput({
        preconditions: [
          { id: "z-last", isSatisfied: true },
          { id: "a-first", isSatisfied: true },
        ],
        requiredCapabilities: ["DIFF_AUDITOR", "EXECUTOR"],
        capabilities: ["DIFF_AUDITOR", "EXECUTOR"],
        requiredEvidences: [
          { id: "b-evidence", isPresent: true },
          { id: "a-evidence", isPresent: true },
        ],
      })
    );
    const result = buildSupervisorResult("exec-1", validWorkUnit, decision);

    assert.deepEqual(result.decision.reasons, decision.reasons);
    assert.deepEqual(result.decision.evidences, decision.evidences);
  });

  it("não muta a decisão nem o input", () => {
    const input = createInput({
      preconditions: [{ id: "db-ready", isSatisfied: true }],
      requiredCapabilities: ["EXECUTOR"],
      requiredEvidences: [{ id: "audit-report", isPresent: true }],
    });
    const decision = decideSupervisor(input);
    const inputClone = JSON.parse(JSON.stringify(input)) as SupervisorInput;
    const decisionClone = JSON.parse(JSON.stringify(decision));

    assert.doesNotThrow(() => buildSupervisorResult("exec-1", validWorkUnit, decision));
    assert.deepEqual(input, inputClone);
    assert.deepEqual(decision, decisionClone);
  });

  it("não reutiliza referências mutáveis internas", () => {
    const decision = decideSupervisor(
      createInput({
        workUnit: {
          ...validWorkUnit,
          scope: {
            allowedPaths: ["src/core/**"],
            forbiddenPaths: ["src/core/**"],
          },
        },
      })
    );
    const result = buildSupervisorResult("exec-1", validWorkUnit, decision);

    assert.notStrictEqual(result.decision, decision);
    assert.notStrictEqual(result.decision.reasons, decision.reasons);
    assert.notStrictEqual(result.decision.evidences, decision.evidences);
    assert.notStrictEqual(result.decision.reasons[0], decision.reasons[0]);
    assert.notStrictEqual(result.decision.evidences[0], decision.evidences[0]);

    const resultReason = result.decision.reasons[0];
    if (resultReason && resultReason.details && "conflictingPaths" in resultReason.details) {
      const conflictingPaths = resultReason.details.conflictingPaths as string[];
      conflictingPaths.push("mutated");
      assert.ok(!("mutated" in (decision.reasons[0]?.details as Record<string, unknown> | undefined ?? {})));
    }
  });

  it("mantém a saída estável para a mesma decisão", () => {
    const decision = decideSupervisor(createInput());
    const first = buildSupervisorResult("exec-1", validWorkUnit, decision);
    const second = buildSupervisorResult("exec-1", validWorkUnit, decision);

    assert.deepEqual(first, second);
  });

  it("não contém nomenclatura proibida no modelo de resultado", async () => {
    const source = await readFile(new URL("../../src/core/result.ts", import.meta.url), "utf8");
    const firstToken = ["legacy", "-", "brand"].join("");
    const secondToken = ["legacy", "-", "engine"].join("");
    const thirdToken = ["legacy", "-", "domain"].join("");
    const fourthToken = ["legacy", "-", "entity"].join("");

    assert.ok(!source.includes(firstToken));
    assert.ok(!source.includes(secondToken));
    assert.ok(!source.includes(thirdToken));
    assert.ok(!source.includes(fourthToken));
  });
});
