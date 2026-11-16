#!/usr/bin/env node
'use strict';
/*
 * Print the release notes for one version: the bullet list under
 * "## <version>" in CHANGELOG.md, nothing else.
 * Usage: node scripts/release-notes.js 1.3.1   (a leading "v" is accepted)
 * Exits with an error when the version has no entry or no bullets.
 */
var fs = require('fs');
var path = require('path');

function notesFor(changelog, version) {
  version = String(version).replace(/^v/, '');
  var lines = changelog.split(/\r?\n/);
  var start = lines.indexOf('## ' + version);
  if (start === -1) throw new Error('CHANGELOG.md has no "## ' + version + '" section');
  var out = [];
  for (var i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (/^\s*- /.test(lines[i])) out.push(lines[i]);
    else if (out.length && /^\s+\S/.test(lines[i])) out[out.length - 1] += ' ' + lines[i].trim(); // wrapped bullet
  }
  if (!out.length) throw new Error('"## ' + version + '" in CHANGELOG.md has no bullet points');
  return out.join('\n') + '\n';
}

module.exports = { notesFor: notesFor };

if (require.main === module) {
  var file = path.join(__dirname, '..', 'CHANGELOG.md');
  try {
    process.stdout.write(notesFor(fs.readFileSync(file, 'utf8'), process.argv[2] || ''));
  } catch (e) {
    console.error('release-notes: ' + e.message);
    process.exit(1);
  }
}
