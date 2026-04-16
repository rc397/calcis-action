/**
 * Calcis GitHub Action entry point.
 *
 * Scans PR changed files against user-supplied glob patterns,
 * estimates LLM costs for each matching file via the Calcis
 * public API, and posts (or updates) a summary comment on the PR.
 *
 * Safety limits:
 *   - Max 10 files per run (configurable via max-files input)
 *   - Max 100 KB per file (files over this are skipped)
 *   - Auth failure on first file aborts remaining files
 *   - API key is masked in logs via core.setSecret()
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";

// ── Constants ───────────────────────────────────────────────────

const CALCIS_API_URL = "https://www.calcis.dev/api/v1/estimate";
const COMMENT_MARKER = "<!-- calcis-cost-estimate -->";
const DEFAULT_MAX_FILES = 10;
const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB

// ── Types ────────────────────────────────────────────────────────

interface CalcisEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  confidence: "high" | "medium" | "low";
  currency: string;
}

interface FileEstimate {
  file: string;
  tokens: number;
  cost: number;
  model: string;
  error?: string;
}

// ── Glob matching ────────────────────────────────────────────────

/**
 * Minimal glob matcher supporting double-star and single-star wildcards.
 * Good enough for patterns like "dir/file.prompt" and "src/prompts/chat.txt".
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  const regexStr = normalizedPattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(normalized);
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(filePath, p));
}

// ── Calcis API ───────────────────────────────────────────────────

class AuthError extends Error {
  constructor(status: number, body: string) {
    super(`Authentication failed (HTTP ${status}). Check your Calcis API key.`);
    this.name = "AuthError";
  }
}

async function estimateFile(
  text: string,
  modelId: string,
  apiKey: string,
): Promise<CalcisEstimate> {
  const res = await fetch(CALCIS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ text, modelId }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(res.status, body);
    }
    throw new Error(`Calcis API returned ${res.status}: ${body}`);
  }

  return (await res.json()) as CalcisEstimate;
}

// ── Comment building ─────────────────────────────────────────────

function buildComment(
  estimates: FileEstimate[],
  model: string,
  skippedCount: number,
  skippedReasons: string[],
): string {
  const successful = estimates.filter((e) => !e.error);
  const totalCost = successful.reduce((sum, e) => sum + e.cost, 0);
  const totalTokens = successful.reduce((sum, e) => sum + e.tokens, 0);

  let md = `${COMMENT_MARKER}\n`;
  md += `## Calcis LLM Cost Estimate\n\n`;

  if (estimates.length === 0 && skippedCount === 0) {
    md += `No prompt files changed in this PR.\n\n`;
    md += `*Powered by [Calcis](https://calcis.dev)*\n`;
    return md;
  }

  if (estimates.length > 0) {
    md += `| File | Tokens | Est. Cost | Model |\n`;
    md += `|------|--------|-----------|-------|\n`;

    for (const est of estimates) {
      const name = truncateFilename(est.file, 60);
      if (est.error) {
        md += `| \`${name}\` | - | Error | - |\n`;
      } else {
        md += `| \`${name}\` | ${est.tokens.toLocaleString()} | $${est.cost.toFixed(4)} | ${est.model} |\n`;
      }
    }

    if (successful.length > 1) {
      md += `| **Total** | **${totalTokens.toLocaleString()}** | **$${totalCost.toFixed(4)}** | ${model} |\n`;
    }

    md += `\n`;
  }

  // Note about skipped files
  if (skippedCount > 0) {
    const reasons = [...new Set(skippedReasons)];
    md += `> ${skippedCount} file${skippedCount > 1 ? "s" : ""} skipped`;
    if (reasons.length > 0) {
      md += ` (${reasons.join(", ")})`;
    }
    md += `.\n\n`;
  }

  // Errors summary
  const errored = estimates.filter((e) => e.error);
  if (errored.length > 0) {
    md += `> ${errored.length} file${errored.length > 1 ? "s" : ""} failed to estimate. Check the [action logs](${actionRunUrl()}) for details.\n\n`;
  }

  // Timestamp + attribution
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  md += `*Last updated: ${now} | Powered by [Calcis](https://calcis.dev)*\n`;
  return md;
}

/**
 * Truncate a filename for display in the table. Keeps the last
 * segment visible so the user can identify the file.
 */
function truncateFilename(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const parts = name.split("/");
  const last = parts[parts.length - 1];
  if (last.length >= maxLen - 4) return "..." + last.slice(-(maxLen - 3));
  return "..." + name.slice(-(maxLen - 3));
}

/**
 * Build a URL to the current action run. Falls back to empty string
 * if the required env vars are not set.
 */
function actionRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  if (!repo || !runId) return "";
  return `${server}/${repo}/actions/runs/${runId}`;
}

// ── Main ─────────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    // ── Inputs ─────────────────────────────────────────────────
    const apiKey = core.getInput("api-key", { required: true });
    core.setSecret(apiKey); // mask the key in all log output

    const model = core.getInput("model") || "claude-sonnet-4-6";
    const patternsRaw = core.getInput("file-patterns") || "**/*.prompt,**/prompts/**";
    const patterns = patternsRaw.split(",").map((p) => p.trim()).filter(Boolean);
    const maxFiles = parseInt(core.getInput("max-files") || String(DEFAULT_MAX_FILES), 10);

    // ── PR context ─────────────────────────────────────────────
    const context = github.context;
    if (!context.payload.pull_request) {
      core.info("Not a pull request event. Skipping.");
      return;
    }

    const prNumber = context.payload.pull_request.number;
    const token = process.env.GITHUB_TOKEN || core.getInput("github-token");
    if (!token) {
      core.setFailed("GITHUB_TOKEN is required. Set it via env or github-token input.");
      return;
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = context.repo;

    // ── Changed files ──────────────────────────────────────────
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const changedFiles = files
      .filter((f) => f.status !== "removed")
      .map((f) => f.filename);

    core.info(`PR #${prNumber}: ${changedFiles.length} changed files`);
    core.info(`Patterns: ${patterns.join(", ")}`);

    const matchingFiles = changedFiles.filter((f) => matchesAnyPattern(f, patterns));
    core.info(`${matchingFiles.length} files match`);

    if (matchingFiles.length === 0) {
      core.info("No prompt files changed. Skipping.");
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

    // ── Estimate each file ─────────────────────────────────────
    const estimates: FileEstimate[] = [];
    let authFailed = false;

    for (const file of filesToProcess) {
      if (authFailed) {
        skippedCount++;
        skippedReasons.push("auth failure");
        continue;
      }

      const filePath = path.join(process.env.GITHUB_WORKSPACE || ".", file);

      // File exists?
      if (!fs.existsSync(filePath)) {
        core.warning(`File not found in workspace: ${file}`);
        estimates.push({ file, tokens: 0, cost: 0, model, error: "File not found" });
        continue;
      }

      // File size check
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        core.warning(
          `Skipping ${file}: ${(stat.size / 1024).toFixed(0)} KB exceeds the 100 KB limit`,
        );
        skippedCount++;
        skippedReasons.push("over 100 KB");
        continue;
      }

      // Read content
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.trim()) {
        core.info(`Skipping empty file: ${file}`);
        skippedCount++;
        skippedReasons.push("empty file");
        continue;
      }

      // Call API
      core.info(`Estimating: ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
      try {
        const result = await estimateFile(content, model, apiKey);
        estimates.push({
          file,
          tokens: result.inputTokens,
          cost: result.totalCost,
          model: result.model,
        });
        core.info(
          `  ${result.inputTokens.toLocaleString()} tokens, $${result.totalCost.toFixed(4)}`,
        );
      } catch (err) {
        if (err instanceof AuthError) {
          core.setFailed(err.message);
          authFailed = true;
          // Still post what we have so far (nothing), but stop calling the API
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`Failed to estimate ${file}: ${msg}`);
        estimates.push({ file, tokens: 0, cost: 0, model, error: msg });
      }
    }

    // If auth failed on the very first file, bail entirely
    if (authFailed && estimates.length === 0) {
      return;
    }

    // ── Post comment ───────────────────────────────────────────
    const commentBody = buildComment(estimates, model, skippedCount, skippedReasons);

    try {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });

      const existingComment = comments.find(
        (c) => c.body?.includes(COMMENT_MARKER),
      );

      if (existingComment) {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: commentBody,
        });
        core.info(`Updated comment #${existingComment.id}`);
      } else {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: commentBody,
        });
        core.info("Posted comment on PR");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.setFailed(`Failed to post PR comment: ${msg}`);
      return;
    }

    // ── Outputs ────────────────────────────────────────────────
    const totalCost = estimates
      .filter((e) => !e.error)
      .reduce((sum, e) => sum + e.cost, 0);
    core.setOutput("total-cost", totalCost.toFixed(6));
    core.setOutput("files-scanned", estimates.length);
    core.setOutput("files-skipped", skippedCount);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.setFailed(msg);
  }
}

run();
