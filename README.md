# Calcis LLM Cost Estimator

Automatically estimates LLM API costs on pull requests when prompt files change, shows the **cost delta** vs the base branch, and can **gate merges** on budget thresholds via a required `calcis/cost` status check. Like [Infracost](https://www.infracost.io/) for cloud infrastructure, but for AI.

## What it does

- Detects changed prompt files in PRs using configurable glob patterns
- Estimates token counts and costs using the [Calcis](https://calcis.dev) pre-flight estimation engine
- Reports the **cost delta** between the PR and the base branch for every changed prompt
- Enforces **per-file and total cost budgets** defined in `.calcis.yml` via a `calcis/cost` check run
- Projects **monthly cost** from your call volume so the impact of a prompt change is tangible
- Supports **per-path model overrides** so expensive models run on critical prompts and cheap models run on everything else
- Posts a single comment per PR and updates it on each new commit

## Example PR comment

> 💸 **Calcis LLM Cost Estimate**
>
> | File | Status | Tokens | Est. Cost | Δ Cost | Model |
> |------|--------|--------|-----------|--------|-------|
> | `prompts/chat.txt` | Modified | 1,247 | $0.0084 | +$0.0031 (+58%) | claude-sonnet-4-6 |
> | `prompts/summary.txt` | New | 423 | $0.0028 | +$0.0028 (new) | claude-sonnet-4-6 |
> | `prompts/old.txt` | Deleted | — | — | -$0.0015 (removed) | claude-sonnet-4-6 |
> | **Total** | | **1,670** | **$0.0112** | **+$0.0044** | |
>
> 📊 **Monthly projection at 100,000 calls/mo: $1,120 (Δ +$440/mo)**
>
> ⚠️ Per-file cost for `prompts/chat.txt` ($0.0084) exceeds warn threshold ($0.0050)
>
> *Last updated: 2026-04-18 12:34:56 UTC | Powered by [Calcis](https://calcis.dev)*

## Quick start

Works out of the box with zero config. Add to `.github/workflows/calcis.yml`:

```yaml
name: LLM Cost Estimate
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  estimate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rc397/calcis-action@v1
        with:
          api-key: ${{ secrets.CALCIS_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

With no `.calcis.yml` present, the action scans `**/*.prompt` and `**/prompts/**`, uses `claude-sonnet-4-6` as the model, reports cost deltas vs the base branch, and publishes an always-passing `calcis/cost` check. Budget enforcement kicks in only after you commit a `.calcis.yml`.

### Specify a model and custom file patterns

```yaml
- uses: rc397/calcis-action@v1
  with:
    api-key: ${{ secrets.CALCIS_API_KEY }}
    model: gpt-4o
    file-patterns: "**/*.prompt,**/*.txt,src/prompts/**"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Getting an API key

1. Sign up at [calcis.dev](https://calcis.dev)
2. Go to your [Dashboard](https://www.calcis.dev/dashboard)
3. Create an API key in the **API Keys** section
4. Add it as `CALCIS_API_KEY` in your repo's **Settings > Secrets > Actions**

API access requires Pro tier or above.

## Add budget governance

The real value of Calcis shows up when you commit a `.calcis.yml` and make `calcis/cost` a required status check. From that point on, PRs that exceed your fail thresholds cannot be merged.

### 1. Commit a `.calcis.yml`

Copy [`.calcis.yml.example`](./.calcis.yml.example) into your repo root as `.calcis.yml` and tune the values:

```yaml
version: 1

model: claude-sonnet-4-6

file-patterns:
  - "**/*.prompt"
  - "**/prompts/**"

budgets:
  per-file-warn: 0.05
  per-file-fail: 0.50
  total-warn: 0.25
  total-fail: 2.00

projection:
  monthly-calls: 100000

overrides:
  - path: "prompts/customer-facing/**"
    model: claude-opus-4-6
  - path: "prompts/internal/**"
    model: gpt-4o-mini
```

### 2. Adopt gradually with `fail-on-budget: false`

For a few weeks, run with `fail-on-budget: false` so violations surface as warnings without blocking merges. Tune your thresholds based on real PR data.

```yaml
- uses: rc397/calcis-action@v1
  with:
    api-key: ${{ secrets.CALCIS_API_KEY }}
    fail-on-budget: false
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 3. Flip to enforcement and make it required

Once your thresholds are stable, drop the `fail-on-budget` input (defaults to `true`), then wire up branch protection:

1. Go to **Settings → Branches → Branch protection rules** and edit (or create) the rule for your default branch.
2. Enable **Require status checks to pass before merging**.
3. Search for **`calcis/cost`** and select it.
4. Save.

PRs that blow past a fail threshold now show a failed `calcis/cost` check and can no longer be merged.

## Cost delta reporting

Every changed prompt is compared against its version on the PR's base branch (`GITHUB_TOKEN` is used to fetch the base content). The PR comment shows the absolute cost, the delta in dollars, and the percentage change.

Three cases are handled:

- **Modified**: both versions exist. Delta is `PR cost − base cost`, shown as `+$0.0031 (+58%)` or `-$0.0012 (-15%)`.
- **New**: file didn't exist on the base branch. Delta is the full PR cost, shown as `+$0.0028 (new)`.
- **Deleted**: file existed on the base branch but is removed in the PR. Delta is negative, shown as `-$0.0015 (removed)`. The Tokens and Est. Cost columns show `—`.

If the base-branch fetch fails (network error, missing permissions, etc.), the delta column renders `—` and the action continues — never crashes on a partial failure.

## Per-path model overrides

Use different models for different prompt directories. First match wins, so order your overrides from most specific to most general:

```yaml
overrides:
  - path: "prompts/customer-facing/**"
    model: claude-opus-4-6
  - path: "prompts/internal-tools/**"
    model: gpt-4o-mini
  - path: "prompts/experiments/**"
    model: claude-haiku-4-5
```

Files that don't match any override fall back to the top-level `model` in `.calcis.yml` (or the `model` action input if the config is absent).

## Monthly projections

Set `projection.monthly-calls` in `.calcis.yml` (or the `monthly-calls` action input) to project costs at your real traffic level:

```yaml
projection:
  monthly-calls: 100000
```

The PR comment then includes a line like:

> 📊 **Monthly projection at 100,000 calls/mo: $1,120 (Δ +$440/mo)**

where the number is `total PR cost × monthly-calls` and the delta is `total PR delta × monthly-calls`. A change that looks cheap per request suddenly becomes obvious at scale.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | — | Your Calcis API key (starts with `calc_`) |
| `model` | No | `claude-sonnet-4-6` | Default LLM model. Overridden by `model` in `.calcis.yml`. |
| `file-patterns` | No | `**/*.prompt,**/prompts/**` | Comma-separated glob patterns. Overridden by `file-patterns` in `.calcis.yml`. |
| `max-files` | No | `10` | Maximum files to estimate per run |
| `monthly-calls` | No | — | Monthly call volume. Enables the projection line. Overridden by `projection.monthly-calls` in `.calcis.yml`. |
| `fail-on-budget` | No | `true` | When `false`, budget violations become warnings instead of failing the `calcis/cost` check |

The `GITHUB_TOKEN` environment variable is required for posting PR comments, fetching base-branch file contents, and creating the `calcis/cost` check run. Use `${{ secrets.GITHUB_TOKEN }}` (automatically provided by GitHub Actions).

## Outputs

| Output | Description |
|--------|-------------|
| `total-cost` | Total estimated cost in USD for this PR |
| `delta-total` | Total cost delta in USD (PR total minus base total) |
| `files-scanned` | Number of prompt files scanned |
| `files-skipped` | Number of files skipped |
| `budget-status` | `pass`, `warn`, or `fail` — use this to branch downstream steps |
| `monthly-projection` | Projected monthly cost in USD (0 when `monthly-calls` is not set) |

## Required permissions

```yaml
permissions:
  contents: read         # read the PR files from the workspace
  pull-requests: write   # post and update the PR comment
  checks: write          # publish the calcis/cost check run
```

The action degrades gracefully: if `checks: write` is missing, the check run is skipped with a warning and everything else still works.

## `.calcis.yml` reference

The config file is optional. When present at the repo root, it overrides the matching action inputs.

| Field | Type | Default | Behaviour |
|-------|------|---------|-----------|
| `version` | integer | — | Required. Must be `1`. |
| `model` | string | from `model` input | Default model used for estimation. |
| `file-patterns` | array of strings | from `file-patterns` input | Glob patterns that select prompt files. |
| `budgets.per-file-warn` | number (USD) | — | Warn when any single file exceeds this cost. |
| `budgets.per-file-fail` | number (USD) | — | Fail the `calcis/cost` check when any single file exceeds this cost. |
| `budgets.total-warn` | number (USD) | — | Warn when the total PR cost exceeds this value. |
| `budgets.total-fail` | number (USD) | — | Fail the check when the total PR cost exceeds this value. |
| `projection.monthly-calls` | integer | from `monthly-calls` input | Enables the monthly projection line in the PR comment. |
| `overrides[].path` | string | — | Glob for files that should use an alternate model. |
| `overrides[].model` | string | — | Model to use when `overrides[].path` matches. |

Unknown keys produce a warning in the action logs but never cause a failure — this lets future versions of Calcis add new fields without breaking existing configs. A malformed `.calcis.yml` logs an error and the action falls back to its action-input defaults rather than crashing.

See [`.calcis.yml.example`](./.calcis.yml.example) for a commented starting point.

## File pattern examples

```yaml
# Default: .prompt files and anything under prompts/ directories
file-patterns: "**/*.prompt,**/prompts/**"

# Markdown and text files
file-patterns: "**/*.md,**/*.txt"

# Specific directory only
file-patterns: "src/prompts/**"

# Multiple extensions
file-patterns: "**/*.prompt,**/*.system,**/*.template"
```

## Supported models

All models on the [Calcis models page](https://www.calcis.dev/models) are supported, including:

- `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5`
- `gpt-5`, `gpt-5-4`, `gpt-4o`, `gpt-4-1`
- `gemini-2-5-flash`, `gemini-2-5-pro`
- And more at [calcis.dev/models](https://www.calcis.dev/models)

## Safety limits

- **Max files**: Only the first 10 matching files are estimated per run (configurable via `max-files`). Prevents excessive API usage on large PRs.
- **Max file size**: Files over 100 KB are skipped. Prompt files are typically small; very large files are likely data, not prompts.
- **Empty files**: Silently skipped.
- **Auth failure**: If the API key is invalid, the action stops immediately with a clear error instead of retrying every file.
- **API key masking**: The API key is masked in all log output via `core.setSecret()`.

## Troubleshooting

**Action fails with "Authentication failed"**
Your `CALCIS_API_KEY` secret is missing, invalid, or expired. Verify it exists in Settings > Secrets > Actions, and that the key starts with `calc_`. Generate a new one at [calcis.dev/dashboard](https://www.calcis.dev/dashboard) if needed.

**Action fails with "GITHUB_TOKEN is required"**
Add `env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }` to your workflow step.

**The `calcis/cost` check is missing**
The workflow needs `checks: write` permission. Add it to the `permissions` block. Without this permission the action still posts the PR comment and logs a warning — it just can't publish the check run that branch protection needs.

**Budget check failed**
The PR's estimated cost exceeded a `fail` threshold defined in `.calcis.yml`. The check-run summary lists which threshold was breached and by how much. Either tune the threshold, reduce the prompt cost, or set `fail-on-budget: false` during rollout to downgrade failures to warnings.

**`.calcis.yml` parse error**
The config file is malformed. The action logs an error pointing at the specific issue and falls back to action inputs for that run — no crash. Fix the YAML and re-push.

**Base-branch file fetch failed**
For one or more files, the action couldn't retrieve the base-branch version (network issue, private fork with restricted token, etc.). The affected row shows `—` in the Δ Cost column and the total delta is marked incomplete. The check run is still published.

**No comment appears on the PR**
Check that changed files match your `file-patterns`, the workflow has `pull-requests: write` permission, and the action logs don't show warnings about skipped files.

**Comment shows "Error" for a file**
The Calcis API could not estimate that file. Check the action logs for the specific error message. Common causes: file is binary, model ID not recognized, or API temporarily unavailable.

**Files were skipped**
Files over 100 KB, empty files, or files beyond the `max-files` limit are skipped. The PR comment includes a note explaining why.

## License

[MIT](LICENSE)

---

Get your API key at **[calcis.dev](https://calcis.dev)**
