import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { startFixtureProcess } from './helpers.mjs';
import {
  cleanup,
  createHarness,
  evalJs,
  killProfile,
  openPage,
  runCli,
  runCliAsync,
  runOk,
  waitFor,
} from './helpers.mjs';

const headless = process.env.DSH_TEST_HEADLESS === '1';
let fixture;
let harness;
let startData;

const env = () => harness.env;
const base = () => fixture.base;
const title = (tab) => evalJs(env(), 'document.title', tab ? ['--tab', tab] : []).value;
const text = (selector, tab) => {
  const args = ['text', selector];
  if (tab) args.push('--tab', tab);
  return runOk(args, env()).json.text;
};
const html = (selector, tab) => {
  const args = ['html', selector];
  if (tab) args.push('--tab', tab);
  return runOk(args, env()).json.html;
};

before(async () => {
  fixture = await startFixtureProcess();
  harness = await createHarness();
  const args = ['start', `${base()}/basic`];
  if (headless) args.push('--headless');
  startData = runOk(args, env(), { timeout: 120000 }).json;
});

after(async () => {
  if (harness) await cleanup(harness);
  if (fixture) await fixture.close();
});

test('start/status exposes the automation profile and a live Edge', { timeout: 60000 }, () => {
  assert.equal(startData.profile, path.join(harness.temp, 'edge-profile'));
  assert.match(startData.browser, /Edg\//);
  const status = runOk(['status'], env()).json;
  assert.equal(status.running, true);
  assert.equal(status.health.profile, path.join(harness.temp, 'edge-profile'));
  assert.match(status.health.edge, /Edg\//);
  assert.equal(status.health.edgeConnected, true);
});

test('tabs/new returns a loaded page before the next eval', { timeout: 60000 }, () => {
  const created = runOk(['new', `${base()}/page2`], env()).json;
  assert.ok(created.tab);
  const immediate = evalJs(env(), 'document.title', ['--tab', created.tab]);
  assert.equal(immediate.value, 'Page Two');
  runOk(['close', created.tab], env());
});

test('tabs list/activate/close work', { timeout: 60000 }, () => {
  const created = runOk(['new', `${base()}/page2`], env()).json;
  const listed = runOk(['tabs'], env()).json.tabs;
  assert.ok(listed.some((t) => t.id === created.tab));
  runOk(['activate', created.tab], env());
  const active = runOk(['tabs'], env()).json.tabs.find((t) => t.id === created.tab);
  assert.equal(active.active, true);
  runOk(['close', created.tab], env());
  assert.ok(!runOk(['tabs'], env()).json.tabs.some((t) => t.id === created.tab));
});

test('navigation, history, back, forward and reload', { timeout: 90000 }, () => {
  openPage(env(), `${base()}/basic`);
  openPage(env(), `${base()}/page2`);
  const hist = runOk(['history'], env()).json;
  assert.ok(hist.entries.length >= 2);
  assert.ok(hist.entries.some((e) => e.url.endsWith('/basic')));
  const back = runOk(['back'], env()).json;
  assert.ok(back.url.endsWith('/basic'));
  const forward = runOk(['forward'], env()).json;
  assert.ok(forward.url.endsWith('/page2'));
  const reload = runOk(['reload', '--hard'], env()).json;
  assert.ok(reload.url.endsWith('/page2'));
});

test('eval, text, html and snapshot read the page', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/basic`);
  assert.equal(title(), 'Basic Fixture');
  assert.equal(text('#title'), 'Basic Fixture');
  assert.match(html('#title'), /<h1[^>]*id="title"/);
  const snap = runOk(['snapshot'], env()).json;
  assert.match(snap.text, /Basic Fixture/);
});

test('click, type and shadow DOM interaction', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/basic`);
  runOk(['click', '#btn'], env());
  assert.equal(text('#out'), 'clicked');
  runOk(['type', '#name', 'hello world', '--clear'], env());
  assert.equal(evalJs(env(), "document.querySelector('#name').value").value, 'hello world');
  runOk(['type', '#number', '7', '--clear'], env());
  assert.equal(evalJs(env(), "document.querySelector('#number').value").value, '7');
  runOk(['click', 'my-widget >>> #shadow-btn'], env());
  assert.equal(
    evalJs(env(), "document.querySelector('my-widget').shadowRoot.getElementById('shadow-out').textContent").value,
    'shadow-clicked',
  );
});

test('link click and form submission navigate correctly', { timeout: 90000 }, () => {
  openPage(env(), `${base()}/basic`);
  runOk(['click', 'text=Next page'], env());
  assert.equal(title(), 'Page Two');
  openPage(env(), `${base()}/form`);
  runOk(['type', '#q', 'abc'], env());
  runOk(['click', '#submit'], env());
  runOk(['wait', '#title'], env());
  assert.equal(title(), 'Submitted');
  assert.match(text('#query'), /q=abc/);
});

test('slow navigation waits for the new document', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/basic`);
  const started = Date.now();
  runOk(['open', `${base()}/slow-nav`], env(), { timeout: 60000 });
  assert.ok(Date.now() - started >= 500);
  assert.equal(title(), 'Slow Nav');
});

test('beforeunload is accepted and does not cancel navigation', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/leave`);
  runOk(['open', `${base()}/basic`], env(), { timeout: 60000 });
  assert.equal(title(), 'Basic Fixture');
});

test('unicode text survives the JSON request body', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/unicode`);
  runOk(['type', '#text', '中文😀'], env());
  assert.equal(text('#out'), '中文😀|3');
  assert.equal(evalJs(env(), "document.querySelector('#text').value").value, '中文😀');
});

test('screenshot and PDF produce valid files', { timeout: 90000 }, () => {
  openPage(env(), `${base()}/basic`);
  const shot = path.join(harness.temp, 'shot.png');
  runOk(['shot', shot], env());
  const png = fs.readFileSync(shot);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(png.readUInt32BE(16) > 100);
  assert.ok(png.readUInt32BE(20) > 100);
  const full = path.join(harness.temp, 'full.png');
  runOk(['shot', full, '--full'], env());
  assert.equal(fs.readFileSync(full).subarray(1, 4).toString(), 'PNG');
  const pdf = path.join(harness.temp, 'page.pdf');
  runOk(['pdf', pdf], env());
  assert.equal(fs.readFileSync(pdf).subarray(0, 4).toString(), '%PDF');
});

test('JPEG format and emulation state survive a full-page screenshot', { timeout: 90000 }, () => {
  openPage(env(), `${base()}/basic`);
  runOk(['emulate', '--width', '390', '--height', '800'], env());
  assert.equal(evalJs(env(), 'innerWidth').value, 390);
  const jpeg = runOk(['shot', '--format', 'jpeg', '--full'], env()).json;
  assert.match(jpeg.path, /\.(jpe?g)$/i);
  assert.equal(fs.readFileSync(jpeg.path).subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.equal(evalJs(env(), 'innerWidth').value, 390);
  runOk(['emulate', '--reset'], env());
  assert.notEqual(evalJs(env(), 'innerWidth').value, 390);
});

test('tall pages are capped at 16384px', { timeout: 90000 }, () => {
  openPage(env(), `${base()}/tall`);
  const out = path.join(harness.temp, 'tall.png');
  const shot = runOk(['shot', out, '--full'], env(), { timeout: 90000 }).json;
  assert.ok(fs.existsSync(out));
  assert.match(String(shot.warning || ''), /16384/);
  if (shot.height !== undefined) assert.ok(shot.height <= 16384);
});

test('console, network and response body capture', { timeout: 90000 }, () => {
  openPage(env(), `${base()}/console`);
  runOk(['wait', '#api'], env());
  assert.equal(text('#api'), 'fixture-api');
  const logs = runOk(['console'], env()).json.entries;
  assert.ok(logs.some((e) => String(e.text).includes('fixture-log')));
  assert.ok(logs.some((e) => e.level === 'error' && String(e.text).includes('fixture-error')));
  const net = runOk(['net', '--filter', '/api/data'], env()).json.entries;
  const req = net.find((e) => e.url.includes('/api/data'));
  assert.ok(req, 'api request was captured');
  const body = runOk(['body', req.requestId], env()).json;
  assert.match(body.body, /fixture-api/);
});

test('wait supports selectors and frame predicates', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/slow`);
  runOk(['wait', '#slow'], env());
  runOk(['wait', '--fn', "document.body.dataset.ready === '1'"], env());
  assert.equal(text('#slow'), 'done');
});

test('cookies and storage set/get/remove', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/basic`);
  runOk(['cookies', '--set', 'fixture=abc', '--url', base()], env());
  const cookies = runOk(['cookies', '--url', base()], env()).json.cookies;
  const c = cookies.find((x) => x.name === 'fixture');
  assert.equal(c?.value, 'abc');
  runOk(['storage', '--set', 'alpha=beta'], env());
  assert.equal(runOk(['storage', '--get', 'alpha'], env()).json.value, 'beta');
  runOk(['storage', '--remove', 'alpha'], env());
  assert.notEqual(runOk(['storage', '--get', 'alpha'], env()).json.value, 'beta');
});

test('frames and frame-scoped eval/text/wait', { timeout: 90000 }, () => {
  openPage(env(), `${base()}/basic`);
  const frames = runOk(['frames'], env()).json.frames;
  const inner = frames.find((f) => f.url.includes('srcdoc'));
  assert.ok(inner, 'srcdoc frame is listed');
  const value = runOk(['eval', "document.querySelector('#inside').textContent", '--frame', inner.id], env()).json.value;
  assert.equal(value, 'Frame Inside');
  const frameText = runOk(['text', '#inside', '--frame', inner.id], env()).json.text;
  assert.equal(frameText, 'Frame Inside');
  runOk(['wait', '#inside', '--frame', inner.id], env());
});

test('window bounds and maximize/restore', { timeout: 60000 }, (t) => {
  if (headless) return t.skip('window bounds are not meaningful in headless mode');
  const mixed = runCli(['window', '--maximize', '--width', '1200'], env(), { timeout: 30000 });
  assert.notEqual(mixed.code, 0);
  assert.match(mixed.stderr, /cannot be combined/);
  const normal = runOk(['window', '--normal', '--width', '1200', '--height', '800'], env()).json;
  assert.equal(normal.bounds.width, 1200);
  assert.equal(normal.bounds.height, 800);
  const max = runOk(['window', '--maximize'], env()).json;
  assert.equal(max.bounds.windowState, 'maximized');
  runOk(['window', '--normal', '--width', '1300', '--height', '900'], env());
});

test('default dialog policy dismisses alerts and confirms', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/dialog`);
  runOk(['click', '#alert'], env());
  const dialog = runOk(['dialog'], env()).json;
  assert.equal(dialog.dialog, null);
  runOk(['click', '#confirm'], env());
  assert.equal(evalJs(env(), 'window.__confirmResult').value, false);
});

test('file upload sets the input files', { timeout: 60000 }, () => {
  const file = path.join(harness.temp, 'upload-fixture.txt');
  fs.writeFileSync(file, 'upload-content');
  openPage(env(), `${base()}/upload`);
  runOk(['upload', '#file', file], env());
  assert.equal(evalJs(env(), "document.querySelector('#file').files[0].name").value, 'upload-fixture.txt');
});

test('downloads are tracked and saved', { timeout: 90000 }, async () => {
  openPage(env(), `${base()}/download`);
  runOk(['click', '#dl'], env());
  const item = await waitFor(
    () => {
      const data = runOk(['downloads'], env()).json;
      return data.downloads.find((d) => d.state === 'completed' && d.suggestedFilename === 'fixture.txt');
    },
    { timeout: 30000, label: 'download completion' },
  );
  assert.ok(item);
  assert.ok(fs.existsSync(path.join(harness.temp, 'downloads', 'fixture.txt')));
});

test('raw browser-level CDP works', { timeout: 60000 }, () => {
  const version = runOk(['cdp', 'Browser.getVersion', '--tab', 'browser'], env()).json.result;
  assert.match(version.product, /Edg\//);
  const targets = runOk(['cdp', 'Target.getTargets', '--tab', 'browser'], env()).json.result.targetInfos;
  assert.ok(Array.isArray(targets) && targets.length > 0);
});

test('live profile is isolated and controllable', { timeout: 120000 }, (t) => {
  if (headless) return t.skip('live mode opens a visible daily Edge; run the local suite without DSH_TEST_HEADLESS');
  const before = runOk(['live', 'status'], env()).json;
  assert.equal(before.connected, false);
  const ensured = runOk(['live', 'ensure'], env(), { timeout: 120000 }).json;
  assert.equal(ensured.profile, path.join(harness.temp, 'edge-daily'));
  assert.equal(ensured.cdpPort, Number(env().DSH_EDGE_LIVE_CDP_PORT));
  const status = runOk(['live', 'status'], env()).json;
  assert.equal(status.connected, true);
  const liveDownloads = runOk(['live', 'downloads'], env()).json;
  assert.equal(liveDownloads.managed, false);
  assert.equal(liveDownloads.directory, null);
  const cleared = runCli(['live', 'cookies', '--clear'], env(), { timeout: 30000 });
  assert.notEqual(cleared.code, 0);
  assert.match(cleared.stderr, /refusing to clear all daily-profile cookies/);
  const created = runOk(['live', 'new', `${base()}/page2`], env()).json;
  const immediate = runOk(['live', 'eval', 'document.title', '--tab', created.tab], env()).json;
  assert.equal(immediate.value, 'Page Two');
  runOk(['live', 'close', created.tab], env());
  runOk(['live', 'open', `${base()}/tall`], env());
  const tallPath = path.join(harness.temp, 'live-tall.png');
  const tallShot = runOk(['live', 'shot', tallPath, '--full'], env(), { timeout: 90000 }).json;
  assert.match(String(tallShot.warning || ''), /16384/);
  if (tallShot.height !== undefined) assert.ok(tallShot.height <= 16384);
  const restarted = runOk(['live', 'restart'], env(), { timeout: 120000 }).json;
  assert.equal(restarted.restarted, true);
});

test('bridge can restart while Edge keeps running', { timeout: 60000 }, () => {
  runCli(['stop'], env(), { json: false, timeout: 30000 });
  const started = runOk(['start'], env(), { timeout: 120000 }).json;
  assert.match(started.browser, /Edg\//);
  assert.ok(runOk(['tabs'], env()).json.tabs.length > 0);
});

test('bad selectors and waits fail deterministically', { timeout: 60000 }, () => {
  openPage(env(), `${base()}/basic`);
  const click = runCli(['click', '#missing-element'], env(), { timeout: 30000 });
  assert.notEqual(click.code, 0);
  assert.match(click.stderr, /element not found/);
  const wait = runCli(['wait', '#never', '--timeout', '600'], env(), { timeout: 30000 });
  assert.notEqual(wait.code, 0);
  assert.match(wait.stderr, /timed out/);
});

test('Edge crash is recovered by start', { timeout: 90000 }, () => {
  killProfile(path.join(harness.temp, 'edge-profile'));
  const started = runOk(['start'], env(), { timeout: 120000 }).json;
  assert.match(started.browser, /Edg\//);
  assert.ok(runOk(['tabs'], env()).json.tabs.length > 0);
});

test('concurrent cold starts do not duplicate the browser session', { timeout: 120000 }, async () => {
  runCli(['stop'], env(), { json: false, timeout: 30000 });
  const [a, b] = await Promise.all([
    runCliAsync(['new', `${base()}/page2`], env(), { timeout: 120000 }),
    runCliAsync(['new', `${base()}/basic`], env(), { timeout: 120000 }),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.ok(a.json?.tab);
  assert.ok(b.json?.tab);
  runOk(['close', a.json.tab], env());
  runOk(['close', b.json.tab], env());
});

test('close without an active tab refuses to guess', { timeout: 60000 }, () => {
  runCli(['stop'], env(), { json: false, timeout: 30000 });
  runOk(['start'], env(), { timeout: 120000 });
  const closed = runCli(['close'], env(), { timeout: 30000 });
  assert.notEqual(closed.code, 0);
  assert.match(closed.stderr, /no active tab/);
});

test('tab churn and bridge restart soak', { timeout: 120000 }, () => {
  for (let i = 0; i < 5; i++) {
    const created = runOk(['new', `${base()}/page2`], env()).json;
    assert.equal(runOk(['eval', 'document.title', '--tab', created.tab], env()).json.value, 'Page Two');
    runOk(['close', created.tab], env());
  }
  for (let i = 0; i < 3; i++) {
    runCli(['stop'], env(), { json: false, timeout: 30000 });
    runOk(['start'], env(), { timeout: 120000 });
    assert.equal(typeof runOk(['eval', 'document.title'], env()).json.value, 'string');
  }
});

test('high-intensity navigation loop stays consistent', { timeout: 120000 }, () => {
  for (let i = 0; i < 8; i++) {
    openPage(env(), `${base()}/page2`);
    assert.equal(title(), 'Page Two');
    openPage(env(), `${base()}/basic`);
    assert.equal(title(), 'Basic Fixture');
  }
});
