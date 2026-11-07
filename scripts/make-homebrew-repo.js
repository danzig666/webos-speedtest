#!/usr/bin/env node
'use strict';
/*
 * Generate the Homebrew Channel repository for this app:
 *
 *   homebrew/apps.json                                   repository index (add this URL in HBChannel)
 *   homebrew/io.github.danzig666.speedtest.manifest.json package manifest
 *
 * Usage: node scripts/make-homebrew-repo.js <path/to/app.ipk> <tag e.g. v1.3.0> [outDir]
 *
 * The format matches https://repo.webosbrew.org/api/apps.json: an index with
 * `packages`, each embedding its manifest (id, version, ipkUrl, ipkHash.sha256,
 * ipkSize, rootRequired...). The index is served from raw.githubusercontent.com
 * (which sends Access-Control-Allow-Origin: *, needed by HBChannel's UI); the
 * .ipk itself is the GitHub release asset (HBChannel's service follows the
 * redirect and checks the SHA-256).
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var OWNER_REPO = 'danzig666/webos-speedtest';
var RAW = 'https://raw.githubusercontent.com/' + OWNER_REPO + '/main/';
var root = path.resolve(__dirname, '..');

function build(ipkPath, tag) {
  var appinfo = JSON.parse(fs.readFileSync(path.join(root, 'app', 'appinfo.json'), 'utf8'));
  if (tag !== 'v' + appinfo.version) throw new Error('tag ' + tag + ' does not match appinfo version ' + appinfo.version);
  var ipk = fs.readFileSync(ipkPath);
  var ipkName = path.basename(ipkPath);
  if (ipkName !== appinfo.id + '_' + appinfo.version + '_all.ipk') throw new Error('unexpected ipk name ' + ipkName);
  var iconUri = RAW + 'app/largeIcon.png';
  var manifest = {
    id: appinfo.id,
    version: appinfo.version,
    type: appinfo.type,
    title: appinfo.title,
    appDescription: appinfo.appDescription,
    iconUri: iconUri,
    sourceUrl: 'https://github.com/' + OWNER_REPO,
    rootRequired: true,
    ipkUrl: 'https://github.com/' + OWNER_REPO + '/releases/download/' + tag + '/' + ipkName,
    ipkHash: { sha256: crypto.createHash('sha256').update(ipk).digest('hex') },
    ipkSize: ipk.length
  };
  var manifestName = appinfo.id + '.manifest.json';
  var index = {
    paging: { page: 1, count: 1, maxPage: 1, itemsTotal: 1, prevUrl: null, nextUrl: null },
    packages: [{
      id: appinfo.id,
      title: appinfo.title,
      iconUri: iconUri,
      manifestUrl: RAW + 'homebrew/' + manifestName,
      manifest: manifest,
      pool: 'main',
      requirements: { webosRelease: '>=4.0' },
      shortDescription: 'Runs the official Ookla Speedtest CLI on the TV with live terminal output and a graphical results screen. ' +
        'Downloads the CLI itself (SHA-256 pinned) and asks you to accept Ookla\'s terms. Requires root.'
    }]
  };
  return { index: index, manifest: manifest, manifestName: manifestName };
}

function write(out, built) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'apps.json'), JSON.stringify(built.index, null, 2) + '\n');
  fs.writeFileSync(path.join(out, built.manifestName), JSON.stringify(built.manifest, null, 2) + '\n');
}

module.exports = { build: build, write: write, RAW: RAW };

if (require.main === module) {
  var args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: make-homebrew-repo.js <ipk> <tag> [outDir]');
    process.exit(2);
  }
  var built = build(args[0], args[1]);
  write(args[2] || path.join(root, 'homebrew'), built);
  console.log('homebrew repo: ' + built.manifest.id + ' ' + built.manifest.version + ' sha256 ' + built.manifest.ipkHash.sha256);
}
