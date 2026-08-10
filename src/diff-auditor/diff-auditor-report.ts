import type { DiffAuditReason, DiffAuditResult } from "./diff-auditor-contracts.js";

export type DiffAuditReportItem = {
  readonly title: string;
  readonly content: string;
};

export type DiffAuditReport = {
  readonly title: string;
  readonly status: DiffAuditResult["status"];
  readonly items: readonly DiffAuditReportItem[];
};

function formatReason(reason: DiffAuditReason): string {
  return "path" in reason ? `[${reason.code}] ${reason.message} (${reason.path})` : `[${reason.code}] ${reason.message}`;
}

export function buildDiffAuditReport(result: DiffAuditResult): DiffAuditReport {
  const items: DiffAuditReportItem[] = [];

  if (result.status === "REJECTED" && result.reasons.length > 0) {
    items.push({
      title: "Reasons",
      content: result.reasons.map(formatReason).join("\n"),
    });
  }

  return {
    title: "Diff Audit Report",
    status: result.status,
    items,
  };
}

