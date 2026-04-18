/**
 * Shared shape for a single file's estimation result, spanning the PR and base
 * branch versions.
 *
 *   - `status === "added"`   ⇒ file is new in the PR (base returned 404)
 *   - `status === "deleted"` ⇒ file exists on base but not in the PR
 *   - `status === "modified"` ⇒ file exists on both sides
 *
 * `baseUnknown` is set when the GitHub Contents API fetch failed for a reason
 * other than 404. In that case, `delta` is zero and the PR comment renders
 * "—" for the delta column instead of guessing.
 */

export interface FileEstimate {
  file: string;
  status: "modified" | "added" | "deleted";
  tokens: number;      // PR tokens (0 when deleted)
  cost: number;        // PR cost (0 when deleted)
  baseTokens: number;  // base tokens (0 when added or unknown)
  baseCost: number;    // base cost (0 when added or unknown)
  delta: number;       // cost - baseCost (0 when baseUnknown)
  model: string;
  baseUnknown?: boolean;
  error?: string;
}
