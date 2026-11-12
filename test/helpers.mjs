import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const cli = path.join(repo, 'app', 'cli.mjs');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function freePorts(count) {
  const servers = await Promise.all(
    Array.from({ length: count }, async () => {
      const server = net.createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server;
    }),
  );
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  if (new Set(ports).size !== ports.length) throw new Error(`duplicate ports allocated: ${ports.join(',')}`);
  return ports;
}

export async function startFixtureProcess() {
  const child = spawn(process.execPath, [path.join(repo, 'test', 'fixtures', 'server.mjs')], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture server did not start: ${err || out}`)), 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const match = out.match(/PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture server exited (${code}): ${err || out}`));
    });
  });
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export async function createHarness() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshedge-test-'));
  const [bridgePort, cdpPort, livePort] = await freePorts(3);
  const env = {
    ...process.env,
    DSH_EDGE_DATA: temp,
    DSH_EDGE_BRIDGE_PORT: String(bridgePort),
    DSH_EDGE_CDP_PORT: String(cdpPort),
    DSH_EDGE_LIVE_CDP_PORT: String(livePort),
    DSH_EDGE_EXTENSION: '0',
  };
  return { temp, env };
}

export function runCli(args, env, { timeout = 120000, json = true } = {}) {
  const argv = [cli, ...args];
  if (json) argv.push('--json');
  const started = Date.now();
  const res = spawnSync(process.execPath, argv, {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = {
    code: res.status ?? -1,
    signal: res.signal,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    ms: Date.now() - started,
    json: null,
  };
  if (json && out.stdout.trim()) {
    try {
      out.json = JSON.parse(out.stdout);
    } catch {
      /* leave null; caller can report */
    }
  }
  return out;
}

export function runOk(args, env, opts) {
  const res = runCli(args, env, opts);
  if (res.code !== 0) {
    throw new Error(
      `dshedge ${args.join(' ')} failed (${res.code}) in ${res.ms}ms\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return res;
}

export function runCliAsync(args, env, { timeout = 120000 } = {}) {
  const argv = [cli, ...args, '--json'];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      argv,
      { cwd: repo, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let json = null;
        try {
          json = JSON.parse(stdout);
        } catch {
          /* leave null */
        }
        resolve({ code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', json });
      },
    );
  });
}

export async function waitFor(fn, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

export function state(env) {
  const file = path.join(env.DSH_EDGE_DATA, 'state.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function killProfile(profileDir) {
  const needle = profileDir.replace(/'/g, "''");
  const script =
    `$needle='${needle}'; ` +
    'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | ' +
    `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle.ToLower()) } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
  } catch {
    /* ignore */
  }
}

function pidCommandLine(pid) {
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue).CommandLine`;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    }).trim();
  } catch {
    return '';
  }
}

export async function cleanup(harness) {
  try {
    runCli(['stop', '--all'], harness.env, { json: false, timeout: 30000 });
  } catch {
    /* ignore */
  }
  const st = state(harness.env);
  if (st?.pid && pidCommandLine(st.pid).toLowerCase().includes('bridge.mjs')) {
    try {
      process.kill(st.pid);
    } catch {
      /* already gone */
    }
  }
  killProfile(path.join(harness.temp, 'edge-profile'));
  killProfile(path.join(harness.temp, 'edge-daily'));
  await sleep(1500);
  try {
    fs.rmSync(harness.temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    try {
      fs.renameSync(harness.temp, `${harness.temp}.trash-${Date.now()}`);
    } catch {
      /* best effort */
    }
  }
}

export async function openPage(env, url, tab) {
  const args = ['open', url];
  if (tab) args.push('--tab', tab);
  return runOk(args, env).json;
}

export function evalJs(env, expression, extra = []) {
  return runOk(['eval', expression, ...extra], env).json;
}
