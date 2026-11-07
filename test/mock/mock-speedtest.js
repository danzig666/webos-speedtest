'use strict';
/*
 * Mock of `speedtest --format=human-readable --progress=yes`.
 * Mimics the real 1.2.0 layout (strings taken from the official binary),
 * plus deliberately awkward output for the terminal pipeline:
 *   - carriage-return redraws (spinner, progress bars)
 *   - ANSI sequences split across writes, ESC[K line erase
 *   - UTF-8 characters split across writes
 *   - stderr interleaved with stdout
 *
 * MOCK_MODE  = success | fail | license | stall   (default success)
 * MOCK_SCALE = delay multiplier (default 1; 0.2 = 5x faster)
 * MOCK_IGNORE_TERM=1  ignore SIGTERM (tests SIGKILL escalation)
 * MOCK_ARGS_FILE=path write argv + pid there
 */
var fs = require('fs');
var mode = process.env.MOCK_MODE || 'success';
var scale = Number(process.env.MOCK_SCALE || 1);
var args = process.argv.slice(2);

if (process.env.MOCK_ARGS_FILE) {
  fs.writeFileSync(process.env.MOCK_ARGS_FILE, JSON.stringify({ pid: process.pid, args: args, home: process.env.HOME, tty: !!process.stdout.isTTY }));
}
if (args[0] === '--version') {
  process.stdout.write('Speedtest by Ookla 1.2.0.84 (mock) Linux/' + process.arch + '\n\nThe official command line client for testing the speed and performance\nof your internet connection.\n');
  process.exit(0);
}
if (process.env.MOCK_IGNORE_TERM === '1') process.on('SIGTERM', function () {});

var steps = [];
function out(s) { steps.push(function () { process.stdout.write(s); }); }
function err(s) { steps.push(function () { process.stderr.write(s); }); }
function bytes(arr) { steps.push(function () { process.stdout.write(Buffer.from(arr)); }); }
function wait(ms) { steps.push(ms * scale); }

function bar(pct) {
  var width = 20, full = Math.round(pct / 100 * width);
  return '[' + new Array(full + 1).join('=') + (full < width ? '>' : '') + new Array(Math.max(0, width - full)).join(' ') + ']';
}
function pad(s, n) { while (s.length < n) s = ' ' + s; return s; }

function phase(label, finalSpeed, used, lat) {
  for (var p = 0; p <= 100; p += 10) {
    var speed = (finalSpeed * (0.6 + 0.4 * p / 100) * (0.9 + 0.2 * Math.sin(p))).toFixed(2);
    out('\r' + pad(label, 12) + ': ' + pad(speed + ' Mbps', 13) + ' ' + bar(p) + ' ' + pad(String(p), 3) + '%  - latency: ' + (lat + p / 50).toFixed(2) + ' ms');
    wait(120);
    if (mode === 'fail' && label === 'Download' && p === 40) {
      err('\n[error] Error: [0] Cannot read: Resource temporarily unavailable\n');
      err('[error] Download test failed: Connection reset by peer\n');
      steps.push(function () { process.exit(2); });
      return;
    }
  }
  out('\r' + pad(label, 12) + ': ' + pad(finalSpeed.toFixed(2) + ' Mbps', 13) + ' (data used: ' + used + ')' + pad('', 50) + '\x1b[K\n');
  out(pad('', 12) + '  ' + pad(lat.toFixed(2) + ' ms', 13) + '   (jitter: 1.20ms, low: ' + (lat - 3).toFixed(2) + 'ms, high: ' + (lat + 9).toFixed(2) + 'ms)\n');
}

if (mode === 'noservers') {
  // Exactly what the real 1.2.0 CLI printed when test servers were unreachable.
  out('\n   Speedtest by Ookla\n\n');
  for (var n = 0; n < 4; n++) { wait(100); err('[error] Error: [111] Connection refused\n'); }
  err('[error] Server Selection - Failed to find a working test server. (NoServers)\n');
  steps.push(function () { process.exit(2); });
} else if (mode === 'license') {
  err('==============================================================================\n\nYou may only use this Speedtest software and information generated\nfrom it for personal, non-commercial use, through a command line\ninterface on a personal computer. ...\n\n');
  err('To accept the message please run speedtest interactively or use the following: \n\n    speedtest --accept-license\n\n');
  if (process.stdout.isTTY) {
    // Like the real 1.2.0 CLI on a terminal: re-prompt forever on EOF.
    steps.push(function () {
      setInterval(function () { process.stdout.write('Do you accept the license? [type YES to accept]: '); }, 5);
    });
    steps.push(1e9);
  }
  wait(50);
  err('\nLicense not accepted. Exiting.\n');
  steps.push(function () { process.exit(1); });
} else {
  out('\n   ');
  out('\x1b[');            // ANSI sequence split across two writes
  wait(30);
  out('1mSpeedtest by Ookla\x1b[0');
  wait(30);
  out('m\n\n');
  out('      Server: Mockville Fiber - Mockville (id: 4242)\n');
  wait(150);
  out('         ISP: Example Broadband\n');
  err('[warning] mock: this line was written to stderr\n');
  out('     Comment: UTF-8 check ');
  bytes([0xe2, 0x9c]);       // first two bytes of U+2713 CHECK MARK
  wait(40);
  bytes([0x93, 0x20, 0xc2]); // last byte, space, first byte of µ
  wait(40);
  bytes([0xb5]);
  out('s \x1b[32mgreen\x1b[39m ok\n');
  var spin = '-\\|/';
  for (var i = 0; i < 8; i++) { out('\rIdle Latency:     ' + spin[i % 4] + '   '); wait(100); }
  if (mode === 'stall') {
    steps.push(function () { setInterval(function () {}, 1e6); });
    steps.push(1e9);
  }
  out('\rIdle Latency:     4.21 ms   (jitter: 0.32ms, low: 3.95ms, high: 4.80ms)\n');
  phase('Download', 312.47, '351.2 MB', 12.5);
  phase('Upload', 48.91, '62.0 MB', 18.75);
  out(' Packet Loss:     0.0%\n');
  out('  Result URL: https://www.speedtest.net/result/c/0b6e3f6c-6c0d-4b8e-9a51-000000004242\n');
  steps.push(function () { process.exit(0); });
}

(function next() {
  var s = steps.shift();
  if (s === undefined) return;
  if (typeof s === 'number') return setTimeout(next, s);
  s();
  setImmediate(next);
})();
