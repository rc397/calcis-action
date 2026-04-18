/**
 * Builds the markdown body for the Calcis PR comment.
 *
 * The comment shows a per-file breakdown, totals row, optional monthly
 * projection line (when `monthly-calls` is configured), optional budget
 * warning/failure lines, and a footer with timestamp and attribution.
 *
 * A hidden marker comment at the top lets the action find and update the same
 * PR comment on subsequent runs instead of appending new ones.
 */

import type { FileEstimate } from "./estimates";
import type { BudgetReport } from "./budgets";

export const COMMENT_MARKER = "<!-- calcis-cost-estimate -->";

export interface CommentContext {
  estimates: FileEstimate[];
  defaultModel: string;
  skippedCount: number;
  skippedReasons: string[];
  /** Total current-PR cost (sum of successful per-file costs). */
  totalCost: number;
  /** Total PR tokens (current branch). */
  totalTokens: number;
  /** Total cost delta (sum of per-file deltas, excluding files with unknown base). */
  totalDelta: number;
  /** True when any file has no reliable base cost — surfaces in the total delta. */
  deltaIncomplete: boolean;
  /** Monthly call volume, from config or action input. Omitted when missing. */
  monthlyCalls?: number;
  /** Budget evaluation result. Empty-budgets report is fine — no lines get rendered. */
  budget?: BudgetReport;
  /** When false, fail-level budget violations render as warnings, not failures. */
  failOnBudget: boolean;
}

export function buildComment(ctx: CommentContext): string {
  const lines: string[] = [];
  lines.push(COMMENT_MARKER);
  lines.push(`💸 **Calcis LLM Cost Estimate**`);
  lines.push("");

  const hasRows = ctx.estimates.length > 0;

  if (!hasRows && ctx.skippedCount === 0) {
    lines.push(`No prompt files changed in this PR.`);
    lines.push("");
    lines.push(footer());
    return lines.join("\n");
  }

  if (hasRows) {
    lines.push(`| File | Status | Tokens | Est. Cost | Δ Cost | Model |`);
    lines.push(`|------|--------|--------|-----------|--------|-------|`);

    for (const est of ctx.estimates) {
      lines.push(renderRow(est));
    }

    lines.push(renderTotalRow(ctx));
    lines.push("");
  }

  // Monthly projection.
  if (ctx.monthlyCalls && ctx.monthlyCalls > 0 && hasRows) {
    lines.push(renderProjection(ctx.monthlyCalls, ctx.totalCost, ctx.totalDelta));
    lines.push("");
  }

  // Budget lines.
  if (ctx.budget && (ctx.budget.warnings.length > 0 || ctx.budget.failures.length > 0)) {
    for (const v of ctx.budget.warnings) {
      lines.push(renderBudgetLine(v, "warn"));
    }
    for (const v of ctx.budget.failures) {
      lines.push(renderBudgetLine(v, ctx.failOnBudget ? "fail" : "warn"));
    }
    lines.push("");
  }

  // Skipped-file note.
  if (ctx.skippedCount > 0) {
    const reasons = [...new Set(ctx.skippedReasons)];
    let note = `> ${ctx.skippedCount} file${ctx.skippedCount > 1 ? "s" : ""} skipped`;
    if (reasons.length > 0) note += ` (${reasons.join(", ")})`;
    note += `.`;
    lines.push(note);
    lines.push("");
  }

  // Error summary.
  const errored = ctx.estimates.filter((e) => e.error);
  if (errored.length > 0) {
    lines.push(
      `> ${errored.length} file${errored.length > 1 ? "s" : ""} failed to estimate. ` +
        `Check the [action logs](${actionRunUrl()}) for details.`,
    );
    lines.push("");
  }

  lines.push(footer());
  return lines.join("\n");
}

// ── Row rendering ────────────────────────────────────────────────

function renderRow(est: FileEstimate): string {
  const name = truncateFilename(est.file, 60);
  const statusLabel = statusToLabel(est.status);
  const model = est.model;

  if (est.error) {
    return `| \`${name}\` | ${statusLabel} | — | Error | — | ${model} |`;
  }

  if (est.status === "deleted") {
    // PR version is gone — tokens and cost columns show em-dash per spec.
    const delta = formatDelta(est.delta);
    return `| \`${name}\` | ${statusLabel} | — | — | ${delta} (removed) | ${model} |`;
  }

  const tokens = est.tokens.toLocaleString();
  const cost = formatCost(est.cost);
  const deltaCol = formatDeltaColumn(est);
  return `| \`${name}\` | ${statusLabel} | ${tokens} | ${cost} | ${deltaCol} | ${model} |`;
}

function renderTotalRow(ctx: CommentContext): string {
  const tokens = ctx.totalTokens.toLocaleString();
  const cost = formatCost(ctx.totalCost);
  const delta = ctx.deltaIncomplete
    ? `**${formatDelta(ctx.totalDelta)}\\***`
    : `**${formatDelta(ctx.totalDelta)}**`;
  return `| **Total** | | **${tokens}** | **${cost}** | ${delta} | |`;
}

function formatDeltaColumn(est: FileEstimate): string {
  if (est.baseUnknown) return `—`;
  if (est.status === "added") {
    return `${formatDelta(est.delta)} (new)`;
  }
  if (est.baseCost === 0 && est.cost > 0) {
    return `${formatDelta(est.delta)} (new)`;
  }
  if (est.baseCost === 0 && est.cost === 0) {
    return `$0.0000`;
  }
  const pct = ((est.cost - est.baseCost) / est.baseCost) * 100;
  return `${formatDelta(est.delta)} (${formatPercent(pct)})`;
}

function statusToLabel(
  s: "modified" | "added" | "deleted",
): "Modified" | "New" | "Deleted" {
  if (s === "added") return "New";
  if (s === "deleted") return "Deleted";
  return "Modified";
}

// ── Projection / budgets ─────────────────────────────────────────

function renderProjection(calls: number, totalCost: number, totalDelta: number): string {
  const monthly = totalCost * calls;
  const monthlyDelta = totalDelta * calls;
  const callsLabel = calls.toLocaleString();
  const deltaLabel = formatProjectionDelta(monthlyDelta);
  return `📊 **Monthly projection at ${callsLabel} calls/mo: ${formatProjection(monthly)} (Δ ${deltaLabel}/mo)**`;
}

function renderBudgetLine(
  v: { kind: string; threshold: number; actual: number; file?: string },
  severity: "warn" | "fail",
): string {
  const icon = severity === "fail" ? "❌" : "⚠️";
  const thresholdLabel = v.kind.endsWith("-warn") ? "warn threshold" : "fail threshold";

  if (v.kind.startsWith("per-file")) {
    const file = v.file ?? "?";
    return (
      `${icon} Per-file cost for \`${file}\` (${formatCost(v.actual)}) ` +
      `exceeds ${thresholdLabel} (${formatCost(v.threshold)})` +
      (severity === "fail" ? ` — check will fail` : ``)
    );
  }

  return (
    `${icon} Total PR cost (${formatCost(v.actual)}) ` +
    `exceeds ${thresholdLabel} (${formatCost(v.threshold)})` +
    (severity === "fail" ? ` — check will fail` : ``)
  );
}

// ── Formatting helpers ───────────────────────────────────────────

export function formatCost(c: number): string {
  return `$${c.toFixed(4)}`;
}

export function formatDelta(d: number): string {
  const sign = d >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(d).toFixed(4)}`;
}

function formatPercent(p: number): string {
  const sign = p >= 0 ? "+" : "-";
  return `${sign}${Math.abs(p).toFixed(0)}%`;
}

export function formatProjection(c: number): string {
  const abs = Math.abs(c);
  if (abs >= 100) return `$${Math.round(c).toLocaleString()}`;
  if (abs >= 1) return `$${c.toFixed(2)}`;
  return `$${c.toFixed(4)}`;
}

export function formatProjectionDelta(d: number): string {
  const sign = d >= 0 ? "+" : "-";
  const abs = Math.abs(d);
  if (abs >= 100) return `${sign}$${Math.round(abs).toLocaleString()}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

function truncateFilename(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const parts = name.split("/");
  const last = parts[parts.length - 1];
  if (last.length >= maxLen - 4) return "..." + last.slice(-(maxLen - 3));
  return "..." + name.slice(-(maxLen - 3));
}

function footer(): string {
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return `*Last updated: ${now} | Powered by [Calcis](https://calcis.dev)*`;
}

function actionRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  if (!repo || !runId) return "";
  return `${server}/${repo}/actions/runs/${runId}`;
}
