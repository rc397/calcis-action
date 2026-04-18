/**
 * Creates the `calcis/cost` check run that gates PR merge when a team has
 * wired up a required check in branch protection.
 *
 * The conclusion is driven by budget evaluation:
 *   - no budgets, no violations ⇒ success (informational)
 *   - warn-only violations       ⇒ success with annotations
 *   - fail violations + fail-on-budget=true  ⇒ failure with annotations
 *   - fail violations + fail-on-budget=false ⇒ success with annotations
 *
 * If the Checks API returns 403 (permissions missing), we log a clear
 * explanation and continue — never crash on a missing permission.
 */

import * as core from "@actions/core";
import type { GitHub } from "@actions/github/lib/utils";

import type { BudgetReport, BudgetViolation } from "./budgets";
import type { FileEstimate } from "./estimates";
import { formatCost, formatDelta } from "./comment";

export const CHECK_RUN_NAME = "calcis/cost";

type Octokit = InstanceType<typeof GitHub>;

type CheckConclusion = "success" | "failure";

interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
}

export interface CreateCheckArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  headSha: string;
  totalCost: number;
  totalDelta: number;
  budget: BudgetReport;
  estimates: FileEstimate[];
  failOnBudget: boolean;
}

export async function createCostCheck(args: CreateCheckArgs): Promise<void> {
  const { octokit, owner, repo, headSha, totalCost, totalDelta, budget, failOnBudget } = args;

  const conclusion = computeConclusion(budget, failOnBudget);
  const title = `Cost estimate: ${formatCost(totalCost)} (Δ ${formatDelta(totalDelta)})`;
  const summary = buildSummary(args);
  const annotations = buildAnnotations(budget, failOnBudget);

  try {
    await octokit.rest.checks.create({
      owner,
      repo,
      name: CHECK_RUN_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title,
        summary,
        annotations: annotations.slice(0, 50), // GitHub caps at 50 per request
      },
    });
    core.info(`Created check run "${CHECK_RUN_NAME}" with conclusion: ${conclusion}`);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const msg = err instanceof Error ? err.message : String(err);

    if (status === 403 || status === 404) {
      core.warning(
        `Could not create the "${CHECK_RUN_NAME}" check run (HTTP ${status}). ` +
          `Grant "checks: write" permission in your workflow to enable budget ` +
          `enforcement via a required status check. The PR comment was still posted.`,
      );
      return;
    }

    core.warning(`Failed to create "${CHECK_RUN_NAME}" check run: ${msg}`);
  }
}

// ── Conclusion ───────────────────────────────────────────────────

function computeConclusion(budget: BudgetReport, failOnBudget: boolean): CheckConclusion {
  if (!failOnBudget) return "success";
  if (budget.failures.length > 0) return "failure";
  return "success";
}

// ── Summary markdown ─────────────────────────────────────────────

function buildSummary(args: CreateCheckArgs): string {
  const { totalCost, totalDelta, budget, estimates, failOnBudget } = args;

  const lines: string[] = [];

  lines.push(`**Total cost:** ${formatCost(totalCost)} (Δ ${formatDelta(totalDelta)})`);
  lines.push("");

  if (!budget.hasBudgets) {
    lines.push(`No budgets configured. Add a \`.calcis.yml\` with a \`budgets\` section to gate this check.`);
  } else if (budget.failures.length === 0 && budget.warnings.length === 0) {
    lines.push(`✅ All budgets passed.`);
  } else {
    if (budget.failures.length > 0) {
      lines.push(failOnBudget ? `### ❌ Budget failures` : `### ❌ Budget failures (not blocking — \`fail-on-budget: false\`)`);
      for (const v of budget.failures) {
        lines.push(`- ${describeViolation(v)}`);
      }
      lines.push("");
    }
    if (budget.warnings.length > 0) {
      lines.push(`### ⚠️ Budget warnings`);
      for (const v of budget.warnings) {
        lines.push(`- ${describeViolation(v)}`);
      }
      lines.push("");
    }
  }

  const succeeded = estimates.filter((e) => !e.error).length;
  const errored = estimates.length - succeeded;
  lines.push(`_${succeeded} file${succeeded === 1 ? "" : "s"} estimated${errored > 0 ? `, ${errored} error${errored === 1 ? "" : "s"}` : ""}._`);

  return lines.join("\n");
}

function describeViolation(v: BudgetViolation): string {
  const over = v.actual - v.threshold;
  const overLabel = `(+${formatCost(over)} over)`;
  if (v.kind === "per-file-fail" || v.kind === "per-file-warn") {
    const tier = v.kind === "per-file-fail" ? "fail" : "warn";
    return `\`${v.file ?? "?"}\`: ${formatCost(v.actual)} exceeds per-file ${tier} threshold ${formatCost(v.threshold)} ${overLabel}`;
  }
  const tier = v.kind === "total-fail" ? "fail" : "warn";
  return `Total: ${formatCost(v.actual)} exceeds total ${tier} threshold ${formatCost(v.threshold)} ${overLabel}`;
}

// ── Annotations ──────────────────────────────────────────────────

function buildAnnotations(budget: BudgetReport, failOnBudget: boolean): CheckAnnotation[] {
  const annotations: CheckAnnotation[] = [];

  for (const v of budget.warnings) {
    if (v.file) annotations.push(perFileAnnotation(v, "warning"));
  }
  for (const v of budget.failures) {
    if (v.file) {
      annotations.push(perFileAnnotation(v, failOnBudget ? "failure" : "warning"));
    }
  }

  return annotations;
}

function perFileAnnotation(
  v: BudgetViolation,
  level: "warning" | "failure",
): CheckAnnotation {
  const tier = v.kind === "per-file-fail" ? "fail" : "warn";
  return {
    path: v.file!,
    start_line: 1,
    end_line: 1,
    annotation_level: level,
    title: `Calcis ${tier} budget exceeded`,
    message:
      `Estimated cost ${formatCost(v.actual)} exceeds the per-file ${tier} ` +
      `threshold ${formatCost(v.threshold)}.`,
  };
}
