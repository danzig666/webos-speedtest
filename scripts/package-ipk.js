#!/usr/bin/env node
'use strict';
/*
 * Build the installable .ipk:
 *   1. stage app/ and service/ (with the prebuilt ptyrun helpers) into dist/
 *   2. run ares-package from @webos-tools/cli (not @webosose/ares-cli, which
 *      stamps 1970 dates on Node 22 that some TVs refuse)
 *   3. verify the archive: expected files present, helpers executable,
 *      no Ookla binary inside, sane timestamps
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var root = path.resolve(__dirname, '..');
var dist = path.join(root, 'dist');
var stageApp = path.join(dist, 'stage', 'app');
var stageSvc = path.join(dist, 'stage', 'service');
var appinfo = JSON.parse(fs.readFileSync(path.join(root, 'app', 'appinfo.json'), 'utf8'));
var svcPkg = JSON.parse(fs.readFileSync(path.join(root, 'service', 'package.json'), 'utf8'));
var HELPERS = ['ptyrun-armv7', 'ptyrun-aarch64'];

function fail(msg) { console.error('package-ipk: ' + msg); process.exit(1); }

if (svcPkg.version !== appinfo.version) fail('service/package.json version ' + svcPkg.version + ' != appinfo ' + appinfo.version);
HELPERS.forEach(function (h) {
  if (!fs.existsSync(path.join(root, 'service', 'bin', h))) fail('missing service/bin/' + h + ' — run "npm run build:pty" first');
});

fs.rmSync(path.join(dist, 'stage'), { recursive: true, force: true });
fs.mkdirSync(stageApp, { recursive: true });
fs.cpSync(path.join(root, 'app'), stageApp, { recursive: true });
fs.mkdirSync(path.join(stageSvc, 'bin'), { recursive: true });
['service.js', 'package.json', 'services.json'].forEach(function (f) { fs.copyFileSync(path.join(root, 'service', f), path.join(stageSvc, f)); });
fs.cpSync(path.join(root, 'service', 'lib'), path.join(stageSvc, 'lib'), { recursive: true });
HELPERS.forEach(function (h) {
  var dst = path.join(stageSvc, 'bin', h);
  fs.copyFileSync(path.join(root, 'service', 'bin', h), dst);
  fs.chmodSync(dst, 493);
});

var ares = path.join(root, 'node_modules', '@webos-tools', 'cli', 'bin', 'ares-package.js');
if (!fs.existsSync(ares)) fail('@webos-tools/cli missing — run "npm ci"');
var r = cp.spawnSync(process.execPath, [ares, '--no-minify', '-o', dist, stageApp, stageSvc], { stdio: 'inherit' });
if (r.status !== 0) fail('ares-package failed');

var ipk = path.join(dist, appinfo.id + '_' + appinfo.version + '_all.ipk');
if (!fs.existsSync(ipk)) fail('expected ' + ipk);

// ---- verify ----
var tmp = fs.mkdtempSync(path.join(dist, 'verify-'));
cp.execFileSync('ar', ['x', ipk], { cwd: tmp });
var dataTar = fs.readdirSync(tmp).filter(function (f) { return /^data\.tar/.test(f); })[0];
if (!dataTar) fail('no data.tar.* in ipk');
var listing = cp.execFileSync('tar', ['-tvzf', path.join(tmp, dataTar)], { encoding: 'utf8' });
fs.rmSync(tmp, { recursive: true, force: true });

var appDir = 'usr/palm/applications/' + appinfo.id + '/';
var svcDir = 'usr/palm/services/' + svcPkg.name + '/';
var required = [appDir + 'appinfo.json', appDir + 'index.html', appDir + 'js/app.js', svcDir + 'service.js', svcDir + 'services.json', svcDir + 'lib/runner.js', svcDir + 'lib/installer.js', appDir + 'logo.png'];
required.forEach(function (f) { if (listing.indexOf(f) === -1) fail('missing ' + f + ' in ipk'); });
HELPERS.forEach(function (h) {
  var line = listing.split('\n').filter(function (l) { return l.indexOf(svcDir + 'bin/' + h) !== -1; })[0];
  if (!line) fail('missing helper ' + h);
  if (!/^-rwx/.test(line)) fail('helper ' + h + ' is not executable in the ipk: ' + line);
});
if (/\/speedtest$/m.test(listing)) fail('an Ookla "speedtest" binary ended up in the ipk');
if (/ 1970-01-01 /.test(listing)) fail('epoch-dated files in ipk');

var size = fs.statSync(ipk).size;
console.log('package-ipk: ' + path.relative(root, ipk) + ' (' + Math.round(size / 1024) + ' KiB) verified');
