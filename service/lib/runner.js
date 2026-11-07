'use strict';
/*
 * Process manager for the Ookla Speedtest CLI.
 *
 * Kept free of any webOS dependency so it can be tested on a desktop with a
 * mock CLI. The Luna glue lives in ../service.js.
 *
 * Security properties:
 *   - the binary path and argument list are fixed at service start;
 *     callers can only choose pipe vs. pty transport
 *   - no shell is involved anywhere (spawn with an argv array)
 *   - stdin is /dev/null (pipe mode) or receives EOF (pty mode), so licence
 *     prompts can never be answered from the app
 *   - one run at a time; every run has an overall and a stall timeout
 *
 * Syntax is kept to what old webOS Node runtimes understand (no ?. / ??).
 */

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var StringDecoder = require('string_decoder').StringDecoder;

var DEFAULT_BINARY = '/media/developer/speedtest/speedtest';
var FIXED_ARGS = ['--format=human-readable', '--progress=yes'];
var ACCEPT_ARGS = ['--accept-license', '--accept-gdpr'];
var PTY_COLS = 100;
var PTY_ROWS = 30;

var ELF_MACHINES = { 3: 'x86 (32-bit)', 8: 'MIPS', 20: 'PowerPC', 40: 'ARM (32-bit)', 62: 'x86-64', 183: 'ARM64 (aarch64)', 243: 'RISC-V' };
// Which ELF e_machine values can run on the CPU Node reports.
var COMPATIBLE_MACHINES = { arm: [40], arm64: [183, 40], x64: [62], ia32: [3] };
var PTY_HELPERS = { arm: 'ptyrun-armv7', arm64: 'ptyrun-aarch64', x64: 'ptyrun-x86_64' };

function defaultConfig() {
  var binary = process.env.SPEEDTEST_BIN || DEFAULT_BINARY;
  return {
    binary: binary,
    // HOME decides where the CLI keeps its licence/GDPR acceptance
    // ($HOME/.config/ookla/speedtest-cli.json). It must match the HOME used
    // when the user accepted the licence over SSH (see README).
    home: process.env.SPEEDTEST_HOME || path.dirname(binary),
    args: FIXED_ARGS.slice(),
    helperDir: process.env.SPEEDTEST_PTY_DIR || path.join(__dirname, '..', 'bin'),
    totalTimeoutMs: Number(process.env.SPEEDTEST_TIMEOUT_MS) || 4 * 60 * 1000,
    stallTimeoutMs: Number(process.env.SPEEDTEST_STALL_MS) || 60 * 1000,
    versionTimeoutMs: 20 * 1000,
    killGraceMs: 3000,
    flushMs: 40,
    maxOutputBytes: 2 * 1024 * 1024,
    arch: process.arch
  };
}

function stripAnsi(s) {
  // CSI, OSC and two-byte escapes; plus carriage-return redraws.
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function lastMeaningfulLine(text) {
  var lines = stripAnsi(text).split(/\r\n|\n/);
  for (var i = lines.length - 1; i >= 0; i--) {
    // Keep only what is visible after the last carriage return.
    var parts = lines[i].split('\r');
    var line = parts[parts.length - 1].trim();
    if (line) return line;
  }
  return '';
}

function makeError(code, message, hint, extra) {
  var e = { code: code, message: message };
  if (hint) e.hint = hint;
  if (extra) for (var k in extra) e[k] = extra[k];
  return e;
}

var INSTALL_HINT = 'Press "Download Speedtest CLI" to install the official build, or install it over SSH (README, "Binary setup").';
var ELEVATE_HINT = 'If the file is there, the jailed service may not be allowed to see it: use "Elevate service" or run elevate-service over SSH (README, "Elevation").';
var LICENSE_HINT = 'Read the terms shown above, then press "Review terms" to accept them in the app,\n' +
  'or accept over SSH:  HOME=<home> <binary>  (type YES at each prompt).';

/* --------------------------------------------------------------------- */

function Runner(config) {
  this.config = Object.assign(defaultConfig(), config || {});
  this.active = null;
  this._nextId = 1;
}

Runner.prototype.isActive = function () {
  return !!this.active;
};

Runner.prototype.status = function () {
  return {
    active: !!this.active,
    runId: this.active ? this.active.id : null,
    binary: this.config.binary,
    uid: typeof process.getuid === 'function' ? process.getuid() : null
  };
};

/**
 * Start a run. Throws {code:'BUSY'} synchronously if one is active.
 * Every other outcome (including preflight failures) arrives through
 * onEvent; the final event always has event === 'exit'.
 */
Runner.prototype.start = function (options, onEvent) {
  if (this.active || this.blockedBy) {
    throw makeError('BUSY', this.active ? 'A speed test is already running.' : 'The Speedtest CLI is being downloaded.', 'Wait for it to finish or press Cancel.');
  }
  var run = new Run(this, this._nextId++, options || {}, onEvent);
  this.active = run;
  run._begin();
  return run;
};

Runner.prototype.cancel = function (reason) {
  if (!this.active) return false;
  return this.active.cancel(reason || 'cancelled');
};

/** Synchronous best-effort kill, for service shutdown. */
Runner.prototype.dispose = function () {
  if (this.active) this.active._killNow('SIGKILL');
};

Runner.prototype._finished = function (run) {
  if (this.active === run) this.active = null;
};

/* --------------------------------------------------------------------- */

function Run(runner, id, options, onEvent) {
  this.runner = runner;
  this.config = runner.config;
  this.id = id;
  this.mode = options.pty ? 'pty' : 'pipe';
  // Set only after the user pressed "I accept" on the terms shown in the app.
  this.acceptTerms = options.acceptTerms === true;
  this.onEvent = typeof onEvent === 'function' ? onEvent : function () {};
  this.child = null;
  this.state = 'preflight';
  this.cancelReason = null;
  this.seq = 0;
  this.pending = [];
  this.flushTimer = null;
  this.timers = {};
  this.tail = '';
  this.stderrTail = '';
  this.outputBytes = 0;
  this.truncated = false;
  this.startedAt = Date.now();
  this.exitInfo = null;
  this.done = false;
}

Run.prototype._emit = function (evt) {
  evt.runId = this.id;
  evt.seq = this.seq++;
  try {
    this.onEvent(evt);
  } catch (e) {
    /* a broken listener must not break process cleanup */
  }
};

Run.prototype._begin = function () {
  var self = this;
  this._emit({ event: 'accepted', mode: this.mode, binary: this.config.binary, uid: this.runner.status().uid });
  // Defer so the caller can store the run object before any event fires.
  setImmediate(function () {
    self._preflight(function (err, info) {
      if (self.cancelReason) return self._finish({ ran: false, reason: self.cancelReason });
      if (err) return self._finish({ ran: false, reason: 'error', error: err });
      self._emit({ event: 'version', text: info.version });
      self._spawn();
    });
  });
};

/** Shared binary check: exists, readable, right CPU, executable, --version works. */
function preflightBinary(cfg, cb) {
  var bin = cfg.binary;
  fs.stat(bin, function (err, st) {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return cb(makeError('BINARY_MISSING', 'Speedtest CLI not found at ' + bin + '.', INSTALL_HINT + '\n' + ELEVATE_HINT));
      }
      return cb(makeError('BINARY_NO_ACCESS', 'Cannot access ' + bin + ' (' + err.code + ').', ELEVATE_HINT));
    }
    if (!st.isFile()) {
      return cb(makeError('BINARY_INVALID', bin + ' is not a regular file.', INSTALL_HINT));
    }
    readHead(bin, function (err2, head) {
      if (err2) return cb(makeError('BINARY_NO_ACCESS', 'Cannot read ' + bin + ' (' + err2.code + ').', ELEVATE_HINT));
      var compat = checkExecutableFormat(head, cfg.arch);
      if (compat) return cb(compat);
      fs.access(bin, fs.constants ? fs.constants.X_OK : 1, function (err3) {
        if (err3) {
          return cb(makeError('BINARY_NOT_EXECUTABLE', bin + ' is not executable.', 'Run over SSH:  chmod 755 ' + bin));
        }
        runVersion(cfg, cb);
      });
    });
  });
}

Runner.prototype.verifyBinary = function (cb) {
  preflightBinary(this.config, cb);
};

Run.prototype._preflight = function (cb) {
  var cfg = this.config;
  var mode = this.mode;
  preflightBinary(cfg, function (err, version) {
    if (err) return cb(err);
    var helper = null;
    if (mode === 'pty') {
      var name = PTY_HELPERS[cfg.arch];
      helper = name ? path.join(cfg.helperDir, name) : null;
      if (!helper || !fs.existsSync(helper)) {
        return cb(makeError('PTY_UNAVAILABLE', 'No pseudo-terminal helper for CPU "' + cfg.arch + '".', 'Switch the transport back to "pipe".'));
      }
      try { fs.chmodSync(helper, 493); } catch (e) { /* read-only install: rely on packaged mode */ }
    }
    cb(null, { version: version, helper: helper });
  });
};

function readHead(file, cb) {
  fs.open(file, 'r', function (err, fd) {
    if (err) return cb(err);
    var buf = Buffer.alloc(64);
    fs.read(fd, buf, 0, 64, 0, function (err2, n) {
      fs.close(fd, function () {});
      if (err2) return cb(err2);
      cb(null, buf.slice(0, n));
    });
  });
}

function checkExecutableFormat(head, arch) {
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return null; // "#!" script (mock CLI)
  if (head.length < 20 || head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) {
    return makeError('BINARY_INCOMPATIBLE', 'The file is not a Linux executable (maybe the .tgz was not extracted?).',
      'Download ookla-speedtest-1.2.0-linux-armel.tgz and extract the "speedtest" file from it.');
  }
  var little = head[5] === 1;
  var machine = little ? head.readUInt16LE(18) : head.readUInt16BE(18);
  var ok = COMPATIBLE_MACHINES[arch];
  if (ok && ok.indexOf(machine) === -1) {
    var got = ELF_MACHINES[machine] || ('machine ' + machine);
    return makeError('BINARY_INCOMPATIBLE', 'This speedtest build is for ' + got + ', but the TV CPU is ' + arch + '.',
      'Use the official Linux "armel" build (ookla-speedtest-1.2.0-linux-armel.tgz).', { elfMachine: machine });
  }
  return null;
}

function childEnv(cfg, pty) {
  var env = {
    HOME: cfg.home,
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    COLUMNS: String(PTY_COLS)
  };
  env.TERM = pty ? 'xterm-256color' : 'dumb';
  // Keep a proxy configured for the service (rare on a TV, used in CI), and
  // let the test-suite tune its mock CLI. Nothing else is inherited.
  for (var k in process.env) {
    if (k.indexOf('MOCK_') === 0 || /^(https?_proxy|no_proxy)$/i.test(k)) env[k] = process.env[k];
  }
  return env;
}

function runVersion(cfg, cb) {
  var done = false;
  var child;
  try {
    child = childProcess.execFile(cfg.binary, ['--version'], {
      cwd: cfg.home && fs.existsSync(cfg.home) ? cfg.home : '/',
      env: childEnv(cfg, false),
      timeout: cfg.versionTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024
    }, function (err, stdout, stderr) {
      if (done) return;
      done = true;
      if (err) return cb(classifySpawnError(err, cfg, String(stderr || '') + String(stdout || '')));
      var text = String(stdout).split('\n')[0].trim();
      cb(null, text || 'unknown version');
    });
  } catch (e) {
    done = true;
    return cb(classifySpawnError(e, cfg, ''));
  }
  if (child && child.stdin) child.stdin.end();
}

function classifySpawnError(err, cfg, output) {
  var bin = cfg.binary;
  if (err.code === 'ENOEXEC' || err.errno === 'ENOEXEC') {
    return makeError('BINARY_INCOMPATIBLE', 'The kernel refused to run ' + bin + ' (wrong CPU type or corrupt file).',
      'Re-download the Linux "armel" build and extract it again.');
  }
  if (err.code === 'ENOENT') {
    return makeError('BINARY_MISSING', 'Speedtest CLI not found at ' + bin + '.', INSTALL_HINT + '\n' + ELEVATE_HINT);
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return makeError('BINARY_NOT_EXECUTABLE', 'Permission denied running ' + bin + '.', 'chmod 755 ' + bin + '\n' + ELEVATE_HINT);
  }
  if (err.killed) {
    return makeError('BINARY_BROKEN', bin + ' --version did not finish.', 'The file may be damaged or for another CPU; re-download the armel build.');
  }
  var line = lastMeaningfulLine(output);
  return makeError('BINARY_BROKEN', bin + ' --version failed' + (typeof err.code === 'number' ? ' (exit ' + err.code + ')' : '') + (line ? ': ' + line : '.'),
    'Run "' + bin + ' --version" over SSH to see the full error.');
}

Run.prototype._spawn = function () {
  var self = this;
  var cfg = this.config;
  var file = cfg.binary;
  var args = cfg.args.slice();
  if (this.acceptTerms) args = args.concat(ACCEPT_ARGS);
  if (this.mode === 'pty') {
    args = ['--cols', String(PTY_COLS), '--rows', String(PTY_ROWS), '--', file].concat(args);
    file = path.join(cfg.helperDir, PTY_HELPERS[cfg.arch]);
  }
  var child;
  try {
    child = childProcess.spawn(file, args, {
      cwd: fs.existsSync(cfg.home) ? cfg.home : '/',
      env: childEnv(cfg, this.mode === 'pty'),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true // own process group, so cancel reaches every descendant
    });
  } catch (e) {
    return this._finish({ ran: false, reason: 'error', error: classifySpawnError(e, cfg, '') });
  }
  this.child = child;
  this.state = 'running';

  var decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
  child.stdout.on('data', function (b) { self._onData('out', decoders.out.write(b), b.length); });
  child.stderr.on('data', function (b) { self._onData('err', decoders.err.write(b), b.length); });

  child.on('error', function (err) {
    self._spawnError = err;
  });
  child.on('exit', function (code, signal) {
    self.exitInfo = { code: code, signal: signal };
    // If a grandchild keeps the pipes open, don't wait forever for 'close'.
    self.timers.closeWait = setTimeout(function () { self._onClose(decoders); }, 2000);
  });
  child.on('close', function (code, signal) {
    if (!self.exitInfo) self.exitInfo = { code: code, signal: signal };
    self._onClose(decoders);
  });

  this._armTimers();
  if (child.pid) {
    this._emit({ event: 'started', pid: child.pid, mode: this.mode, args: this.acceptTerms ? cfg.args.concat(ACCEPT_ARGS) : cfg.args });
  }
};

Run.prototype._armTimers = function () {
  var self = this;
  this.timers.total = setTimeout(function () { self.cancel('timeout'); }, this.config.totalTimeoutMs);
  this._resetStall();
};

Run.prototype._resetStall = function () {
  var self = this;
  if (this.timers.stall) clearTimeout(this.timers.stall);
  if (this.state !== 'running') return;
  this.timers.stall = setTimeout(function () { self.cancel('stalled'); }, this.config.stallTimeoutMs);
};

Run.prototype._onData = function (stream, text, nbytes, raw) {
  this._resetStall();
  if (!text) return;
  if (raw) return this._queue(stream, text, nbytes);
  if (this.cancelReason === 'license') return; // drop the repeated prompts
  this.tail = (this.tail + text).slice(-8192);
  if (stream === 'err') this.stderrTail = (this.stderrTail + text).slice(-4096);
  // On a TTY, Ookla 1.2.0 prompts for licence/GDPR consent and, with no
  // answer, repeats the prompt forever. Consent is only given over SSH, so
  // stop at the first prompt.
  if (!this.cancelReason && /\[type YES to accept\]/.test(this.tail)) {
    this._onData(stream, text.replace(/^([\s\S]*?\[type YES to accept\]: ?)[\s\S]*$/, '$1') + '\r\n', 0, true);
    this.cancel('license');
    return;
  }
  this._queue(stream, text, nbytes);
};

Run.prototype._queue = function (stream, text, nbytes) {
  if (this.truncated) return;
  this.outputBytes += nbytes;
  if (this.outputBytes > this.config.maxOutputBytes) {
    this.truncated = true;
    text = '\r\n[output truncated]\r\n';
  }
  var last = this.pending[this.pending.length - 1];
  if (last && last.s === stream) last.d += text;
  else this.pending.push({ s: stream, d: text });
  this._scheduleFlush();
};

Run.prototype._scheduleFlush = function () {
  var self = this;
  if (this.flushTimer) return;
  this.flushTimer = setTimeout(function () { self.flushTimer = null; self._flush(); }, this.config.flushMs);
};

Run.prototype._flush = function () {
  if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  if (!this.pending.length) return;
  var chunks = this.pending;
  this.pending = [];
  this._emit({ event: 'output', chunks: chunks });
};

Run.prototype.cancel = function (reason) {
  if (this.done) return false;
  if (!this.cancelReason) this.cancelReason = reason || 'cancelled';
  if (this.state === 'preflight') return true; // _begin finishes it
  if (this.state !== 'running' && this.state !== 'stopping') return false;
  this.state = 'stopping';
  if (this.timers.stall) clearTimeout(this.timers.stall);
  this._emit({ event: 'stopping', reason: this.cancelReason });
  this._killNow('SIGTERM');
  var self = this;
  this.timers.kill = setTimeout(function () { self._killNow('SIGKILL'); }, this.config.killGraceMs);
  return true;
};

Run.prototype._killNow = function (sig) {
  var child = this.child;
  if (!child || !child.pid || this.exitInfo) return;
  try {
    process.kill(-child.pid, sig); // the whole process group
  } catch (e) {
    try { child.kill(sig); } catch (e2) { /* already gone */ }
  }
};

Run.prototype._onClose = function (decoders) {
  if (this.done || this.closed) return;
  this.closed = true;
  var restOut = decoders.out.end();
  var restErr = decoders.err.end();
  if (restOut) this._onData('out', restOut, 0);
  if (restErr) this._onData('err', restErr, 0);
  this._flush();
  var info = this.exitInfo || { code: null, signal: null };
  var result = { ran: true, code: info.code, signal: info.signal, reason: this.cancelReason || 'exit' };
  if (this._spawnError) {
    result.ran = false;
    result.reason = 'error';
    result.error = classifySpawnError(this._spawnError, this.config, '');
  } else if (!this.cancelReason && info.code !== 0) {
    result.reason = 'failed';
    result.error = this._classifyFailure(info);
  } else if (this.cancelReason === 'license') {
    result.reason = 'failed';
    result.error = this._classifyFailure(info);
  } else if (this.cancelReason === 'timeout') {
    result.error = makeError('TIMEOUT', 'The test took longer than ' + Math.round(this.config.totalTimeoutMs / 1000) + ' s and was stopped.', 'Check the network connection and try again.');
  } else if (this.cancelReason === 'stalled') {
    result.error = makeError('STALLED', 'No output for ' + Math.round(this.config.stallTimeoutMs / 1000) + ' s; the test was stopped.', 'Try again; if it keeps happening try the other transport (pipe/pty).');
  }
  this._finish(result);
};

Run.prototype._classifyFailure = function (info) {
  var cfg = this.config;
  var plain = stripAnsi(this.tail);
  if (this.cancelReason === 'license' || /License not accepted|accept-license|accept-gdpr|GDPR|type YES to accept/i.test(plain)) {
    return makeError('LICENSE_REQUIRED', 'Ookla\'s licence / privacy terms have not been accepted for HOME=' + cfg.home + '.',
      LICENSE_HINT.replace('<home>', cfg.home).replace('<binary>', cfg.binary));
  }
  if (this.mode === 'pty' && info.code === 125) {
    return makeError('PTY_UNAVAILABLE', lastMeaningfulLine(this.stderrTail) || 'Could not allocate a pseudo-terminal.',
      'PTY mode needs the service to run as root (elevate it), or switch back to pipe mode.');
  }
  if (this.mode === 'pty' && (info.code === 126 || info.code === 127) && /ptyrun: exec failed/.test(plain)) {
    return makeError('BINARY_EXEC_FAILED', lastMeaningfulLine(this.stderrTail), INSTALL_HINT);
  }
  var line = lastMeaningfulLine(this.stderrTail) || lastMeaningfulLine(this.tail);
  // Messages seen from the real 1.2.0 CLI when it cannot reach Ookla.
  if (/NoServers|Failed to find a working test server|Cannot open socket|Connection refused|Could not retrieve or read configuration|Cannot retrieve configuration|resolve host|Network is unreachable/i.test(plain)) {
    return makeError('NETWORK_ERROR', 'The CLI could not reach Ookla\'s servers' + (line ? ': ' + line : '.'),
      'Check the TV\'s internet connection, DNS, firewall/VPN or Pi-hole style blocking of *.speedtest.net / ookla.com, then try again.');
  }
  var how = info.signal ? 'was killed by ' + info.signal : 'exited with code ' + info.code;
  return makeError('TEST_FAILED', 'speedtest ' + how + (line ? ': ' + line : '.'), 'See the console output above for details.');
};

Run.prototype._finish = function (result) {
  if (this.done) return;
  this.done = true;
  this.state = 'done';
  for (var k in this.timers) clearTimeout(this.timers[k]);
  this._flush();
  result.event = 'exit';
  result.mode = this.mode;
  result.durationMs = Date.now() - this.startedAt;
  if (this.truncated) result.truncated = true;
  this.runner._finished(this);
  this._emit(result);
};

module.exports = {
  Runner: Runner,
  defaultConfig: defaultConfig,
  stripAnsi: stripAnsi,
  checkExecutableFormat: checkExecutableFormat,
  FIXED_ARGS: FIXED_ARGS,
  ACCEPT_ARGS: ACCEPT_ARGS,
  DEFAULT_BINARY: DEFAULT_BINARY
};
