#!/usr/bin/env node
// Keeps CHANGELOG.md in step with `npm version`.
//
//   node scripts/changelog.js check    fail if [Unreleased] has no entries (preversion hook)
//   node scripts/changelog.js release  turn [Unreleased] into a section for the new version
//                                      from package.json and update the compare links (version hook)
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repoUrl = pkg.homepage.replace(/\/$/, '');

function fail(message) {
  console.error(`changelog: ${message}`);
  process.exit(1);
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parse(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l));
  if (start < 0) fail('CHANGELOG.md has no "## [Unreleased]" heading');
  let end = start + 1;
  while (end < lines.length && !/^## \[/.test(lines[end]) && !/^\[[^\]]+\]: /.test(lines[end])) end++;
  const body = lines.slice(start + 1, end);
  // Trim blank lines around the entries
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { lines, start, end, body };
}

function check() {
  const { body } = parse(fs.readFileSync(changelogPath, 'utf8'));
  if (!body.some((l) => l.trim())) {
    fail('nothing under "## [Unreleased]" in CHANGELOG.md; describe the changes before releasing');
  }
}

function release() {
  const version = pkg.version;
  const text = fs.readFileSync(changelogPath, 'utf8');
  if (text.includes(`## [${version}]`)) fail(`CHANGELOG.md already has a section for ${version}`);
  const { lines, start, end, body } = parse(text);
  if (!body.length) fail('nothing under "## [Unreleased]" to release');

  const out = [...lines.slice(0, start + 1), '', `## [${version}] - ${today()}`, '', ...body, '', ...lines.slice(end)];

  // Compare links: [Unreleased] now starts at this version; the new version spans previous...this
  const linkIndex = out.findIndex((l) => l.startsWith('[Unreleased]: '));
  const previous = linkIndex >= 0 && (out[linkIndex].match(/compare\/v(.+)\.\.\.HEAD$/) || [])[1];
  const versionLink = previous
    ? `[${version}]: ${repoUrl}/compare/v${previous}...v${version}`
    : `[${version}]: ${repoUrl}/releases/tag/v${version}`;
  const unreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`;
  if (linkIndex >= 0) out.splice(linkIndex, 1, unreleasedLink, versionLink);
  else out.push(unreleasedLink, versionLink);

  fs.writeFileSync(changelogPath, out.join('\n').replace(/\n{3,}/g, '\n\n'));
  console.log(`changelog: released ${version}`);
}

const command = process.argv[2];
if (command === 'check') check();
else if (command === 'release') release();
else fail('usage: changelog.js check|release');
