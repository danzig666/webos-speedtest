'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var notesFor = require('../scripts/release-notes').notesFor;
var changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');

test('the current app version has release notes made only of bullets', function () {
  var version = require('../app/appinfo.json').version;
  var notes = notesFor(changelog, 'v' + version);
  notes.trim().split('\n').forEach(function (l) { assert.match(l, /^- \S/); });
});

test('notes stop at the next version and wrapped bullets are joined', function () {
  var md = '## 2.0.0\n\n- one\n- two that\n  wraps\n\n## 1.0.0\n\n- old\n';
  assert.strictEqual(notesFor(md, '2.0.0'), '- one\n- two that wraps\n');
  assert.throws(function () { notesFor(md, '3.0.0'); }, /no "## 3.0.0"/);
  assert.throws(function () { notesFor('## 1.0.0\n\ntext only\n', '1.0.0'); }, /no bullet/);
});
