'use strict';
// Builds a .tgz shaped like Ookla's (speedtest, speedtest.md, speedtest.5)
// whose "speedtest" member launches the mock CLI.
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

module.exports = function makeMockArchive() {
  var d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-arc-'));
  var js = path.join(__dirname, '..', 'mock', 'mock-speedtest.js');
  fs.writeFileSync(path.join(d, 'speedtest'), '#!/bin/sh\nexec "${MOCK_NODE:-node}" "' + js + '" "$@"\n', { mode: 493 });
  // ~300 KB of incompressible "documentation" so downloads take a few chunks
  fs.writeFileSync(path.join(d, 'speedtest.md'), crypto.randomBytes(300 * 1024));
  fs.writeFileSync(path.join(d, 'speedtest.5'), '.TH x\n');
  var out = path.join(d, 'cli.tgz');
  cp.execFileSync('tar', ['-czf', out, '-C', d, 'speedtest.md', 'speedtest', 'speedtest.5']);
  var buf = fs.readFileSync(out);
  return { buf: buf, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
};
