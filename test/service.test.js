'use strict';
// Luna-level tests: service.js driven through a fake webos-service.
process.env.SPEEDTEST_SERVICE_TEST = '1';
process.env.MOCK_NODE = process.execPath;
var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');
var os = require('os');
var FakeService = require('./support/fake-webos-service');
var createService = require('../service/service').createService;

var MOCK = path.join(__dirname, 'mock', 'speedtest');
function make() {
  return createService(FakeService, { binary: MOCK, home: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), helperDir: path.join(__dirname, '..', 'service', 'bin') });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

test('services.json lists exactly start and cancel', function () {
  var svc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'service', 'services.json'), 'utf8'));
  assert.deepStrictEqual(svc.services[0].commands.map(function (c) { return c.name; }), ['start', 'cancel']);
  var s = make().service;
  assert.deepStrictEqual(Object.keys(s.methods).sort(), ['cancel', 'start']);
});

test('start requires a subscription', function () {
  var s = make().service;
  var got;
  s.call('start', {}, function (r) { got = r; });
  assert.strictEqual(got.returnValue, false);
  assert.strictEqual(got.errorCode, 'SUBSCRIPTION_REQUIRED');
});

test('subscription streams output then ends; keep-alive released', async function () {
  process.env.MOCK_SCALE = '0.2';
  var made = make();
  var responses = [];
  await new Promise(function (resolve) {
    made.service.call('start', { subscribe: true }, function (r) { responses.push(r); if (r.event === 'exit') resolve(); });
    assert.strictEqual(made.service.activities, 1);
  });
  assert.ok(responses.every(function (r) { return r.returnValue === true; }));
  assert.ok(responses.filter(function (r) { return r.event === 'output'; }).length > 3);
  assert.strictEqual(responses[responses.length - 1].subscribed, false);
  assert.strictEqual(responses[responses.length - 1].code, 0);
  await new Promise(function (r) { setImmediate(r); });
  assert.strictEqual(made.service.activities, 0);
});

test('second subscriber is told BUSY; cancel method stops the run; next start works', async function () {
  process.env.MOCK_SCALE = '1';
  var made = make();
  var pid;
  var done = new Promise(function (resolve) {
    made.service.call('start', { subscribe: true }, function (r) { if (r.event === 'started') pid = r.pid; if (r.event === 'exit') resolve(r); });
  });
  var busy;
  made.service.call('start', { subscribe: true }, function (r) { busy = r; });
  assert.strictEqual(busy.errorCode, 'BUSY');
  await new Promise(function (r) { setTimeout(r, 600); });
  var c;
  made.service.call('cancel', {}, function (r) { c = r; });
  assert.deepStrictEqual(c, { returnValue: true, cancelled: true });
  var exit = await done;
  assert.strictEqual(exit.reason, 'cancelled');
  assert.ok(!alive(pid));
  process.env.MOCK_SCALE = '0.1';
  var exit2 = await new Promise(function (resolve) {
    made.service.call('start', { subscribe: true }, function (r) { if (r.event === 'exit') resolve(r); });
  });
  assert.strictEqual(exit2.code, 0);
});

test('client dropping the subscription (app closed) kills the process', async function () {
  process.env.MOCK_SCALE = '1';
  var made = make();
  var pid;
  var handle = made.service.call('start', { subscribe: true }, function (r) { if (r.event === 'started') pid = r.pid; });
  await new Promise(function (r) { setTimeout(r, 700); });
  assert.ok(pid && alive(pid), 'running');
  handle.cancel(); // what Luna does when the app closes
  var t0 = Date.now();
  while ((made.runner.isActive() || alive(pid)) && Date.now() - t0 < 5000) await new Promise(function (r) { setTimeout(r, 20); });
  assert.strictEqual(made.runner.isActive(), false);
  assert.ok(!alive(pid), 'process gone');
  assert.strictEqual(made.service.activities, 0);
});
