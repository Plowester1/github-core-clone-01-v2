// Variant 2 uses a small deterministic REST forge behind a standalone lifecycle. The process owns
// its ephemeral listener, announces that port to the kit environment, and stays alive until grading ends.
import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set; cannot register\n');
  process.exit(1);
}

const timeout = 30_000;
// Keep registration retries bounded per request while allowing the environment to boot normally.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const delay = (attempt: number) => Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }), signal: AbortSignal.timeout(timeout),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) throw new Error(`register failed: HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register failed:')) throw error;
    }
    await sleep(delay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(timeout) });
      if (response.ok && ((await response.json()) as { done?: unknown }).done === true) return;
    } catch { /* retry while the environment is busy */ }
    await sleep(delay(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('ephemeral listener has no TCP address');
  process.stdout.write(`[entry] variant 2 forge listening on ${address.port}; deterministic REST dossier ready\n`);
  await register(address.port);
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

try { await run(); process.exit(0); }
catch (error) { process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
