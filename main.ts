import { createApp } from './app.ts';

const environmentUrl = (process.env.MAKEFUN_ENV_URL ?? '').trim();
if (environmentUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is required\n');
  process.exit(1);
}

function lifecycleUrl(path: string): string {
  let base = environmentUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}${path}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(attempt: number): number {
  const exponent = Math.min(attempt, 7);
  return Math.min(2000, 100 * 2 ** exponent);
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(lifecycleUrl('/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(10000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 200 || response.status === 409) return;
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`registration failed with HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('registration failed')) throw error;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(lifecycleUrl('/done'), {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const body = await response.json() as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      await sleep(retryDelay(attempt));
      continue;
    }
    await sleep(retryDelay(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('listener did not expose a TCP port');
  process.stdout.write(`[entry] forge listening on port ${address.port}\n`);
  await register(address.port);
  await waitForCompletion();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
