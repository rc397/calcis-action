/**
 * Parses and validates .calcis.yml configuration files.
 *
 * If the file is missing, returns null — the caller falls back to action inputs
 * and current behaviour is preserved. If the file exists but is malformed, the
 * error is logged and null is returned: config parsing never crashes the action.
 */

import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ── Types ────────────────────────────────────────────────────────

export interface CalcisBudgets {
  perFileWarn?: number;
  perFileFail?: number;
  totalWarn?: number;
  totalFail?: number;
}

export interface CalcisProjection {
  monthlyCalls?: number;
}

export interface CalcisOverride {
  path: string;
  model: string;
}

export interface CalcisConfig {
  version: number;
  model?: string;
  filePatterns?: string[];
  budgets: CalcisBudgets;
  projection: CalcisProjection;
  overrides: CalcisOverride[];
}

// ── Schema ───────────────────────────────────────────────────────

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "version",
  "model",
  "file-patterns",
  "budgets",
  "projection",
  "overrides",
]);
const KNOWN_BUDGET_KEYS = new Set([
  "per-file-warn",
  "per-file-fail",
  "total-warn",
  "total-fail",
]);
const KNOWN_PROJECTION_KEYS = new Set(["monthly-calls"]);
const KNOWN_OVERRIDE_KEYS = new Set(["path", "model"]);

const CONFIG_FILENAMES = [".calcis.yml", ".calcis.yaml"];

// ── Loader ───────────────────────────────────────────────────────

/**
 * Load the .calcis.yml (or .calcis.yaml) config from the given workspace.
 * Returns null if the file is absent or parsing fails — callers should treat
 * null as "use action inputs".
 */
export function loadConfig(workspace: string): CalcisConfig | null {
  for (const name of CONFIG_FILENAMES) {
    const filePath = path.join(workspace, name);
    if (fs.existsSync(filePath)) {
      core.info(`Loading config from ${name}`);
      return parseConfigFile(filePath);
    }
  }
  return null;
}

function parseConfigFile(filePath: string): CalcisConfig | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.error(`Failed to read ${filePath}: ${msg}. Falling back to action inputs.`);
    return null;
  }

  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.error(`Failed to parse ${filePath}: ${msg}. Falling back to action inputs.`);
    return null;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    core.error(`${filePath}: expected an object at the root. Falling back to action inputs.`);
    return null;
  }

  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    core.error(
      `${filePath}: "version: 1" is required (got ${JSON.stringify(obj.version)}). ` +
        `Falling back to action inputs.`,
    );
    return null;
  }

  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      core.warning(`${filePath}: unknown top-level key "${key}" ignored.`);
    }
  }

  const config: CalcisConfig = {
    version: 1,
    budgets: {},
    projection: {},
    overrides: [],
  };

  if (typeof obj.model === "string" && obj.model.trim()) {
    config.model = obj.model.trim();
  } else if (obj.model !== undefined) {
    core.warning(`${filePath}: "model" must be a non-empty string; ignoring.`);
  }

  if (Array.isArray(obj["file-patterns"])) {
    const patterns = (obj["file-patterns"] as unknown[])
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .map((p) => p.trim());
    if (patterns.length > 0) {
      config.filePatterns = patterns;
    }
  } else if (obj["file-patterns"] !== undefined) {
    core.warning(`${filePath}: "file-patterns" must be an array of strings; ignoring.`);
  }

  if (obj.budgets !== undefined) {
    if (isPlainObject(obj.budgets)) {
      const b = obj.budgets;
      for (const key of Object.keys(b)) {
        if (!KNOWN_BUDGET_KEYS.has(key)) {
          core.warning(`${filePath}: unknown key "budgets.${key}" ignored.`);
        }
      }
      config.budgets = {
        perFileWarn: asPositiveNumber(b["per-file-warn"], `${filePath}: budgets.per-file-warn`),
        perFileFail: asPositiveNumber(b["per-file-fail"], `${filePath}: budgets.per-file-fail`),
        totalWarn: asPositiveNumber(b["total-warn"], `${filePath}: budgets.total-warn`),
        totalFail: asPositiveNumber(b["total-fail"], `${filePath}: budgets.total-fail`),
      };
    } else {
      core.warning(`${filePath}: "budgets" must be an object; ignoring.`);
    }
  }

  if (obj.projection !== undefined) {
    if (isPlainObject(obj.projection)) {
      const p = obj.projection;
      for (const key of Object.keys(p)) {
        if (!KNOWN_PROJECTION_KEYS.has(key)) {
          core.warning(`${filePath}: unknown key "projection.${key}" ignored.`);
        }
      }
      config.projection = {
        monthlyCalls: asPositiveNumber(p["monthly-calls"], `${filePath}: projection.monthly-calls`),
      };
    } else {
      core.warning(`${filePath}: "projection" must be an object; ignoring.`);
    }
  }

  if (obj.overrides !== undefined) {
    if (Array.isArray(obj.overrides)) {
      for (let i = 0; i < obj.overrides.length; i++) {
        const entry = obj.overrides[i];
        if (!isPlainObject(entry)) {
          core.warning(`${filePath}: overrides[${i}] must be an object; ignoring.`);
          continue;
        }
        for (const key of Object.keys(entry)) {
          if (!KNOWN_OVERRIDE_KEYS.has(key)) {
            core.warning(`${filePath}: unknown key "overrides[${i}].${key}" ignored.`);
          }
        }
        const pathGlob = entry.path;
        const modelName = entry.model;
        if (typeof pathGlob === "string" && typeof modelName === "string") {
          config.overrides.push({ path: pathGlob.trim(), model: modelName.trim() });
        } else {
          core.warning(
            `${filePath}: overrides[${i}] requires string "path" and "model" — skipping.`,
          );
        }
      }
    } else {
      core.warning(`${filePath}: "overrides" must be an array; ignoring.`);
    }
  }

  return config;
}

// ── Helpers ──────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asPositiveNumber(v: unknown, label: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  core.warning(`${label}: expected a non-negative number; ignoring.`);
  return undefined;
}
