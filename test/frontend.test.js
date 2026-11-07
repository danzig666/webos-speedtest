'use strict';
// Terminal emulator and result parser tests (front-end modules, run in Node).
var test = require('node:test');
var assert = require('node:assert');
var Term = require('../app/js/terminal');
var Results = require('../app/js/results');

function screenFor(chunks, streams) {
  var s = new Term.Screen({ cols: 100 });
  var parsers = { out: new Term.AnsiParser(s), err: new Term.AnsiParser(s, { stream: 'err' }) };
  chunks.forEach(function (c, i) { parsers[(streams && streams[i]) || 'out'].feed(c); });
  return s;
}

test('carriage return redraws the current line in place', function () {
  var s = screenFor(['    Download:    10.00 Mbps [==>   ]  10%', '\r    Download:   200.00 Mbps [=====>]  90%', '\r    Download:   312.47 Mbps (data used: 351.2 MB)\x1b[K\n']);
  assert.strictEqual(s.text(), '    Download:   312.47 Mbps (data used: 351.2 MB)');
});

test('escape sequences split at every possible byte boundary', function () {
  var full = 'a\x1b[1;32mgreen\x1b[0m b\x1b]0;title\x07c\x1b[2Kz\rY';
  var whole = screenFor([full]);
  // ESC[2K clears the line but keeps the cursor column, as on a real terminal
  assert.strictEqual(whole.text(), 'Y        z');
  for (var cut = 0; cut <= full.length; cut++) {
    var s = screenFor([full.slice(0, cut), full.slice(cut)]);
    assert.strictEqual(s.text(), whole.text(), 'cut at ' + cut);
  }
  var s2 = screenFor(['x\x1b[', '1', 'mB', '\x1b[0', 'm.']);
  assert.strictEqual(s2.text(), 'xB.');
  assert.strictEqual(s2.lines[0].styles[1].bold, true);
  assert.strictEqual(s2.lines[0].styles[2].bold, undefined);
});

test('surrogate pair split across chunks', function () {
  var s = screenFor(['ok \ud83d', '\ude80 done']);
  assert.strictEqual(s.text(), 'ok 🚀 done');
});

test('stderr and stdout keep separate parser state', function () {
  // stdout is in the middle of a CSI when a stderr chunk arrives
  var s = screenFor(['A\x1b[3', 'E\n', '1mB\x1b[0m\n'], ['out', 'err', 'out']);
  assert.strictEqual(s.text(), 'AE\nB');
  assert.strictEqual(s.lines[0].styles[1].stream, 'err');
  assert.strictEqual(s.lines[1].styles[0].fg, 'red');
});

test('cursor movement, erase, tabs, backspace', function () {
  var s = screenFor(['line1\nline2\x1b[1A\rLINE\x1b[1B\r\x1b[Kx\tT\bt']);
  assert.strictEqual(s.text(), 'LINE1\nx       t');
});

test('long lines wrap at the column limit', function () {
  var s = new Term.Screen({ cols: 10 });
  new Term.AnsiParser(s).feed('0123456789abc');
  assert.strictEqual(s.text(), '0123456789\nabc');
});

var REAL_LAYOUT = [
  '',
  '   Speedtest by Ookla',
  '',
  '      Server: Mockville Fiber - Mockville (id: 4242)',
  '         ISP: Example Broadband',
  'Idle Latency:     4.21 ms   (jitter: 0.32ms, low: 3.95ms, high: 4.80ms)',
  '    Download:   312.47 Mbps (data used: 351.2 MB)',
  '                 12.50 ms   (jitter: 1.20ms, low: 9.50ms, high: 21.50ms)',
  '      Upload:    48.91 Mbps (data used: 62.0 MB)',
  '                 18.75 ms   (jitter: 1.20ms, low: 15.75ms, high: 27.75ms)',
  ' Packet Loss:     0.0%',
  '  Result URL: https://www.speedtest.net/result/c/0b6e3f6c-6c0d-4b8e-9a51-000000004242'
].join('\n');

test('summary parser', function () {
  var r = Results.parseSummary(REAL_LAYOUT);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.server, 'Mockville Fiber - Mockville');
  assert.strictEqual(r.serverId, '4242');
  assert.strictEqual(r.isp, 'Example Broadband');
  assert.deepStrictEqual(r.idle, { latency: 4.21, jitter: 0.32, low: 3.95, high: 4.8 });
  assert.strictEqual(r.download.mbps, 312.47);
  assert.strictEqual(r.download.dataUsed, '351.2 MB');
  assert.strictEqual(r.download.latency.latency, 12.5);
  assert.strictEqual(r.upload.value, 48.91);
  assert.strictEqual(r.upload.latency.high, 27.75);
  assert.strictEqual(r.packetLoss, 0);
  assert.match(r.resultUrl, /\/result\/c\/0b6e3f6c/);
});

test('summary parser: packet loss not available, failed phase', function () {
  var r = Results.parseSummary('    Download:   FAILED\n Packet Loss: Not available.\n');
  assert.strictEqual(r.packetLoss, null);
  assert.strictEqual(r.packetLossText, 'Not available.');
  assert.strictEqual(r.complete, false);
});

test('progress parser and units', function () {
  var p = Results.parseProgress('    Download:   123.45 Mbps [=======>      ]  45%  - latency: 13.10 ms');
  assert.deepStrictEqual([p.phase, p.mbps, p.percent, p.latency], ['download', 123.45, 45, 13.1]);
  assert.strictEqual(Results.parseProgress('Idle Latency:     -   ').phase, 'latency');
  assert.strictEqual(Results.parseProgress('    Download:   312.47 Mbps (data used: 351.2 MB)'), null);
  assert.strictEqual(Results.toMbps(1, 'Gbps'), 1000);
  assert.strictEqual(Results.toMbps(10, 'MB/s'), 80);
  assert.strictEqual(Math.round(Results.toMbps(1, 'MiB/s') * 1000) / 1000, 8.389);
  assert.strictEqual(Results.toMbps(500, 'kbps'), 0.5);
});
