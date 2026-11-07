'use strict';
/*
 * End-to-end: Chromium (Playwright) -> app UI -> PalmServiceBridge shim ->
 * real service.js + runner -> mock CLI. Driven only with remote-control keys
 * (arrows, Enter = OK, Back keyCode 461).
 *
 * Skips when Playwright is not installed. Screenshots go to test-results/.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var http = require('http');
var createDevServer = require('../tools/dev-server.js');
var makeMockArchive = require('./support/mock-archive');
var playwright = null;
try { playwright = require('playwright'); } catch (e) { /* optional */ }

var OUT = path.join(__dirname, '..', 'test-results');
var ARGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-')), 'args.json');

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }
function mockPid() { return JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8')).pid; }

test('remote-driven UI against the real service and the mock CLI', { skip: !playwright && 'playwright not installed', timeout: 120000 }, async function (t) {
  fs.mkdirSync(OUT, { recursive: true });
  process.env.MOCK_SCALE = '0.6';
  process.env.MOCK_MODE = 'success';
  process.env.MOCK_ARGS_FILE = ARGS_FILE;
  var server = createDevServer();
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  var base = 'http://127.0.0.1:' + server.address().port;
  var status = async function () { return (await fetch(base + '/__dev/status')).json(); };

  var browser = await playwright.chromium.launch();
  t.after(async function () { await browser.close(); server.close(); });
  var page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  var pageErrors = [];
  page.on('pageerror', function (e) { pageErrors.push(e.message); });
  await page.goto(base + '/');

  var back = function () {
    return page.evaluate(function () {
      var ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: function () { return 461; } });
      document.activeElement.dispatchEvent(ev);
    });
  };
  var focusedId = function () { return page.evaluate(function () { return document.activeElement.id; }); };
  var consoleText = function () { return page.locator('#console').innerText(); };
  var stateText = function () { return page.locator('#state').innerText(); };

  // --- run 1: output streams while the CLI is running; Cancel kills it ---
  assert.strictEqual(await focusedId(), 'startBtn', 'Start has initial focus');
  await page.keyboard.press('Enter');
  await page.waitForFunction(function () { return /Download:/.test(document.getElementById('console').innerText); }, null, { timeout: 15000 });
  var st = await status();
  assert.strictEqual(st.active, true, 'output visible while the process is still running');
  var pid1 = mockPid();
  assert.ok(alive(pid1));
  assert.match(await page.locator('#version').innerText(), /Speedtest by Ookla 1\.2\.0/);
  assert.strictEqual(await page.locator('#live').isVisible(), true, 'live progress strip shown');
  // the progress line is redrawn in place: only one Download line on screen
  assert.strictEqual(((await consoleText()).match(/Download:/g) || []).length, 1);
  await page.screenshot({ path: path.join(OUT, 'console-running.png') });

  assert.strictEqual(await focusedId(), 'cancelBtn', 'focus moves to Cancel while running');
  await page.keyboard.press('ArrowRight');
  assert.strictEqual(await focusedId(), 'cancelBtn', 'disabled Output button is skipped');
  await page.keyboard.press('Enter');
  await page.waitForFunction(function () { return document.getElementById('state').textContent === 'Cancelled'; }, null, { timeout: 10000 });
  assert.strictEqual((await status()).active, false);
  assert.ok(!alive(pid1), 'Cancel stopped the actual process');
  assert.match(await consoleText(), /\[speedtest stopped by SIGTERM after/);

  // --- run 2: completes; graphical results; Back returns to the console ---
  await page.keyboard.press('ArrowLeft');
  assert.strictEqual(await focusedId(), 'startBtn');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#results:not([hidden])', { timeout: 30000 });
  assert.notStrictEqual(mockPid(), pid1, 'a fresh process');
  assert.strictEqual(await page.locator('#resDl').innerText(), '312');
  assert.strictEqual(await page.locator('#resUl').innerText(), '48.9');
  assert.strictEqual(await page.locator('#resPing').innerText(), '4.21');
  assert.strictEqual(await page.locator('#resLoss').innerText(), '0.0%');
  assert.match(await page.locator('#resUrl').innerText(), /^https:\/\/www\.speedtest\.net\/result\/c\//);
  assert.match(await page.locator('#resWhere').innerText(), /Mockville Fiber/);
  assert.strictEqual(await page.locator('#chartDl path.line').count(), 1, 'download chart drawn from live samples');
  assert.strictEqual(await page.locator('#chartUl path.line').count(), 1);
  assert.strictEqual(await focusedId(), 'againBtn');
  // pointer hover shows the chart tooltip (Magic Remote pointer)
  var box = await page.locator('#chartDl').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  assert.match(await page.locator('.chart .tooltip').first().innerText(), /s · [\d.]+ Mbps/);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: path.join(OUT, 'results.png') });

  await back();
  await page.waitForSelector('#results', { state: 'hidden' });
  var txt = await consoleText();
  assert.match(txt, /Download:\s+312\.47 Mbps \(data used: 351\.2 MB\)/, 'final summary stays visible');
  assert.match(txt, /Result URL: https:\/\/www\.speedtest\.net\/result\/c\//);
  assert.match(txt, /✓ µs/, 'UTF-8 split across chunks rendered');
  assert.match(txt, /\[warning\] mock: this line was written to stderr/);
  assert.strictEqual(await page.locator('#console .stderr').count() > 0, true, 'stderr styled');
  assert.strictEqual(await focusedId(), 'resultsBtn');
  await page.screenshot({ path: path.join(OUT, 'console-finished.png') });

  // --- run 3: CLI failure shows a useful error, then run again ---
  process.env.MOCK_MODE = 'fail';
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#error:not([hidden])', { timeout: 15000 });
  assert.match(await page.locator('#errorTitle').innerText(), /exited with code 2: \[error\] Download test failed/);
  assert.strictEqual(await stateText(), 'Failed');
  await page.screenshot({ path: path.join(OUT, 'error-failed.png') });

  process.env.MOCK_MODE = 'license';
  await page.keyboard.press('Enter');
  await page.waitForFunction(function () { return /licence/.test(document.getElementById('errorTitle').textContent); }, null, { timeout: 15000 });
  assert.match(await page.locator('#errorHint').innerText(), /type YES/);

  // --- run 4: closing the app while running kills the process ---
  process.env.MOCK_MODE = 'success';
  process.env.MOCK_SCALE = '1';
  await back(); // dismiss error
  await page.keyboard.press('Enter');
  await page.waitForFunction(function () { return /Server:/.test(document.getElementById('console').innerText); }, null, { timeout: 15000 });
  var pid4 = mockPid();
  assert.ok(alive(pid4));
  await page.close();
  var t0 = Date.now();
  while (((await status()).active || alive(pid4)) && Date.now() - t0 < 8000) await new Promise(function (r) { setTimeout(r, 50); });
  assert.strictEqual((await status()).active, false, 'service released the run');
  assert.ok(!alive(pid4), 'closing the app stopped the process');
  assert.deepStrictEqual(pageErrors, []);
});

test('missing CLI: download it from the app, then decline and accept the terms', { skip: !playwright && 'playwright not installed', timeout: 120000 }, async function (t) {
  process.env.MOCK_SCALE = '0.3';
  process.env.MOCK_MODE = 'license'; // licence required until accepted
  var archive = makeMockArchive();
  var hits = 0;
  var files = http.createServer(function (req, res) {
    hits++;
    res.writeHead(200, { 'Content-Length': archive.buf.length });
    res.write(archive.buf.slice(0, 2000));
    setTimeout(function () { res.end(archive.buf.slice(2000)); }, 400);
  });
  await new Promise(function (r) { files.listen(0, '127.0.0.1', r); });
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-dl-'));
  var target = path.join(dir, 'speedtest', 'speedtest');
  var server = createDevServer({ binary: target, home: path.dirname(target),
    installer: { url: 'http://127.0.0.1:' + files.address().port + '/ookla.tgz', sha256: archive.sha256 } });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  var browser = await playwright.chromium.launch();
  t.after(async function () { await browser.close(); server.close(); files.close(); });
  var page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  var pageErrors = [];
  page.on('pageerror', function (e) { pageErrors.push(e.message); });
  await page.goto('http://127.0.0.1:' + server.address().port + '/');
  var focusedId = function () { return page.evaluate(function () { return document.activeElement.id; }); };

  // 1. Start without the CLI -> clear error + Download button gets focus
  await page.keyboard.press('Enter');
  await page.waitForSelector('#downloadBtn:not([hidden])');
  assert.match(await page.locator('#errorTitle').innerText(), /not found at .*speedtest\/speedtest/);
  await page.waitForFunction(function () { return document.activeElement.id === 'downloadBtn'; });
  await page.screenshot({ path: path.join(OUT, 'cli-missing.png') });

  // 2. OK -> download with progress -> installed and verified
  await page.keyboard.press('Enter');
  await page.waitForFunction(function () { return /KB \/ /.test(document.getElementById('liveValue').textContent); }, null, { timeout: 10000 });
  await page.waitForFunction(function () { return /Installed: Speedtest by Ookla/.test(document.getElementById('console').innerText); }, null, { timeout: 15000 });
  assert.strictEqual(hits, 1);
  assert.strictEqual(fs.statSync(target).mode & 511, 493);
  assert.strictEqual(await focusedId(), 'startBtn');
  await page.screenshot({ path: path.join(OUT, 'cli-installed.png') });

  // 3. Start -> licence required -> Review terms (focus on Decline) -> decline
  await page.keyboard.press('Enter');
  await page.waitForSelector('#termsBtn:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(function () { return document.activeElement.id === 'termsBtn'; });
  await page.keyboard.press('Enter');
  await page.waitForSelector('#terms:not([hidden])');
  assert.strictEqual(await focusedId(), 'declineBtn', 'Decline is the default');
  await page.screenshot({ path: path.join(OUT, 'terms.png') });
  await page.keyboard.press('Enter');
  await page.waitForSelector('#terms', { state: 'hidden' });
  assert.ok(!fs.existsSync(path.join(path.dirname(target), '.config', 'ookla', 'speedtest-cli.json')), 'nothing accepted after Decline');

  // 4. Review again, move to "I accept", OK -> test runs with the accept flags
  await page.keyboard.press('Enter');
  await page.waitForSelector('#terms:not([hidden])');
  await page.keyboard.press('ArrowLeft');
  assert.strictEqual(await focusedId(), 'acceptBtn');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#results:not([hidden])', { timeout: 30000 });
  assert.match(await page.locator('#console').innerText(), /--accept-license --accept-gdpr/);
  assert.ok(fs.existsSync(path.join(path.dirname(target), '.config', 'ookla', 'speedtest-cli.json')));

  // 5. Next run needs no prompt
  await page.keyboard.press('Enter'); // "Run again"
  await page.waitForSelector('#results:not([hidden])', { timeout: 30000 });
  assert.doesNotMatch(await page.locator('#console').innerText(), /--accept-license/);
  assert.deepStrictEqual(pageErrors, []);
});
