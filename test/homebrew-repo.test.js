'use strict';
// The Homebrew Channel repository files match the official repo format and the ipk.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var repo = require('../scripts/make-homebrew-repo');

var appinfo = require('../app/appinfo.json');

function fakeIpk() {
  var d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hb-'));
  var f = path.join(d, appinfo.id + '_' + appinfo.version + '_all.ipk');
  fs.writeFileSync(f, crypto.randomBytes(4096));
  return f;
}

test('index and manifest have the fields HBChannel reads', function () {
  var ipk = fakeIpk();
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hb-out-'));
  var built = repo.build(ipk, 'v' + appinfo.version);
  repo.write(out, built);
  var index = JSON.parse(fs.readFileSync(path.join(out, 'apps.json'), 'utf8'));
  assert.strictEqual(index.paging.itemsTotal, 1);
  var p = index.packages[0];
  assert.strictEqual(p.id, appinfo.id);
  assert.match(p.manifestUrl, /^https:\/\/raw\.githubusercontent\.com\/danzig666\/webos-speedtest\/main\/homebrew\/io\.github\.danzig666\.speedtest\.manifest\.json$/);
  assert.ok(p.shortDescription && p.iconUri);
  var m = JSON.parse(fs.readFileSync(path.join(out, appinfo.id + '.manifest.json'), 'utf8'));
  assert.deepStrictEqual(p.manifest, m, 'embedded manifest equals the standalone one');
  assert.strictEqual(m.version, appinfo.version);
  assert.strictEqual(m.rootRequired, true);
  assert.strictEqual(m.ipkUrl, 'https://github.com/danzig666/webos-speedtest/releases/download/v' + appinfo.version + '/' + path.basename(ipk));
  assert.strictEqual(m.ipkHash.sha256, crypto.createHash('sha256').update(fs.readFileSync(ipk)).digest('hex'));
  assert.strictEqual(m.ipkSize, 4096);
});

test('refuses a tag that does not match the app version', function () {
  assert.throws(function () { repo.build(fakeIpk(), 'v0.0.1'); }, /does not match/);
});
