/**
 * Evaluate PR-level and per-file cost budgets defined in .calcis.yml.
 *
 * Returns a normalised result describing which thresholds were crossed, plus
 * the overall status (`pass` / `warn` / `fail`) used to drive the check run
 * conclusion and the `budget-status` action output.
 */

import type { CalcisBudgets } from "./config";

export type BudgetStatus = "pass" | "warn" | "fail";

export type ViolationKind =
  | "per-file-warn"
  | "per-file-fail"
  | "total-warn"
  | "total-fail";

export interface BudgetViolation {
  kind: ViolationKind;
  threshold: number;
  actual: number;
  file?: string; // undefined for total-* violations
}

export interface BudgetReport {
  status: BudgetStatus;
  warnings: BudgetViolation[];
  failures: BudgetViolation[];
  /** True when the config defines at least one budget threshold. */
  hasBudgets: boolean;
}

export interface FileCost {
  file: string;
  cost: number;
}

export function evaluateBudgets(
  budgets: CalcisBudgets,
  files: FileCost[],
  totalCost: number,
): BudgetReport {
  const warnings: BudgetViolation[] = [];
  const failures: BudgetViolation[] = [];

  const hasBudgets =
    budgets.perFileWarn !== undefined ||
    budgets.perFileFail !== undefined ||
    budgets.totalWarn !== undefined ||
    budgets.totalFail !== undefined;

  // Per-file checks — fail takes precedence over warn on the same file.
  for (const f of files) {
    if (budgets.perFileFail !== undefined && f.cost > budgets.perFileFail) {
      failures.push({
        kind: "per-file-fail",
        threshold: budgets.perFileFail,
        actual: f.cost,
        file: f.file,
      });
    } else if (budgets.perFileWarn !== undefined && f.cost > budgets.perFileWarn) {
      warnings.push({
        kind: "per-file-warn",
        threshold: budgets.perFileWarn,
        actual: f.cost,
        file: f.file,
      });
    }
  }

  // Totals — evaluate independently of per-file.
  if (budgets.totalFail !== undefined && totalCost > budgets.totalFail) {
    failures.push({
      kind: "total-fail",
      threshold: budgets.totalFail,
      actual: totalCost,
    });
  } else if (budgets.totalWarn !== undefined && totalCost > budgets.totalWarn) {
    warnings.push({
      kind: "total-warn",
      threshold: budgets.totalWarn,
      actual: totalCost,
    });
  }

  let status: BudgetStatus;
  if (failures.length > 0) status = "fail";
  else if (warnings.length > 0) status = "warn";
  else status = "pass";

  return { status, warnings, failures, hasBudgets };
}
