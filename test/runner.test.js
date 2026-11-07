'use strict';
// Process-level tests of the service runner against the mock CLI (and, for
// the "incompatible binary" check, the official ARM build when available).
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var Runner = require('../service/lib/runner').Runner;
var FIXED_ARGS = require('../service/lib/runner').FIXED_ARGS;

var MOCK = path.join(__dirname, 'mock', 'speedtest');
var PTY_DIR = path.join(__dirname, '..', 'service', 'bin');
var HAVE_PTY = fs.existsSync(path.join(PTY_DIR, 'ptyrun-x86_64')) || fs.existsSync(path.join(PTY_DIR, 'ptyrun-' + ({ arm64: 'aarch64', arm: 'armv7' })[process.arch]));
process.env.MOCK_NODE = process.execPath;

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'st-home-')); }

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function waitFor(pred, ms) {
  var t0 = Date.now();
  return new Promise(function (resolve, reject) {
    (function poll() {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timed out waiting'));
      setTimeout(poll, 20);
    })();
  });
}

function makeRunner(extra) {
  return new Runner(Object.assign({ binary: MOCK, home: tmpHome(), helperDir: PTY_DIR }, extra || {}));
}

/** Run to completion, recording every event and when the child exited. */
function runCollect(runner, opts, onEvt) {
  return new Promise(function (resolve) {
    var events = [];
    runner.start(opts || {}, function (e) {
      e._t = Date.now();
      events.push(e);
      if (onEvt) onEvt(e, events);
      if (e.event === 'exit') resolve(events);
    });
  });
}

function outputText(events, stream) {
  return events.filter(function (e) { return e.event === 'output'; })
    .map(function (e) { return e.chunks.filter(function (c) { return !stream || c.s === stream; }).map(function (c) { return c.d; }).join(''); })
    .join('');
}

function setMock(env) {
  var saved = {};
  Object.keys(env).forEach(function (k) { saved[k] = process.env[k]; process.env[k] = env[k]; });
  return function restore() { Object.keys(env).forEach(function (k) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); };
}

test('successful run streams output before the process exits (pipe mode)', async function () {
  var restore = setMock({ MOCK_MODE: 'success', MOCK_SCALE: '0.5' });
  var argsFile = path.join(tmpHome(), 'args.json');
  process.env.MOCK_ARGS_FILE = argsFile;
  var runner = makeRunner();
  var outputWhileAlive = 0;
  var pid = null;
  var events = await runCollect(runner, {}, function (e) {
    if (e.event === 'started') pid = e.pid;
    if (e.event === 'output' && pid && alive(pid)) outputWhileAlive++;
  });
  delete process.env.MOCK_ARGS_FILE;
  restore();

  var kinds = events.map(function (e) { return e.event; });
  assert.deepStrictEqual(kinds.slice(0, 3), ['accepted', 'version', 'started']);
  assert.match(events[1].text, /^Speedtest by Ookla 1\.2\.0/);
  assert.ok(outputWhileAlive >= 5, 'expected several output batches while the CLI was still running, got ' + outputWhileAlive);
  var exit = events[events.length - 1];
  assert.strictEqual(exit.reason, 'exit');
  assert.strictEqual(exit.code, 0);
  assert.strictEqual(exit.error, undefined);

  var out = outputText(events, 'out');
  var err = outputText(events, 'err');
  assert.match(out, /\r {4}Download: +\d+\.\d+ Mbps \[/, 'carriage-return progress redraws preserved');
  assert.ok(out.indexOf('\x1b[1mSpeedtest by Ookla\x1b[0m') !== -1, 'ANSI sequence split across writes arrives intact');
  assert.ok(out.indexOf('✓ µs') !== -1, 'UTF-8 split across writes decoded correctly');
  assert.ok(out.indexOf('�') === -1, 'no replacement characters');
  assert.match(out, /Result URL: https:\/\/www\.speedtest\.net\/result\/c\//);
  assert.match(err, /\[warning\] mock: this line was written to stderr/);

  var argv = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.deepStrictEqual(argv.args, FIXED_ARGS, 'fixed argument list');
  assert.strictEqual(argv.tty, false, 'pipe mode: stdout is not a TTY');
  assert.ok(!alive(argv.pid));
  assert.strictEqual(runner.isActive(), false);
});

test('cancel stops the real process, and a second run starts cleanly', async function () {
  var restore = setMock({ MOCK_MODE: 'success', MOCK_SCALE: '1' });
  var runner = makeRunner();
  var pid = null;
  var events = await runCollect(runner, {}, function (e, all) {
    if (e.event === 'started') pid = e.pid;
    if (e.event === 'output' && /Download:/.test(outputText(all)) && !all.cancelled) {
      all.cancelled = true;
      assert.strictEqual(alive(pid), true);
      assert.strictEqual(runner.cancel(), true);
    }
  });
  var exit = events[events.length - 1];
  assert.strictEqual(exit.reason, 'cancelled');
  assert.strictEqual(exit.signal, 'SIGTERM');
  assert.ok(events.some(function (e) { return e.event === 'stopping'; }));
  await waitFor(function () { return !alive(pid); }, 2000);
  assert.strictEqual(runner.isActive(), false);
  assert.strictEqual(runner.cancel(), false, 'nothing left to cancel');

  process.env.MOCK_SCALE = '0.2';
  var second = await runCollect(runner, {});
  restore();
  var exit2 = second[second.length - 1];
  assert.strictEqual(exit2.code, 0);
  assert.strictEqual(exit2.reason, 'exit');
  assert.ok(second[0].runId > events[0].runId);
  assert.match(outputText(second), /Result URL:/);
});

test('only one run at a time', async function () {
  var restore = setMock({ MOCK_MODE: 'success', MOCK_SCALE: '0.3' });
  var runner = makeRunner();
  var p = runCollect(runner, {});
  assert.throws(function () { runner.start({}, function () {}); }, function (e) { return e.code === 'BUSY'; });
  runner.cancel();
  var events = await p;
  restore();
  assert.strictEqual(events[events.length - 1].reason, 'cancelled');
});

test('CLI failure is reported with its stderr message', async function () {
  var restore = setMock({ MOCK_MODE: 'fail', MOCK_SCALE: '0.2' });
  var events = await runCollect(makeRunner(), {});
  restore();
  var exit = events[events.length - 1];
  assert.strictEqual(exit.reason, 'failed');
  assert.strictEqual(exit.code, 2);
  assert.strictEqual(exit.error.code, 'TEST_FAILED');
  assert.match(exit.error.message, /exited with code 2: \[error\] Download test failed/);
});

test('unreachable test servers are reported as a network error', async function () {
  var restore = setMock({ MOCK_MODE: 'noservers', MOCK_SCALE: '0.2' });
  var events = await runCollect(makeRunner(), {});
  restore();
  var exit = events[events.length - 1];
  assert.strictEqual(exit.code, 2);
  assert.strictEqual(exit.error.code, 'NETWORK_ERROR');
  assert.match(exit.error.message, /Failed to find a working test server/);
});

test('licence prompt is detected and explained, never answered', async function () {
  var restore = setMock({ MOCK_MODE: 'license', MOCK_SCALE: '0.2' });
  var runner = makeRunner({ home: '/media/developer/speedtest' });
  var events = await runCollect(runner, {});
  restore();
  var exit = events[events.length - 1];
  assert.strictEqual(exit.error.code, 'LICENSE_REQUIRED');
  assert.match(exit.error.hint, /HOME=\/media\/developer\/speedtest /);
});

test('stalled CLI is stopped by the stall timeout', async function () {
  var restore = setMock({ MOCK_MODE: 'stall', MOCK_SCALE: '0.2' });
  var runner = makeRunner({ stallTimeoutMs: 600 });
  var pid;
  var events = await runCollect(runner, {}, function (e) { if (e.event === 'started') pid = e.pid; });
  restore();
  var exit = events[events.length - 1];
  assert.strictEqual(exit.reason, 'stalled');
  assert.strictEqual(exit.error.code, 'STALLED');
  assert.ok(!alive(pid));
});

test('overall timeout escalates to SIGKILL when SIGTERM is ignored', async function () {
  var restore = setMock({ MOCK_MODE: 'success', MOCK_SCALE: '1', MOCK_IGNORE_TERM: '1' });
  var runner = makeRunner({ totalTimeoutMs: 900, killGraceMs: 400 });
  var pid;
  var events = await runCollect(runner, {}, function (e) { if (e.event === 'started') pid = e.pid; });
  restore();
  var exit = events[events.length - 1];
  assert.strictEqual(exit.reason, 'timeout');
  assert.strictEqual(exit.signal, 'SIGKILL');
  assert.strictEqual(exit.error.code, 'TIMEOUT');
  assert.ok(!alive(pid));
});

test('missing binary', async function () {
  var events = await runCollect(makeRunner({ binary: '/nonexistent/speedtest' }), {});
  var exit = events[events.length - 1];
  assert.strictEqual(exit.ran, false);
  assert.strictEqual(exit.error.code, 'BINARY_MISSING');
  assert.match(exit.error.hint, /armel/);
});

test('non-executable binary', async function () {
  var f = path.join(tmpHome(), 'speedtest');
  fs.writeFileSync(f, '#!/bin/sh\necho hi\n');
  fs.chmodSync(f, 420);
  var events = await runCollect(makeRunner({ binary: f }), {});
  var e = events[events.length - 1].error;
  // root bypasses permission checks for read but X_OK still needs an x bit
  assert.strictEqual(e.code, 'BINARY_NOT_EXECUTABLE');
});

test('wrong-architecture binary is rejected before it is executed', async function () {
  var f = path.join(tmpHome(), 'speedtest');
  var hdr = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(hdr);
  hdr.writeUInt16LE(62, 18); // x86-64
  fs.writeFileSync(f, hdr);
  fs.chmodSync(f, 493);
  var events = await runCollect(makeRunner({ binary: f, arch: 'arm' }), {});
  var e = events[events.length - 1].error;
  assert.strictEqual(e.code, 'BINARY_INCOMPATIBLE');
  assert.match(e.message, /x86-64.*arm/);
});

var OFFICIAL = process.env.OOKLA_ARMEL_BIN;
test('official armel binary: header recognised as ARM (32-bit)', { skip: !OFFICIAL && 'set OOKLA_ARMEL_BIN to the extracted official binary' }, async function () {
  var events = await runCollect(makeRunner({ binary: OFFICIAL, arch: 'x64' }), {});
  var e = events[events.length - 1].error;
  assert.strictEqual(e.code, 'BINARY_INCOMPATIBLE');
  assert.match(e.message, /ARM \(32-bit\)/);
  var ok = require('../service/lib/runner').checkExecutableFormat(fs.readFileSync(OFFICIAL).slice(0, 64), 'arm');
  assert.strictEqual(ok, null, 'accepted on an ARM TV');
});

test('pty mode: output is produced on a terminal and cancel reaches the CLI', { skip: !HAVE_PTY && 'build ptyrun first (npm run build:pty)' }, async function () {
  var restore = setMock({ MOCK_MODE: 'success', MOCK_SCALE: '0.5' });
  var argsFile = path.join(tmpHome(), 'args.json');
  process.env.MOCK_ARGS_FILE = argsFile;
  var runner = makeRunner();
  var cancelled = false;
  var events = await runCollect(runner, { pty: true }, function (e, all) {
    if (!cancelled && e.event === 'output' && /Download:/.test(outputText(all))) { cancelled = true; runner.cancel(); }
  });
  delete process.env.MOCK_ARGS_FILE;
  var argv = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  var out = outputText(events);
  assert.strictEqual(argv.tty, true, 'CLI sees a TTY');
  assert.match(out, /\r {4}Download:/);
  assert.ok(out.indexOf('✓ µs') !== -1);
  assert.match(out, /\r\n/, 'tty line discipline translates LF to CRLF');
  var exit = events[events.length - 1];
  assert.strictEqual(exit.reason, 'cancelled');
  await waitFor(function () { return !alive(argv.pid); }, 2000);

  process.env.MOCK_SCALE = '0.1';
  var second = await runCollect(runner, { pty: true });
  restore();
  assert.strictEqual(second[second.length - 1].code, 0);
  assert.match(outputText(second), /Result URL:/);
});

var QEMU = process.env.QEMU_ARM;
test('official armel binary under QEMU: --version preflight and licence prompt handling', { skip: !(OFFICIAL && QEMU) && 'set OOKLA_ARMEL_BIN and QEMU_ARM (e.g. /usr/bin/qemu-arm-static)' }, async function () {
  // A wrapper lets the x86 host execute the ARM binary; on the TV it runs natively.
  var dir = tmpHome();
  var wrapper = path.join(dir, 'speedtest');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec ' + QEMU + ' ' + OFFICIAL + ' "$@"\n');
  fs.chmodSync(wrapper, 493);
  var events = await runCollect(makeRunner({ binary: wrapper, home: dir }), {});
  var version = events.filter(function (e) { return e.event === 'version'; })[0];
  assert.match(version.text, /^Speedtest by Ookla 1\.2\.0\.84 .*Linux\/arm-linux-musleabi/);
  var exit = events[events.length - 1];
  // Fresh HOME: the CLI shows its licence text and exits because stdin is
  // /dev/null. The service must not accept on the user's behalf.
  assert.strictEqual(exit.code, 1);
  assert.strictEqual(exit.error.code, 'LICENSE_REQUIRED');
  assert.match(outputText(events), /speedtest --accept-license/);
  assert.ok(!fs.existsSync(path.join(dir, '.config', 'ookla', 'speedtest-cli.json')) ||
    !/LicenseAccepted/.test(fs.readFileSync(path.join(dir, '.config', 'ookla', 'speedtest-cli.json'), 'utf8')));

  if (HAVE_PTY) {
    // On a terminal the real CLI re-prompts forever; the runner must stop it.
    var t0 = Date.now();
    var ptyEvents = await runCollect(makeRunner({ binary: wrapper, home: dir }), { pty: true });
    var pexit = ptyEvents[ptyEvents.length - 1];
    assert.strictEqual(pexit.error.code, 'LICENSE_REQUIRED');
    assert.ok(Date.now() - t0 < 15000);
    assert.match(outputText(ptyEvents), /Do you accept the license\? \[type YES to accept\]/);
  }
});

test('pty mode: endless interactive licence prompt is stopped immediately', { skip: !HAVE_PTY && 'build ptyrun first' }, async function () {
  var restore = setMock({ MOCK_MODE: 'license', MOCK_SCALE: '0.2' });
  var t0 = Date.now();
  var events = await runCollect(makeRunner(), { pty: true });
  restore();
  var exit = events[events.length - 1];
  assert.strictEqual(exit.error.code, 'LICENSE_REQUIRED');
  assert.ok(Date.now() - t0 < 5000, 'stopped quickly');
  var prompts = outputText(events).split('[type YES to accept]').length - 1;
  assert.strictEqual(prompts, 1, 'prompt shown once, repeats suppressed');
});
