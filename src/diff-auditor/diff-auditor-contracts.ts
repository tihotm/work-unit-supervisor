import type { WorkUnit } from "../core/work-unit.js";

export type DiffFileChange =
  | {
      readonly type: "ADDED" | "MODIFIED" | "DELETED";
      readonly path: string;
    }
  | {
      readonly type: "RENAMED" | "COPIED";
      readonly oldPath: string;
      readonly newPath: string;
    };

export type DiffAuditInput = {
  readonly workUnit: WorkUnit;
  readonly changes: readonly DiffFileChange[];
};

export type DiffAuditReason =
  | {
      readonly code: "INVALID_INPUT";
      readonly message: string;
    }
  | {
      readonly code: "INVALID_WORK_UNIT_STRUCTURE";
      readonly message: string;
    }
  | {
      readonly code: "INVALID_WORK_UNIT_STATUS";
      readonly message: string;
    }
  | {
      readonly code: "INVALID_CHANGE";
      readonly message: string;
    }
  | {
      readonly code: "INVALID_PATH";
      readonly message: string;
      readonly path: string;
    }
  | {
      readonly code: "PATH_NOT_ALLOWED";
      readonly message: string;
      readonly path: string;
    }
  | {
      readonly code: "PATH_FORBIDDEN";
      readonly message: string;
      readonly path: string;
    };

export type DiffAuditAdmissibleResult = {
  readonly status: "ADMISSIBLE";
};

export type DiffAuditRejectedResult = {
  readonly status: "REJECTED";
  readonly reasons: readonly DiffAuditReason[];
};

export type DiffAuditResult = DiffAuditAdmissibleResult | DiffAuditRejectedResult;

