import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideSupervisor, type SupervisorDecision, type SupervisorInput, type WorkUnit } from "../src/core/index.js";

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

describe("Core decision engine", () => {
  it("produz READY determinístico quando tudo está válido", () => {
    const decision = decideSupervisor(createInput());

    assert.equal(decision.state, "RUNNING");
    assert.ok(!("nextAction" in decision));
    assert.equal(decision.reasons.length, 0);
    assert.equal(decision.evidences.length, 4);
  });

  it("bloqueia quando a autorização é negada", () => {
    const decision = decideSupervisor(createInput({ authorization: { isAuthorized: false } }));

    assert.equal(decision.state, "BLOCKED");
    assert.equal(decision.nextAction, "REJECT_WORK_UNIT");
    assert.ok(decision.reasons.some((reason) => reason.code === "UNAUTHORIZED"));
  });

  it("bloqueia quando uma precondição não é satisfeita", () => {
    const decision = decideSupervisor(
      createInput({ preconditions: [{ id: "db-ready", isSatisfied: false }] })
    );

    assert.equal(decision.state, "BLOCKED");
    assert.equal(decision.nextAction, "WAIT_FOR_DEPENDENCY");
    assert.ok(decision.reasons.some((reason) => reason.code === "PRECONDITION_NOT_SATISFIED"));
  });

  it("bloqueia quando uma capability obrigatória está ausente", () => {
    const decision = decideSupervisor(
      createInput({ capabilities: [], requiredCapabilities: ["EXECUTOR"] })
    );

    assert.equal(decision.state, "BLOCKED");
    assert.equal(decision.nextAction, "WAIT_FOR_DEPENDENCY");
    assert.ok(decision.reasons.some((reason) => reason.code === "CAPABILITY_UNAVAILABLE"));
  });

  it("bloqueia quando uma evidência obrigatória está ausente", () => {
    const decision = decideSupervisor(
      createInput({ requiredEvidences: [{ id: "audit-report", isPresent: false }] })
    );

    assert.equal(decision.state, "BLOCKED");
    assert.equal(decision.nextAction, "WAIT_FOR_DEPENDENCY");
    assert.ok(decision.reasons.some((reason) => reason.code === "REQUIRED_EVIDENCE_MISSING"));
  });

  it("bloqueia work units estruturalmente inválidas", () => {
    const decision = decideSupervisor(
      createInput({
        workUnit: {
          ...validWorkUnit,
          id: "",
        } as unknown as WorkUnit,
      })
    );

    assert.equal(decision.state, "BLOCKED");
    assert.equal(decision.nextAction, "REJECT_WORK_UNIT");
    assert.ok(decision.reasons.some((reason) => reason.code === "INVALID_WORK_UNIT_STRUCTURE"));
  });

  it("bloqueia conflito de scope", () => {
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

    assert.equal(decision.state, "BLOCKED");
    assert.equal(decision.nextAction, "REJECT_WORK_UNIT");
    assert.ok(decision.reasons.some((reason) => reason.code === "PATH_CONFLICT"));
  });

  it("é determinístico para o mesmo input", () => {
    const input = createInput({
      preconditions: [
        { id: "z-last", isSatisfied: true },
        { id: "a-first", isSatisfied: true },
      ],
      requiredCapabilities: ["DIFF_AUDITOR", "EXECUTOR"],
      capabilities: ["EXECUTOR", "DIFF_AUDITOR"],
      requiredEvidences: [
        { id: "b-evidence", isPresent: true },
        { id: "a-evidence", isPresent: true },
      ],
    });

    const first = decideSupervisor(input);
    const second = decideSupervisor(input);

    assert.deepEqual(first, second);
  });

  it("não muta o input", () => {
    const input = createInput({
      preconditions: [{ id: "db-ready", isSatisfied: true }],
      requiredCapabilities: ["EXECUTOR"],
      requiredEvidences: [{ id: "audit-report", isPresent: true }],
    });

    const clone = JSON.parse(JSON.stringify(input)) as SupervisorInput;

    assert.doesNotThrow(() => decideSupervisor(input));
    assert.deepEqual(input, clone);
  });

  it("não expõe combinações impossíveis no tipo", () => {
    const invalidReady: SupervisorDecision = {
      state: "RUNNING",
      reasons: [],
      evidences: [],
      // @ts-expect-error RUNNING must not expose nextAction
      nextAction: "WAIT_FOR_DEPENDENCY",
    };

    // @ts-expect-error BLOCKED requires nextAction
    const invalidBlocked: SupervisorDecision = {
      state: "BLOCKED",
      reasons: [],
      evidences: [],
    };

    assert.equal(invalidReady.state, "RUNNING");
    assert.equal(invalidBlocked.state, "BLOCKED");
  });

  it("não permite stop nem nextAction em READY", () => {
    const decision = decideSupervisor(createInput());

    assert.equal(decision.state, "RUNNING");
    assert.ok(!("nextAction" in decision));
    assert.ok(!("stop" in decision));
  });
});
