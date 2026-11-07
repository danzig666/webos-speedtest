'use strict';
/*
 * Downloads and installs the official Ookla Speedtest CLI on the TV.
 *
 *  - fixed HTTPS URL per CPU (32-bit ARM -> the "armel" build)
 *  - the archive must match a pinned SHA-256 before anything is extracted
 *  - only the "speedtest" member is extracted (a tiny tar reader, no shell,
 *    no external tar), written next to the target and renamed into place
 *  - the result is checked with the same ELF/--version preflight as a test
 *
 * The binary goes to the runner's fixed path (/media/developer/speedtest/
 * speedtest by default), never into the app package. Licence acceptance is
 * NOT part of installing.
 */

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');
var https = require('https');
var http = require('http');
var urlLib = require('url');

var BASE = 'https://install.speedtest.net/app/cli/';
var PACKAGES = {
  arm: { file: 'ookla-speedtest-1.2.0-linux-armel.tgz', sha256: '629a455a2879224bd0dbd4b36d8c721dda540717937e4660b4d2c966029466bf' },
  arm64: { file: 'ookla-speedtest-1.2.0-linux-aarch64.tgz', sha256: '3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3' },
  x64: { file: 'ookla-speedtest-1.2.0-linux-x86_64.tgz', sha256: '5690596c54ff9bed63fa3732f818a05dbc2db19ad36ed68f21ca5f64d5cfeeb7' }
};
var MAX_BYTES = 20 * 1024 * 1024;

function packageFor(arch) {
  var p = PACKAGES[arch];
  if (!p) return null;
  return { url: BASE + p.file, sha256: p.sha256, file: p.file };
}

function err(code, message, hint) {
  var e = { code: code, message: message };
  if (hint) e.hint = hint;
  return e;
}

/** Return the contents of the first regular file named `want` in a tar buffer. */
function extractFromTar(buf, want) {
  var off = 0;
  var longName = null;
  while (off + 512 <= buf.length) {
    var hdr = buf.slice(off, off + 512);
    if (hdr.every(function (b) { return b === 0; })) break;
    var str = function (a, b) { var s = hdr.slice(a, b).toString('utf8'); var z = s.indexOf('\0'); return z === -1 ? s : s.slice(0, z); };
    var name = str(0, 100);
    var prefix = str(345, 500);
    var sizeField = str(124, 136).trim();
    var size = parseInt(sizeField || '0', 8);
    if (isNaN(size) || size < 0) throw new Error('corrupt tar header');
    var type = String.fromCharCode(hdr[156] || 48);
    var dataStart = off + 512;
    if (dataStart + size > buf.length) throw new Error('truncated tar archive');
    var data = buf.slice(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x' || type === 'g') continue;
    var full = longName || (prefix ? prefix + '/' + name : name);
    longName = null;
    if ((type === '0' || type === '\0') && path.posix.basename(full) === want) return data;
  }
  return null;
}

function Installer(runner, config) {
  this.runner = runner;
  config = config || {};
  var arch = config.arch || runner.config.arch;
  var pkg = packageFor(arch);
  this.config = {
    arch: arch,
    url: config.url || process.env.SPEEDTEST_DOWNLOAD_URL || (pkg && pkg.url),
    sha256: config.sha256 || process.env.SPEEDTEST_DOWNLOAD_SHA256 || (pkg && pkg.sha256),
    timeoutMs: config.timeoutMs || 3 * 60 * 1000,
    verify: config.verify || null // test hook: function(binary, cb(err, versionText))
  };
  this.active = null;
}

Installer.prototype.isActive = function () { return !!this.active; };

Installer.prototype.cancel = function () {
  if (!this.active) return false;
  this.active.cancelled = true;
  if (this.active.req) this.active.req.destroy(new Error('cancelled'));
  return true;
};

/**
 * Events: {event:'install-started', url, target}, {event:'download', received, total},
 * {event:'verifying'}, final {event:'install-done', ok, version?, error?}
 */
Installer.prototype.install = function (onEvent) {
  var self = this;
  if (this.active || this.runner.isActive()) {
    throw err('BUSY', 'A test or download is already running.', 'Wait for it to finish or press Cancel.');
  }
  var cfg = this.config;
  var target = this.runner.config.binary;
  var job = { cancelled: false, req: null };
  this.active = job;
  this.runner.blockedBy = 'install';

  var done = false;
  var timer = setTimeout(function () { finish(err('DOWNLOAD_TIMEOUT', 'The download took too long.', 'Check the TV\'s internet connection and try again.')); }, cfg.timeoutMs);
  function emit(e) { try { onEvent(e); } catch (x) { /* ignore */ } }
  function finish(error, version) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    self.active = null;
    self.runner.blockedBy = null;
    if (job.cancelled && !version) error = err('CANCELLED', 'Download cancelled.');
    var e = { event: 'install-done', ok: !error, target: target };
    if (error) e.error = error; else e.version = version;
    emit(e);
  }

  if (!cfg.url || !cfg.sha256) {
    setImmediate(function () { finish(err('UNSUPPORTED_CPU', 'No official Speedtest CLI build is known for CPU "' + cfg.arch + '".')); });
    return job;
  }
  emit({ event: 'install-started', url: cfg.url, target: target });

  download(cfg.url, job, function (p) { emit({ event: 'download', received: p.received, total: p.total }); }, function (e1, body) {
    if (e1) return finish(job.cancelled ? null : e1);
    emit({ event: 'verifying' });
    var digest = crypto.createHash('sha256').update(body).digest('hex');
    if (digest !== cfg.sha256) {
      return finish(err('CHECKSUM_MISMATCH', 'The downloaded file does not match the expected SHA-256 (got ' + digest.slice(0, 16) + '…). Nothing was installed.',
        'The download may be corrupted or intercepted. Try again later, or install manually (README).'));
    }
    var bin;
    try {
      bin = extractFromTar(zlib.gunzipSync(body), 'speedtest');
    } catch (e2) {
      return finish(err('BAD_ARCHIVE', 'Could not unpack the archive: ' + e2.message));
    }
    if (!bin) return finish(err('BAD_ARCHIVE', 'The archive does not contain a "speedtest" file.'));
    writeBinary(target, bin, function (e3) {
      if (e3) return finish(e3);
      var verify = cfg.verify || function (file, cb) { self.runner.verifyBinary(cb); };
      verify(target, function (e4, version) {
        if (e4) {
          try { fs.unlinkSync(target); } catch (x) { /* ignore */ }
          return finish(e4);
        }
        finish(null, version);
      });
    });
  });
  return job;
};

function writeBinary(target, data, cb) {
  var dir = path.dirname(target);
  var tmp = target + '.download';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, data, { mode: 493 });
    fs.chmodSync(tmp, 493);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ }
    var denied = e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS';
    return cb(err(denied ? 'INSTALL_DENIED' : 'INSTALL_FAILED', 'Cannot write ' + target + ' (' + e.code + ').',
      denied ? 'The jailed service may not write there: use "Elevate service" and try again.' : null));
  }
  cb(null);
}

function download(url, job, onProgress, cb0, redirects) {
  redirects = redirects || 0;
  var called = false;
  var cb = function (a, b) { if (!called) { called = true; cb0(a, b); } };
  var u = urlLib.parse(url);
  var mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
  if (!mod) return cb(err('DOWNLOAD_FAILED', 'Unsupported URL ' + url));
  var req = mod.get(url, { headers: { 'User-Agent': 'webos-speedtest-installer' }, timeout: 30000 }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (redirects >= 5) return cb(err('DOWNLOAD_FAILED', 'Too many redirects.'));
      var next = urlLib.resolve(url, res.headers.location);
      // Never downgrade from https to http.
      if (/^https:/.test(url) && !/^https:/.test(next)) return cb(err('DOWNLOAD_FAILED', 'Refusing insecure redirect to ' + next));
      return download(next, job, onProgress, cb, redirects + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return cb(err('DOWNLOAD_FAILED', 'Download failed: HTTP ' + res.statusCode + ' from ' + u.host + '.', 'Try again later, or install manually (README).'));
    }
    var total = parseInt(res.headers['content-length'] || '0', 10) || null;
    var parts = [];
    var received = 0;
    var lastReport = 0;
    res.on('data', function (c) {
      received += c.length;
      if (received > MAX_BYTES) { req.destroy(new Error('too large')); return; }
      parts.push(c);
      var now = Date.now();
      if (now - lastReport > 150) { lastReport = now; onProgress({ received: received, total: total }); }
    });
    res.on('end', function () {
      if (job.cancelled) return cb(err('CANCELLED', 'Download cancelled.'));
      onProgress({ received: received, total: total });
      cb(null, Buffer.concat(parts));
    });
    res.on('error', function (e) { cb(err('DOWNLOAD_FAILED', 'Download interrupted: ' + e.message)); });
  });
  job.req = req;
  req.on('timeout', function () { req.destroy(new Error('connection timed out')); });
  req.on('error', function (e) {
    if (job.cancelled) return cb(err('CANCELLED', 'Download cancelled.'));
    var msg = e.message === 'too large' ? 'The download is unexpectedly large.' : 'Cannot download from ' + u.host + ': ' + (e.code || e.message) + '.';
    cb(err('DOWNLOAD_FAILED', msg, 'Check the TV\'s internet connection and DNS, then try again.'));
  });
}

module.exports = { Installer: Installer, extractFromTar: extractFromTar, packageFor: packageFor, PACKAGES: PACKAGES };
