#!/usr/bin/env node
'use strict';
/*
 * Desktop harness: serves app/ and runs the real service/service.js behind a
 * PalmServiceBridge shim (Server-Sent Events), using the mock CLI by default.
 *
 *   node tools/dev-server.js [port]         -> http://localhost:8099/
 *   SPEEDTEST_BIN=/path/to/speedtest node tools/dev-server.js
 *   MOCK_MODE=fail|license|stall MOCK_SCALE=0.5 ...
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');

var ROOT = path.join(__dirname, '..');
process.env.SPEEDTEST_SERVICE_TEST = '1';
process.env.MOCK_NODE = process.env.MOCK_NODE || process.execPath;
var FakeService = require('../test/support/fake-webos-service');
var created = require('../service/service').createService(FakeService, {
  binary: process.env.SPEEDTEST_BIN || path.join(ROOT, 'test', 'mock', 'speedtest'),
  home: process.env.SPEEDTEST_HOME || fs.mkdtempSync(path.join(require('os').tmpdir(), 'st-dev-')),
  helperDir: path.join(ROOT, 'service', 'bin')
});
var service = created.service;
var SERVICE_URI = 'luna://' + service.name + '/';

var TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

var BRIDGE = function () {
  /* PalmServiceBridge shim for desktop browsers */
  window.PalmServiceBridge = function () { this.es = null; this.onservicecallback = null; };
  window.PalmServiceBridge.prototype.call = function (uri, params) {
    var self = this;
    var es = new EventSource('/__dev/luna?uri=' + encodeURIComponent(uri) + '&params=' + encodeURIComponent(params));
    this.es = es;
    es.onmessage = function (e) { if (self.onservicecallback) self.onservicecallback(e.data); };
    es.addEventListener('end', function () { es.close(); });
    es.onerror = function () { es.close(); };
  };
  window.PalmServiceBridge.prototype.cancel = function () { if (this.es) this.es.close(); };
  window.close = function () { document.title = 'closed'; document.body.setAttribute('data-closed', '1'); };
};

function luna(req, res, q) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  var params = {};
  try { params = JSON.parse(q.params || '{}'); } catch (e) { /* empty */ }
  var ended = false;
  function send(obj) { if (!ended) res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  function end() { if (ended) return; ended = true; res.write('event: end\ndata: {}\n\n'); res.end(); }
  if (q.uri.indexOf(SERVICE_URI) !== 0) {
    send({ returnValue: false, errorText: 'Not available in the dev harness: ' + q.uri });
    return end();
  }
  var handle;
  try {
    handle = service.call(q.uri.slice(SERVICE_URI.length), params, function (r) {
      send(r);
      if (!params.subscribe) setImmediate(end);
    });
  } catch (e) {
    send({ returnValue: false, errorText: e.message });
    return end();
  }
  handle.message.onEnd = function () { setImmediate(end); };
  req.on('close', function () { ended = true; handle.cancel(); });
}

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  if (u.pathname === '/__dev/luna') return luna(req, res, u.query);
  if (u.pathname === '/__dev/bridge.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'] });
    return res.end('(' + BRIDGE.toString() + ')();');
  }
  if (u.pathname === '/__dev/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(created.runner.status()));
  }
  var file = path.join(ROOT, 'app', path.normalize(u.pathname === '/' ? '/index.html' : u.pathname));
  if (file.indexOf(path.join(ROOT, 'app')) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  var body = fs.readFileSync(file);
  if (/index\.html$/.test(file)) body = String(body).replace('<script src="js/terminal.js">', '<script src="/__dev/bridge.js"></script>\n  <script src="js/terminal.js">');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
});

var port = Number(process.argv[2] || process.env.PORT || 8099);
server.listen(port, '127.0.0.1', function () {
  console.log('dev harness on http://127.0.0.1:' + server.address().port + '/  (binary: ' + created.runner.config.binary + ')');
});
module.exports = server;
