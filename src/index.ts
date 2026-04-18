/**
 * Calcis GitHub Action entry point.
 *
 * Reads .calcis.yml (if present), scans PR changed files against user-supplied
 * glob patterns, estimates LLM costs for each matching file plus its base-
 * branch counterpart, posts (or updates) a summary comment on the PR, and
 * publishes a `calcis/cost` check run used for budget-based merge gating.
 *
 * Safety limits:
 *   - Max 10 files per run (configurable via max-files input)
 *   - Max 100 KB per file (files over this are skipped)
 *   - Auth failure on first file aborts remaining files
 *   - API key is masked in logs via core.setSecret()
 *
 * Resilience: the action never crashes on a non-critical failure. A bad
 * .calcis.yml falls back to inputs; a failed base-branch fetch surfaces as
 * "—" for the delta; a checks-permission error logs a warning and is skipped.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";

import { loadConfig, type CalcisConfig } from "./config";
import { matchesAnyPattern, matchesPattern } from "./glob";
import {
  AuthError,
  BaseContentCache,
  estimateFile,
  type CalcisEstimate,
} from "./api";
import { evaluateBudgets, type FileCost } from "./budgets";
import { buildComment, COMMENT_MARKER } from "./comment";
import { createCostCheck } from "./checks";
import type { FileEstimate } from "./estimates";

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 10;
const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_PATTERNS = "**/*.prompt,**/prompts/**";

// ── Main ─────────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    // ── Inputs ─────────────────────────────────────────────────
    const apiKey = core.getInput("api-key", { required: true });
    core.setSecret(apiKey);

    const modelInput = core.getInput("model") || DEFAULT_MODEL;
    const patternsInput = core.getInput("file-patterns") || DEFAULT_PATTERNS;
    const maxFiles = parseInt(core.getInput("max-files") || String(DEFAULT_MAX_FILES), 10);
    const monthlyCallsInput = parsePositiveInt(core.getInput("monthly-calls"));
    const failOnBudget = getBooleanInputWithDefault("fail-on-budget", true);

    // ── PR context ─────────────────────────────────────────────
    const context = github.context;
    if (!context.payload.pull_request) {
      core.info("Not a pull request event. Skipping.");
      return;
    }

    const prNumber = context.payload.pull_request.number;
    const baseRef = context.payload.pull_request.base?.ref as string | undefined;
    const headSha = context.payload.pull_request.head?.sha as string | undefined;

    const token = process.env.GITHUB_TOKEN || core.getInput("github-token");
    if (!token) {
      core.setFailed("GITHUB_TOKEN is required. Set it via env or github-token input.");
      return;
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = context.repo;
    const workspace = process.env.GITHUB_WORKSPACE || ".";

    // ── Config (.calcis.yml) ───────────────────────────────────
    const config = loadConfig(workspace);
    const effective = resolveEffectiveConfig({
      config,
      modelInput,
      patternsInput,
      monthlyCallsInput,
    });

    core.info(`Model: ${effective.defaultModel}`);
    core.info(`Patterns: ${effective.patterns.join(", ")}`);
    if (effective.monthlyCalls) {
      core.info(`Monthly calls: ${effective.monthlyCalls.toLocaleString()}`);
    }

    // ── Changed files ──────────────────────────────────────────
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    // Determine which files to process. Unlike the v1.0 behaviour, we now keep
    // removed files so we can show a negative cost delta for them.
    interface ChangedFile {
      filename: string;
      status: string;
      previousFilename?: string;
    }

    const changedFiles: ChangedFile[] = files.map((f) => ({
      filename: f.filename,
      status: f.status,
      previousFilename: f.previous_filename,
    }));

    core.info(`PR #${prNumber}: ${changedFiles.length} changed files`);

    const matchingFiles = changedFiles.filter((f) => {
      if (matchesAnyPattern(f.filename, effective.patterns)) return true;
      // Renames: also match if the previous path matches (so we catch moves
      // out of a prompt directory).
      if (f.previousFilename && matchesAnyPattern(f.previousFilename, effective.patterns)) {
        return true;
      }
      return false;
    });
    core.info(`${matchingFiles.length} files match`);

    if (matchingFiles.length === 0) {
      core.info("No prompt files changed. Skipping.");
      // Still emit zero-valued outputs so downstream steps can read them.
      setOutputs({ totalCost: 0, totalDelta: 0, scanned: 0, skipped: 0, budgetStatus: "pass", monthlyProjection: 0 });
      return;
    }

    // ── Apply limits ───────────────────────────────────────────
    let skippedCount = 0;
    const skippedReasons: string[] = [];

    let filesToProcess = matchingFiles;
    if (filesToProcess.length > maxFiles) {
      skippedCount += filesToProcess.length - maxFiles;
      skippedReasons.push(`max ${maxFiles} files per run`);
      core.warning(
        `${filesToProcess.length} files matched but only the first ${maxFiles} will be estimated. ` +
          `Increase max-files input to raise the limit.`,
      );
      filesToProcess = filesToProcess.slice(0, maxFiles);
    }

    // ── Estimate each file (PR + base) ─────────────────────────
    const baseCache = baseRef
      ? new BaseContentCache(octokit, owner, repo, baseRef)
      : undefined;

    const estimates: FileEstimate[] = [];
    let authFailed = false;

    for (const f of filesToProcess) {
      if (authFailed) {
        skippedCount++;
        skippedReasons.push("auth failure");
        continue;
      }

      const model = resolveModelForFile(f.filename, effective, config);

      try {
        const est = await estimateOne({
          file: f,
          workspace,
          model,
          apiKey,
          baseCache,
        });
        if (est.skipped) {
          skippedCount++;
          skippedReasons.push(est.skipReason!);
          continue;
        }
        estimates.push(est.estimate!);
      } catch (err) {
        if (err instanceof AuthError) {
          core.setFailed(err.message);
          authFailed = true;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`Failed to estimate ${f.filename}: ${msg}`);
        estimates.push({
          file: f.filename,
          status: normaliseStatus(f.status),
          tokens: 0,
          cost: 0,
          baseTokens: 0,
          baseCost: 0,
          delta: 0,
          model,
          baseUnknown: true,
          error: msg,
        });
      }
    }

    if (authFailed && estimates.length === 0) {
      return;
    }

    // ── Totals ─────────────────────────────────────────────────
    const successful = estimates.filter((e) => !e.error);
    const totalCost = successful.reduce((sum, e) => sum + e.cost, 0);
    const totalTokens = successful.reduce((sum, e) => sum + e.tokens, 0);

    const deltaIncomplete = successful.some((e) => e.baseUnknown);
    const totalDelta = successful
      .filter((e) => !e.baseUnknown)
      .reduce((sum, e) => sum + e.delta, 0);

    // ── Budgets ────────────────────────────────────────────────
    const fileCostsForBudget: FileCost[] = successful.map((e) => ({
      file: e.file,
      cost: e.cost,
    }));
    const budget = evaluateBudgets(effective.budgets, fileCostsForBudget, totalCost);

    // ── Build + post PR comment ────────────────────────────────
    const commentBody = buildComment({
      estimates,
      defaultModel: effective.defaultModel,
      skippedCount,
      skippedReasons,
      totalCost,
      totalTokens,
      totalDelta,
      deltaIncomplete,
      monthlyCalls: effective.monthlyCalls,
      budget,
      failOnBudget,
    });

    await postOrUpdateComment(octokit, owner, repo, prNumber, commentBody);

    // ── Create check run ───────────────────────────────────────
    if (headSha) {
      await createCostCheck({
        octokit,
        owner,
        repo,
        headSha,
        totalCost,
        totalDelta,
        budget,
        estimates,
        failOnBudget,
      });
    } else {
      core.warning("Could not determine PR head SHA; skipping check run.");
    }

    // ── Outputs ────────────────────────────────────────────────
    const monthlyProjection = effective.monthlyCalls ? totalCost * effective.monthlyCalls : 0;
    setOutputs({
      totalCost,
      totalDelta,
      scanned: estimates.length,
      skipped: skippedCount,
      budgetStatus: budget.status,
      monthlyProjection,
    });

    // Fail the action if budgets were exceeded and enforcement is enabled, so
    // `continue-on-error: false` workflows visibly fail. The check run above
    // is the primary merge-blocking signal; this mirrors it at the job level.
    if (budget.status === "fail" && failOnBudget) {
      core.setFailed(
        `Budget exceeded: total cost $${totalCost.toFixed(4)} — see the PR comment for details.`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.setFailed(msg);
  }
}

// ── Effective config ─────────────────────────────────────────────

interface EffectiveConfig {
  defaultModel: string;
  patterns: string[];
  monthlyCalls?: number;
  budgets: NonNullable<CalcisConfig>["budgets"];
}

function resolveEffectiveConfig(args: {
  config: CalcisConfig | null;
  modelInput: string;
  patternsInput: string;
  monthlyCallsInput?: number;
}): EffectiveConfig {
  const { config, modelInput, patternsInput, monthlyCallsInput } = args;

  const defaultModel = config?.model || modelInput || DEFAULT_MODEL;

  const patterns = (
    config?.filePatterns && config.filePatterns.length > 0
      ? config.filePatterns
      : patternsInput.split(",").map((p) => p.trim()).filter(Boolean)
  );

  // Config monthly-calls takes precedence over action input.
  const monthlyCalls = config?.projection?.monthlyCalls ?? monthlyCallsInput;

  const budgets = config?.budgets ?? {};

  return { defaultModel, patterns, monthlyCalls, budgets };
}

function resolveModelForFile(
  filename: string,
  effective: EffectiveConfig,
  config: CalcisConfig | null,
): string {
  if (config?.overrides && config.overrides.length > 0) {
    for (const override of config.overrides) {
      if (matchesPattern(filename, override.path)) {
        return override.model;
      }
    }
  }
  return effective.defaultModel;
}

// ── Single-file estimation ───────────────────────────────────────

interface EstimateOneArgs {
  file: { filename: string; status: string; previousFilename?: string };
  workspace: string;
  model: string;
  apiKey: string;
  baseCache?: BaseContentCache;
}

interface EstimateOneResult {
  estimate?: FileEstimate;
  skipped?: boolean;
  skipReason?: string;
}

async function estimateOne(args: EstimateOneArgs): Promise<EstimateOneResult> {
  const { file, workspace, model, apiKey, baseCache } = args;
  const status = normaliseStatus(file.status);

  // Fetch and estimate base version.
  let baseCost = 0;
  let baseTokens = 0;
  let baseUnknown = false;

  if (status === "added") {
    // Nothing to fetch — file is new.
  } else if (baseCache) {
    const baseFetchPath = file.previousFilename || file.filename;
    const baseResult = await baseCache.fetch(baseFetchPath);
    if (baseResult.error) {
      baseUnknown = true;
    } else if (baseResult.missing) {
      // Treated as added from a base perspective even if the status said otherwise.
      // Rare — can happen if the base ref has diverged after rebasing.
    } else if (baseResult.content && baseResult.content.trim()) {
      try {
        const est = await estimateFile(baseResult.content, model, apiKey);
        baseCost = est.totalCost;
        baseTokens = est.inputTokens;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`Failed to estimate base version of ${baseFetchPath}: ${msg}`);
        baseUnknown = true;
      }
    }
  } else {
    baseUnknown = true;
  }

  // For deleted files we stop here — no PR version to estimate.
  if (status === "deleted") {
    return {
      estimate: {
        file: file.filename,
        status: "deleted",
        tokens: 0,
        cost: 0,
        baseTokens,
        baseCost,
        delta: baseUnknown ? 0 : -baseCost,
        model,
        baseUnknown,
      },
    };
  }

  // Read PR version from workspace.
  const filePath = path.join(workspace, file.filename);
  if (!fs.existsSync(filePath)) {
    core.warning(`File not found in workspace: ${file.filename}`);
    return {
      estimate: {
        file: file.filename,
        status,
        tokens: 0,
        cost: 0,
        baseTokens,
        baseCost,
        delta: 0,
        model,
        baseUnknown: true,
        error: "File not found in workspace",
      },
    };
  }

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    core.warning(
      `Skipping ${file.filename}: ${(stat.size / 1024).toFixed(0)} KB exceeds the 100 KB limit`,
    );
    return { skipped: true, skipReason: "over 100 KB" };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  if (!content.trim()) {
    core.info(`Skipping empty file: ${file.filename}`);
    return { skipped: true, skipReason: "empty file" };
  }

  core.info(`Estimating: ${file.filename} (${(stat.size / 1024).toFixed(1)} KB)`);
  const prEst: CalcisEstimate = await estimateFile(content, model, apiKey);
  core.info(`  ${prEst.inputTokens.toLocaleString()} tokens, $${prEst.totalCost.toFixed(4)}`);

  const delta = baseUnknown ? 0 : prEst.totalCost - baseCost;
  return {
    estimate: {
      file: file.filename,
      status,
      tokens: prEst.inputTokens,
      cost: prEst.totalCost,
      baseTokens,
      baseCost,
      delta,
      model: prEst.model,
      baseUnknown,
    },
  };
}

function normaliseStatus(raw: string): "modified" | "added" | "deleted" {
  if (raw === "added") return "added";
  if (raw === "removed") return "deleted";
  // "modified", "renamed", "copied", "changed", "unchanged" — all treated as
  // modifications for display purposes.
  return "modified";
}

// ── Comment post/update ──────────────────────────────────────────

async function postOrUpdateComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      core.info(`Updated comment #${existing.id}`);
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      core.info("Posted comment on PR");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to post PR comment: ${msg}`);
  }
}

// ── Output helpers ───────────────────────────────────────────────

interface OutputsArgs {
  totalCost: number;
  totalDelta: number;
  scanned: number;
  skipped: number;
  budgetStatus: "pass" | "warn" | "fail";
  monthlyProjection: number;
}

function setOutputs(o: OutputsArgs): void {
  core.setOutput("total-cost", o.totalCost.toFixed(6));
  core.setOutput("delta-total", o.totalDelta.toFixed(6));
  core.setOutput("files-scanned", o.scanned);
  core.setOutput("files-skipped", o.skipped);
  core.setOutput("budget-status", o.budgetStatus);
  core.setOutput("monthly-projection", o.monthlyProjection.toFixed(4));
}

// ── Input helpers ────────────────────────────────────────────────

function parsePositiveInt(raw: string): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Like core.getBooleanInput but with an explicit default when the input is
 * missing, instead of throwing.
 */
function getBooleanInputWithDefault(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const trueValues = ["true", "True", "TRUE", "yes", "1"];
  const falseValues = ["false", "False", "FALSE", "no", "0"];
  if (trueValues.includes(raw)) return true;
  if (falseValues.includes(raw)) return false;
  core.warning(`Input "${name}" has invalid boolean value "${raw}"; using default (${fallback}).`);
  return fallback;
}

run();
