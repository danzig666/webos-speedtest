'use strict';
/*
 * Smoke test of the service on the oldest Node.js we support: webOS 4.x and
 * 5.x ship Node 8.12 for JS services. Written in Node-8 JavaScript only
 * (no node:test, no recursive mkdir, no ?. / ??). Run: node test/compat/node8-smoke.js
 * CI runs it with Node 8.12.0.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');

process.env.SPEEDTEST_SERVICE_TEST = '1';
process.env.MOCK_NODE = process.execPath;
process.env.MOCK_SCALE = '0.2';

var Runner = require('../../service/lib/runner').Runner;
var Installer = require('../../service/lib/installer').Installer;
var FakeService = require('../support/fake-webos-service');
var createService = require('../../service/service').createService;
var makeMockArchive = require('../support/mock-archive');

function step(name) { console.log('ok - ' + name); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

var archive = makeMockArchive();
var server = http.createServer(function (req, res) {
  res.writeHead(200, { 'Content-Length': archive.buf.length });
  res.end(archive.buf);
});

server.listen(0, '127.0.0.1', function () {
  var url = 'http://127.0.0.1:' + server.address().port + '/ookla.tgz';
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-n8-'));
  // two missing levels: exercises the Node-8 mkdir fallback
  var target = path.join(dir, 'media', 'speedtest', 'speedtest');
  var created = createService(FakeService, { binary: target, home: path.dirname(target) },
    { url: url, sha256: archive.sha256, isRoot: function () { return true; } });
  var svc = created.service;

  var events = [];
  svc.call('install', { subscribe: true }, function (r) {
    events.push(r);
    if (r.event !== 'install-done') return;
    assert.strictEqual(r.ok, true, JSON.stringify(r.error));
    assert.ok(/^Speedtest by Ookla 1\.2\.0/.test(r.version));
    assert.strictEqual(fs.statSync(target).mode & 511, 493);
    assert.ok(events.some(function (e) { return e.event === 'download'; }));
    step('install downloads, verifies and installs on ' + process.version);

    var pid = null;
    var outputWhileAlive = 0;
    var cancelled = false;
    svc.call('start', { subscribe: true }, function (e) {
      if (e.event === 'started') pid = e.pid;
      if (e.event === 'output' && pid && alive(pid)) outputWhileAlive++;
      if (e.event === 'output' && !cancelled && e.chunks.some(function (c) { return /Download:/.test(c.d); })) {
        cancelled = true;
        svc.call('cancel', {}, function (c) { assert.strictEqual(c.cancelled, true); });
      }
      if (e.event !== 'exit') return;
      assert.ok(outputWhileAlive > 0, 'output streamed before exit');
      assert.strictEqual(e.reason, 'cancelled');
      setTimeout(function () {
        assert.ok(!alive(pid), 'cancel stopped the process');
        step('test streams output and cancel kills the process');
        svc.call('start', { subscribe: true }, function (e2) {
          if (e2.event !== 'exit') return;
          assert.strictEqual(e2.code, 0);
          step('second test runs to completion');
          // a download that fails to start must not leave the service busy
          var r2 = new Runner({ binary: path.join(dir, 'x', 'speedtest') });
          var inst2 = new Installer(r2, { url: 'http://127.0.0.1:99999/x.tgz', sha256: archive.sha256, isRoot: function () { return true; } });
          inst2.install(function (d) {
            if (d.event !== 'install-done') return;
            assert.strictEqual(d.ok, false);
            assert.strictEqual(inst2.isActive(), false);
            assert.ok(!r2.blockedBy);
            step('failed download start releases the service');
            server.close();
            console.log('node8 smoke: all passed');
            process.exit(0);
          });
        });
      }, 300);
    });
  });
});

setTimeout(function () { console.error('node8 smoke: timed out'); process.exit(1); }, 60000).unref();
