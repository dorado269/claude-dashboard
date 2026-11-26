/**
 * @handbook 8.1-test-structure
 * @covers scripts/calibrate-pricing.ts
 */
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface ProbeRequest {
  model: string;
  max_tokens: number;
  messages: { content: unknown }[];
}

const cli = fileURLToPath(new URL('../../dist/calibrate-pricing.js', import.meta.url));
const apiModel = 'claude-sonnet-4-5-20250929';
const gatewayModel = 'My-Sonnet[1m]';
const expectedRow = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const tokenCounts = [
  [0, 0, 0, 0, 0],
  [15_000, 5, 0, 0, 0],
  [45_000, 5, 0, 0, 0],
  [25, 1100, 0, 0, 0],
  [45, 7, 0, 0, 0],
  [12, 5, 20_000, 0, 0],
  [12, 5, 0, 0, 20_000],
  [12, 5, 0, 21_000, 0],
  [12, 5, 0, 0, 21_000],
  [2600, 5, 15_000, 0, 21_000],
  [400, 5, 0, 0, 0],
];
const rates = [3, 15, 3.75, 6, 0.3];

let directory: string;
let mergeFrom: string;
let server: Server;
let requests: ProbeRequest[];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'calibrate-pricing-'));
  mergeFrom = join(directory, 'settings.json');
  writeFileSync(mergeFrom, JSON.stringify({ permissions: { deny: ['Bash'] } }));
  requests = [];
  const modelProbes = new Map<string, number>();
  server = createServer(async (req, res) => {
    req.setEncoding('utf8');
    let body = '';
    for await (const chunk of req) body += chunk;
    const probe = JSON.parse(body) as ProbeRequest;
    const index = modelProbes.get(probe.model) ?? 0;
    modelProbes.set(probe.model, index + 1);
    requests.push(probe);

    const vector = tokenCounts[index] ?? tokenCounts[0];
    const [input, output, write5m, write1h, read] = vector;
    const cost = vector.reduce((total, count, i) => total + count * rates[i], 0) / 1e6;
    if (probe.model === 'Invalid-Header') res.setHeader('x-mock-cost', 'unknown');
    else if (probe.model !== 'Missing-Header') res.setHeader('x-mock-cost', String(cost));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: apiModel,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
      },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

function runCli(models: string, args: string[] = [], settings = mergeFrom) {
  const port = (server.address() as AddressInfo).port;
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [cli, '--models', models, '--cost-header', 'x-mock-cost', '--base-url', `http://127.0.0.1:${port}`,
        '--merge-from', settings, ...args],
      {
        timeout: 4000,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: directory,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_CUSTOM_HEADERS: '',
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? 'unknown' : 0, stdout, stderr })
    );
  });
}

describe('calibrate-pricing CLI', () => {
  it.each(['Missing-Header', 'Invalid-Header'])('sends just the tiny probe for %s, even with --large', async (model) => {
    const result = await runCli(model, ['--large']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('tiny preflight failed');
    expect(requests).toEqual([{ model, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }]);
  });

  it.each(['{', '[]', '{"modelPricing":{"overrides":[]}}'])('rejects invalid merge settings before any probe: %s', async (json) => {
    writeFileSync(mergeFrom, json);
    const result = await runCli(gatewayModel);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(mergeFrom);
    expect(requests).toHaveLength(0);
  });

  it('rejects an explicitly selected missing merge file before any probe', async () => {
    const result = await runCli(gatewayModel, [], join(directory, 'missing.json'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot read managed settings');
    expect(requests).toHaveLength(0);
  });

  it('skips a failed model and fits the next one when its tiny probe reports an explicit zero', async () => {
    const result = await runCli(`Missing-Header,${gatewayModel}`);
    expect(result.code).toBe(2);
    expect(requests.filter(({ model }) => model === 'Missing-Header')).toHaveLength(1);
    expect(requests.filter(({ model }) => model === gatewayModel)).toHaveLength(11);
    expect(result.stderr).toContain('reasoning');
    expect(JSON.parse(result.stdout)).toEqual({
      permissions: { deny: ['Bash'] },
      modelPricing: {
        overrides: {
          [apiModel]: expectedRow,
          'claude-sonnet-4-5': expectedRow,
          'claude-sonnet-4.5': expectedRow,
          'claude-sonnet-4.5[1m]': expectedRow,
          [gatewayModel]: expectedRow,
        },
      },
    });
  });

  it('reports the fitted override on stderr when writing the output fails', async () => {
    const result = await runCli(gatewayModel, ['--out', join(directory, 'missing', 'result.json')]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`modelPricing.overrides entry: ${JSON.stringify({ [gatewayModel]: expectedRow })}`);
    expect(result.stderr).toContain('ENOENT');
  });
});
