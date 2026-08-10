import type { WorkUnit } from "./work-unit.js";

export type SupervisorCategory =
  | "AUTHORIZATION"
  | "VALIDATION"
  | "PRECONDITION"
  | "CAPABILITY"
  | "EVIDENCE";

export type SupervisorReason = {
  readonly code: string;
  readonly category: SupervisorCategory;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type SupervisorEvidence = {
  readonly code: string;
  readonly category: SupervisorCategory;
  readonly message: string;
  readonly source: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type SupervisorPrecondition = {
  readonly id: string;
  readonly isSatisfied: boolean;
};

export type SupervisorRequiredEvidence = {
  readonly id: string;
  readonly isPresent: boolean;
};

export type SupervisorAuthorization = {
  readonly isAuthorized: boolean;
  readonly reason?: string;
};

export type SupervisorInput = {
  readonly workUnit: WorkUnit;
  readonly authorization: SupervisorAuthorization;
  readonly preconditions: readonly SupervisorPrecondition[];
  readonly capabilities: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly requiredEvidences: readonly SupervisorRequiredEvidence[];
};

export type SupervisorNextAction =
  | "WAIT_FOR_DEPENDENCY"
  | "REJECT_WORK_UNIT";

export type SupervisorReadyDecision = {
  readonly state: "RUNNING";
  readonly reasons: readonly SupervisorReason[];
  readonly evidences: readonly SupervisorEvidence[];
};

export type SupervisorBlockedDecision = {
  readonly state: "BLOCKED";
  readonly nextAction: SupervisorNextAction;
  readonly reasons: readonly SupervisorReason[];
  readonly evidences: readonly SupervisorEvidence[];
};

export type SupervisorDecision = SupervisorReadyDecision | SupervisorBlockedDecision;

const SUPERVISABLE_STATUSES = new Set<WorkUnit["status"]>(["READY", "RUNNING"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function sortReasonsDeterministically(reasons: SupervisorReason[]): SupervisorReason[] {
  return [...reasons].sort((a, b) => {
    const categoryCmp = a.category.localeCompare(b.category);
    if (categoryCmp !== 0) return categoryCmp;
    return a.code.localeCompare(b.code);
  });
}

function sortEvidencesDeterministically(evidences: SupervisorEvidence[]): SupervisorEvidence[] {
  return [...evidences].sort((a, b) => {
    const categoryCmp = a.category.localeCompare(b.category);
    if (categoryCmp !== 0) return categoryCmp;
    return a.code.localeCompare(b.code);
  });
}

function cloneReason(reason: SupervisorReason): SupervisorReason {
  return {
    code: reason.code,
    category: reason.category,
    message: reason.message,
    ...(reason.details !== undefined ? { details: structuredClone(reason.details) } : {}),
  };
}

function cloneEvidence(evidence: SupervisorEvidence): SupervisorEvidence {
  return {
    code: evidence.code,
    category: evidence.category,
    message: evidence.message,
    source: evidence.source,
    ...(evidence.details !== undefined ? { details: structuredClone(evidence.details) } : {}),
  };
}

function cloneReasons(reasons: readonly SupervisorReason[]): SupervisorReason[] {
  return reasons.map(cloneReason);
}

function cloneEvidences(evidences: readonly SupervisorEvidence[]): SupervisorEvidence[] {
  return evidences.map(cloneEvidence);
}

function isStringArray(value: readonly unknown[]): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function validateWorkUnitStructure(
  workUnit: WorkUnit,
  reasons: SupervisorReason[],
  evidences: SupervisorEvidence[]
): boolean {
  const hasValidCoreFields =
    isNonEmptyString(workUnit.id) &&
    isNonEmptyString(workUnit.domain) &&
    isNonEmptyString(workUnit.phase);

  const hasValidScope =
    workUnit.scope !== undefined &&
    workUnit.scope !== null &&
    typeof workUnit.scope === "object" &&
    isStringArray(workUnit.scope.allowedPaths) &&
    isStringArray(workUnit.scope.forbiddenPaths);

  const hasValidStatus = SUPERVISABLE_STATUSES.has(workUnit.status);

  if (!hasValidCoreFields || !hasValidScope) {
    reasons.push({
      code: "INVALID_WORK_UNIT_STRUCTURE",
      category: "VALIDATION",
      message: "A WorkUnit não possui a estrutura mínima válida para supervisão.",
    });
  }

  if (hasValidCoreFields && hasValidScope && hasValidStatus) {
    evidences.push({
      code: "WORK_UNIT_STRUCTURE_VALID",
      category: "VALIDATION",
      message: "Estrutura da WorkUnit validada com sucesso.",
      source: "supervisor-core",
    });
  }

  if (!hasValidStatus) {
    reasons.push({
      code: "INVALID_WORK_UNIT_STATUS",
      category: "VALIDATION",
      message: `Status '${String(workUnit.status)}' não é supervisionável. Apenas READY e RUNNING são aceitos.`,
    });
  }

  if (hasValidCoreFields && hasValidScope && hasValidStatus) {
    return true;
  }

  return false;
}

function validateAuthorization(
  input: SupervisorInput,
  reasons: SupervisorReason[],
  evidences: SupervisorEvidence[]
): boolean {
  if (!input.authorization.isAuthorized) {
    reasons.push({
      code: "UNAUTHORIZED",
      category: "AUTHORIZATION",
      message: input.authorization.reason ?? "A execução não está autorizada.",
    });
    return false;
  }

  evidences.push({
    code: "AUTHORIZED",
    category: "AUTHORIZATION",
    message: "Autorização declarativa confirmada para a unidade de trabalho.",
    source: "declarative-authorization",
  });

  return true;
}

function evaluatePreconditions(
  input: SupervisorInput,
  reasons: SupervisorReason[],
  evidences: SupervisorEvidence[]
): boolean {
  const sorted = [...input.preconditions].sort((a, b) => a.id.localeCompare(b.id));

  for (const precondition of sorted) {
    if (!precondition.isSatisfied) {
      reasons.push({
        code: "PRECONDITION_NOT_SATISFIED",
        category: "PRECONDITION",
        message: `Pré-condição não satisfeita: ${precondition.id}`,
        details: { preconditionId: precondition.id },
      });
      return false;
    }

    evidences.push({
      code: "PRECONDITION_SATISFIED",
      category: "PRECONDITION",
      message: `Pré-condição satisfeita: ${precondition.id}`,
      source: "supervisor-core",
      details: { preconditionId: precondition.id },
    });
  }

  return true;
}

function evaluateCapabilities(
  input: SupervisorInput,
  reasons: SupervisorReason[],
  evidences: SupervisorEvidence[]
): boolean {
  const available = new Set(input.capabilities);
  const required = [...input.requiredCapabilities].sort((a, b) => a.localeCompare(b));

  for (const capability of required) {
    if (!available.has(capability)) {
      reasons.push({
        code: "CAPABILITY_UNAVAILABLE",
        category: "CAPABILITY",
        message: `Capacidade necessária indisponível: ${capability}`,
        details: { capability },
      });
      return false;
    }
  }

  if (required.length > 0) {
    evidences.push({
      code: "CAPABILITIES_CONFIRMED",
      category: "CAPABILITY",
      message: "Todas as capacidades declaradas estão disponíveis.",
      source: "supervisor-core",
    });
  }

  return true;
}

function evaluateRequiredEvidences(
  input: SupervisorInput,
  reasons: SupervisorReason[],
  evidences: SupervisorEvidence[]
): boolean {
  const sorted = [...input.requiredEvidences].sort((a, b) => a.id.localeCompare(b.id));

  for (const required of sorted) {
    if (!required.isPresent) {
      reasons.push({
        code: "REQUIRED_EVIDENCE_MISSING",
        category: "EVIDENCE",
        message: `Evidência obrigatória ausente: ${required.id}`,
        details: { evidenceId: required.id },
      });
      return false;
    }

    evidences.push({
      code: "REQUIRED_EVIDENCE_PRESENT",
      category: "EVIDENCE",
      message: `Evidência obrigatória confirmada: ${required.id}`,
      source: "supervisor-core",
      details: { evidenceId: required.id },
    });
  }

  return true;
}

function detectScopeConflicts(
  workUnit: WorkUnit,
  reasons: SupervisorReason[],
  evidences: SupervisorEvidence[]
): boolean {
  const allowed = new Set(workUnit.scope.allowedPaths);
  const forbidden = workUnit.scope.forbiddenPaths.filter((path) => allowed.has(path)).sort();

  if (forbidden.length > 0) {
    reasons.push({
      code: "PATH_CONFLICT",
      category: "VALIDATION",
      message: `Conflito entre allowedPaths e forbiddenPaths: ${forbidden.join(", ")}`,
      details: { conflictingPaths: forbidden },
    });
    return false;
  }

  evidences.push({
    code: "NO_INCONSISTENCIES",
    category: "VALIDATION",
    message: "Nenhuma inconsistência detectada nos dados declarados.",
    source: "supervisor-core",
  });

  return true;
}

function buildDecision(
  state: "RUNNING" | "BLOCKED",
  nextAction: SupervisorNextAction | undefined,
  reasons: SupervisorReason[],
  evidences: SupervisorEvidence[],
): SupervisorDecision {
  const clonedReasons = cloneReasons(sortReasonsDeterministically(reasons));
  const clonedEvidences = cloneEvidences(sortEvidencesDeterministically(evidences));

  if (state === "RUNNING") {
    return {
      state,
      reasons: clonedReasons,
      evidences: clonedEvidences,
    };
  }

  if (nextAction === undefined) {
    throw new Error("BLOCKED decision requires a nextAction");
  }

  return {
    state,
    nextAction,
    reasons: clonedReasons,
    evidences: clonedEvidences,
  };
}

export function decideSupervisor(input: SupervisorInput): SupervisorDecision {
  const reasons: SupervisorReason[] = [];
  const evidences: SupervisorEvidence[] = [];

  const isStructureValid = validateWorkUnitStructure(input.workUnit, reasons, evidences);
  if (!isStructureValid) {
    return buildDecision("BLOCKED", "REJECT_WORK_UNIT", reasons, evidences);
  }

  const isAuthorized = validateAuthorization(input, reasons, evidences);
  if (!isAuthorized) {
    return buildDecision("BLOCKED", "REJECT_WORK_UNIT", reasons, evidences);
  }

  const preconditionsOk = evaluatePreconditions(input, reasons, evidences);
  if (!preconditionsOk) {
    return buildDecision("BLOCKED", "WAIT_FOR_DEPENDENCY", reasons, evidences);
  }

  const capabilitiesOk = evaluateCapabilities(input, reasons, evidences);
  if (!capabilitiesOk) {
    return buildDecision("BLOCKED", "WAIT_FOR_DEPENDENCY", reasons, evidences);
  }

  const evidencesOk = evaluateRequiredEvidences(input, reasons, evidences);
  if (!evidencesOk) {
    return buildDecision("BLOCKED", "WAIT_FOR_DEPENDENCY", reasons, evidences);
  }

  const scopeIsConsistent = detectScopeConflicts(input.workUnit, reasons, evidences);
  if (!scopeIsConsistent) {
    return buildDecision("BLOCKED", "REJECT_WORK_UNIT", reasons, evidences);
  }

  return buildDecision("RUNNING", undefined, reasons, evidences);
}
