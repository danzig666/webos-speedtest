'use strict';
// Installer: download -> SHA-256 check -> extract "speedtest" -> verify.
// Uses a local HTTP server; set REAL_DOWNLOAD=1 to also fetch the real
// archive from install.speedtest.net (CI does this).
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var crypto = require('crypto');
var cp = require('child_process');
var Runner = require('../service/lib/runner').Runner;
var inst = require('../service/lib/installer');

process.env.MOCK_NODE = process.execPath;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'st-inst-')); }

var makeArchive = require('./support/mock-archive');
var ARCHIVE = makeArchive();

function serve(handler) {
  return new Promise(function (resolve) {
    var srv = http.createServer(handler).listen(0, '127.0.0.1', function () { resolve(srv); });
  });
}

function install(installer) {
  return new Promise(function (resolve) {
    var events = [];
    installer.install(function (e) { events.push(e); if (e.event === 'install-done') resolve(events); });
  });
}

function setup(opts) {
  var dir = tmp();
  var runner = new Runner({ binary: path.join(dir, 'speedtest', 'speedtest'), home: path.join(dir, 'speedtest') });
  return { runner: runner, installer: new inst.Installer(runner, opts), target: runner.config.binary };
}

test('pinned packages: armel for 32-bit ARM, https only', function () {
  assert.match(inst.packageFor('arm').url, /^https:\/\/install\.speedtest\.net\/app\/cli\/ookla-speedtest-1\.2\.0-linux-armel\.tgz$/);
  assert.match(inst.packageFor('arm64').url, /linux-aarch64\.tgz$/);
  Object.keys(inst.PACKAGES).forEach(function (k) { assert.match(inst.PACKAGES[k].sha256, /^[0-9a-f]{64}$/); });
  assert.strictEqual(inst.packageFor('mips'), null);
});

test('downloads, verifies, extracts, installs executable, follows redirect, reports progress', async function (t) {
  var srv = await serve(function (req, res) {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/cli.tgz' }); return res.end(); }
    res.writeHead(200, { 'Content-Length': ARCHIVE.buf.length });
    // send in two parts to exercise progress
    res.write(ARCHIVE.buf.slice(0, 1000));
    setTimeout(function () { res.end(ARCHIVE.buf.slice(1000)); }, 200);
  });
  t.after(function () { srv.close(); });
  var s = setup({ url: 'http://127.0.0.1:' + srv.address().port + '/redirect', sha256: ARCHIVE.sha256 });
  var events = await install(s.installer);
  var done = events[events.length - 1];
  assert.strictEqual(done.ok, true, JSON.stringify(done.error));
  assert.match(done.version, /^Speedtest by Ookla 1\.2\.0/);
  assert.ok(events.some(function (e) { return e.event === 'download' && e.total === ARCHIVE.buf.length; }));
  assert.ok(events.some(function (e) { return e.event === 'verifying'; }));
  var st = fs.statSync(s.target);
  assert.strictEqual(st.mode & 511, 493, 'mode 0755');
  assert.ok(!fs.existsSync(s.target + '.download'));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(s.target)), ['speedtest'], 'only the binary is installed');

  // the installed binary actually runs a test through the runner
  process.env.MOCK_SCALE = '0.1';
  var exit = await new Promise(function (resolve) { s.runner.start({}, function (e) { if (e.event === 'exit') resolve(e); }); });
  assert.strictEqual(exit.code, 0);
});

test('checksum mismatch installs nothing', async function (t) {
  var srv = await serve(function (req, res) { res.end(ARCHIVE.buf); });
  t.after(function () { srv.close(); });
  var s = setup({ url: 'http://127.0.0.1:' + srv.address().port + '/x.tgz', sha256: 'f'.repeat(64) });
  var done = (await install(s.installer)).pop();
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.error.code, 'CHECKSUM_MISMATCH');
  assert.ok(!fs.existsSync(s.target));
});

test('HTTP error and unreachable host are reported', async function (t) {
  var srv = await serve(function (req, res) { res.writeHead(404); res.end(); });
  t.after(function () { srv.close(); });
  var s = setup({ url: 'http://127.0.0.1:' + srv.address().port + '/missing.tgz', sha256: ARCHIVE.sha256 });
  var done = (await install(s.installer)).pop();
  assert.strictEqual(done.error.code, 'DOWNLOAD_FAILED');
  assert.match(done.error.message, /HTTP 404/);
  var s2 = setup({ url: 'http://127.0.0.1:1/x.tgz', sha256: ARCHIVE.sha256 });
  var done2 = (await install(s2.installer)).pop();
  assert.strictEqual(done2.error.code, 'DOWNLOAD_FAILED');
  assert.match(done2.error.message, /ECONNREFUSED/);
});

test('cancel stops a download; tests and downloads exclude each other', async function (t) {
  var srv = await serve(function (req, res) { res.writeHead(200, { 'Content-Length': ARCHIVE.buf.length }); res.write(ARCHIVE.buf.slice(0, 100)); /* then stall */ });
  t.after(function () { srv.closeAllConnections(); srv.close(); });
  var s = setup({ url: 'http://127.0.0.1:' + srv.address().port + '/slow.tgz', sha256: ARCHIVE.sha256 });
  var p = install(s.installer);
  await new Promise(function (r) { setTimeout(r, 200); });
  assert.throws(function () { s.runner.start({}, function () {}); }, function (e) { return e.code === 'BUSY'; });
  assert.throws(function () { s.installer.install(function () {}); }, function (e) { return e.code === 'BUSY'; });
  assert.strictEqual(s.installer.cancel(), true);
  var done = (await p).pop();
  assert.strictEqual(done.error.code, 'CANCELLED');
  assert.ok(!fs.existsSync(s.target));
  assert.strictEqual(s.installer.isActive(), false);
});

test('archive without a speedtest member is rejected', async function (t) {
  var d = tmp();
  fs.writeFileSync(path.join(d, 'readme'), 'x');
  var out = path.join(tmp(), 'bad.tgz');
  cp.execFileSync('tar', ['-czf', out, '-C', d, 'readme']);
  var buf = fs.readFileSync(out);
  var srv = await serve(function (req, res) { res.end(buf); });
  t.after(function () { srv.close(); });
  var s = setup({ url: 'http://127.0.0.1:' + srv.address().port + '/bad.tgz', sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  var done = (await install(s.installer)).pop();
  assert.strictEqual(done.error.code, 'BAD_ARCHIVE');
});

var LOCAL_ARMEL = process.env.OOKLA_ARMEL_TGZ;
test('official armel archive: pinned hash matches and the ARM binary is extracted', { skip: !(LOCAL_ARMEL || process.env.REAL_DOWNLOAD === '1') && 'set OOKLA_ARMEL_TGZ=<path> or REAL_DOWNLOAD=1' }, async function (t) {
  var url = inst.packageFor('arm').url;
  if (LOCAL_ARMEL) {
    var buf = fs.readFileSync(LOCAL_ARMEL);
    var srv = await serve(function (req, res) { res.end(buf); });
    t.after(function () { srv.close(); });
    url = 'http://127.0.0.1:' + srv.address().port + '/armel.tgz';
  }
  var dir = tmp();
  var runner = new Runner({ binary: path.join(dir, 'speedtest'), home: dir, arch: 'arm' });
  var verified = false;
  // On x86 the ARM binary cannot run; check its header instead of --version.
  var installer = new inst.Installer(runner, { arch: 'arm', url: url, verify: function (file, cb) {
    var head = fs.readFileSync(file).slice(0, 64);
    verified = require('../service/lib/runner').checkExecutableFormat(head, 'arm') === null;
    cb(verified ? null : { code: 'X', message: 'not ARM' }, 'ARM binary');
  } });
  var done = (await install(installer)).pop();
  assert.strictEqual(done.ok, true, JSON.stringify(done.error));
  assert.ok(verified);
  assert.strictEqual(fs.statSync(runner.config.binary).size, 2287444);
});
