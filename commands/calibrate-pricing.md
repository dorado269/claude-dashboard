---
description: Fit per-model token prices from a gateway's per-request cost header and generate Claude Code's modelPricing managed setting
allowed-tools: Bash
---

# Calibrate Pricing

For API gateways that bill at contracted rates and return each request's cost in a response header. Probes each model with billed requests, fits a price per token kind (input, output, 5m/1h cache write, cache read), verifies the fit reproduces every request's reported cost, and emits a `modelPricing` block for Claude Code's managed settings so `/cost` and the status line cost widgets use those rates.

## Usage

```bash
/claude-dashboard:calibrate-pricing --models <model,model> --cost-header <header-name>
/claude-dashboard:calibrate-pricing --models <model> --cost-header <header-name> --large
/claude-dashboard:calibrate-pricing --models <model> --cost-header <header-name> --out /tmp/managed-settings.json
```

## Tasks

### 1. Confirm before spending

Every probe is a real, billed request: a few cents per model by default, roughly $1-$10 per model with `--large`. If the user did not give `--models` and `--cost-header`, ask for them; the header name is gateway-specific.

Use `ANTHROPIC_BASE_URL` or `--base-url` to point at the gateway. The script validates the managed settings or `--merge-from` file before probing. Each model starts with one tiny billed request. If the response lacks usable cost or usage data, the script skips the remaining probes for that model.

### 2. Find plugin path and run the script

```bash
CFGDIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; SCRIPT="$(CFGDIR="$CFGDIR" node -e '
const fs = require("fs");
const path = require("path");
const cacheRoot = path.join(process.env.CFGDIR, "plugins/cache/claude-dashboard/claude-dashboard");
let entries = [];
try {
  entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
} catch {}
const versions = entries
  .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
  .map((e) => e.name)
  .filter((v) => fs.existsSync(path.join(cacheRoot, v, "dist/calibrate-pricing.js")))
  .sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });
if (versions.length === 0) {
  console.error("claude-dashboard is not installed in " + process.env.CFGDIR);
  process.exit(1);
}
console.log(path.join(cacheRoot, versions[versions.length - 1], "dist/calibrate-pricing.js"));
')" && node "$SCRIPT" $ARGUMENTS
```

The fit report and fitted override entries go to stderr. The merged managed-settings JSON goes to stdout (or `--out`). Exit code 2 means at least one model was skipped because its preflight failed, the collected samples could not supply all required prices, or the fit failed its residual check. Successful models still appear in the output.

### 3. Install

Deploy [`modelPricing`](https://code.claude.com/docs/en/settings-reference#modelpricing) through Claude Code managed settings. Show the user the JSON and, only with their approval, install it:

```bash
sudo install -m 0644 /tmp/managed-settings.json /etc/claude-code/managed-settings.json
```

The output already merges any existing `/etc/claude-code/managed-settings.json`. New sessions pick it up; verify with `/cost` or `claude -p ... --output-format json` (`total_cost_usd`).
