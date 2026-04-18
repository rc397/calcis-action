/**
 * Calcis API client and base-branch file fetching.
 *
 * estimateFile() calls the public estimation endpoint. Auth failures are
 * surfaced via AuthError so the caller can abort remaining work.
 *
 * fetchBaseContent() retrieves a file at the PR's base ref via the GitHub
 * Contents API. Results are cached per-run so re-referenced paths don't cost
 * extra HTTP round-trips.
 */

import * as core from "@actions/core";
import type { GitHub } from "@actions/github/lib/utils";

// ── Calcis API ───────────────────────────────────────────────────

const CALCIS_API_URL = "https://www.calcis.dev/api/v1/estimate";

export interface CalcisEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  confidence: "high" | "medium" | "low";
  currency: string;
}

export class AuthError extends Error {
  constructor(status: number, _body: string) {
    super(`Authentication failed (HTTP ${status}). Check your Calcis API key.`);
    this.name = "AuthError";
  }
}

export async function estimateFile(
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

// ── Base-branch fetching ─────────────────────────────────────────

type Octokit = InstanceType<typeof GitHub>;

export interface BaseFetchResult {
  /** File content when present on the base branch. */
  content?: string;
  /** True when the GitHub Contents API returned 404 (file is new in PR). */
  missing: boolean;
  /** Present if the fetch failed for a reason other than 404. */
  error?: string;
}

export class BaseContentCache {
  private cache = new Map<string, BaseFetchResult>();

  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private ref: string,
  ) {}

  async fetch(filePath: string): Promise<BaseFetchResult> {
    const key = filePath;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const result = await this.doFetch(filePath);
    this.cache.set(key, result);
    return result;
  }

  private async doFetch(filePath: string): Promise<BaseFetchResult> {
    try {
      const res = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref: this.ref,
      });

      const data = res.data as unknown;

      if (Array.isArray(data)) {
        return { missing: false, error: `${filePath} on ${this.ref} is a directory` };
      }

      if (
        data &&
        typeof data === "object" &&
        "type" in data &&
        (data as { type: string }).type === "file" &&
        "content" in data &&
        typeof (data as { content: string }).content === "string"
      ) {
        const raw = (data as { content: string }).content;
        const encoding = (data as { encoding?: string }).encoding ?? "base64";
        if (encoding !== "base64") {
          return {
            missing: false,
            error: `unexpected encoding "${encoding}" for ${filePath}`,
          };
        }
        // GitHub returns base64 with embedded newlines.
        const content = Buffer.from(raw, "base64").toString("utf-8");
        return { content, missing: false };
      }

      return { missing: false, error: `${filePath} is not a file on ${this.ref}` };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 404) {
        return { missing: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to fetch ${filePath} from base ref "${this.ref}": ${msg}`);
      return { missing: false, error: msg };
    }
  }
}
