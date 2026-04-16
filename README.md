# Calcis LLM Cost Estimator

Automatically estimates LLM API costs on pull requests when prompt files change. Like [Infracost](https://www.infracost.io/) for cloud infrastructure, but for AI.

## What it does

- Detects changed prompt files in PRs using configurable glob patterns
- Estimates token counts and costs using the [Calcis](https://calcis.dev) pre-flight estimation engine
- Posts a cost breakdown table as a PR comment
- Updates the comment automatically on new commits

## Example PR comment

> **Calcis LLM Cost Estimate**
>
> | File | Tokens | Est. Cost | Model |
> |------|--------|-----------|-------|
> | `prompts/chat.txt` | 1,247 | $0.0084 | claude-sonnet-4-6 |
> | `prompts/summary.txt` | 423 | $0.0028 | claude-sonnet-4-6 |
> | **Total** | **1,670** | **$0.0112** | claude-sonnet-4-6 |
>
> *Last updated: 2026-04-16 12:34:56 UTC | Powered by Calcis*

## Usage

Add to `.github/workflows/calcis.yml`:

```yaml
name: LLM Cost Estimate
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

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

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | - | Your Calcis API key (starts with `calc_`) |
| `model` | No | `claude-sonnet-4-6` | LLM model to estimate costs for |
| `file-patterns` | No | `**/*.prompt,**/prompts/**` | Comma-separated glob patterns for prompt files |
| `max-files` | No | `10` | Maximum files to estimate per run |

The `GITHUB_TOKEN` environment variable is required for posting PR comments. Use `${{ secrets.GITHUB_TOKEN }}` (automatically provided by GitHub Actions).

## Outputs

| Output | Description |
|--------|-------------|
| `total-cost` | Total estimated cost in USD |
| `files-scanned` | Number of prompt files scanned |
| `files-skipped` | Number of files skipped |

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
