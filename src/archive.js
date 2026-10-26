// "Extract here" for the main process, using the system's archive tools (tar, unzip, 7z, ...).
//
// Archives are unpacked into a hidden temporary folder next to them first, so nothing existing is ever
// overwritten. A single top-level item is then moved into place as is; several items are kept together in
// a folder named after the archive. Taken names get " (2)", " (3)", ... like other file managers.
'use strict';

const childProcess = require('child_process');
const fs = require('fs/promises');
const { createWriteStream } = require('fs');
const path = require('path');

// Longest suffixes first so "x.tar.gz" is a tarball, not a single gzipped file
const KINDS = [
  [/\.(tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst|tar)$/i, 'tar'],
  [/\.zip$/i, 'zip'],
  [/\.7z$/i, '7z'],
  [/\.rar$/i, 'rar'],
  [/\.gz$/i, 'gz'],
  [/\.bz2$/i, 'bz2'],
  [/\.xz$/i, 'xz'],
  [/\.zst$/i, 'zst'],
];

function kindOf(name) {
  const match = KINDS.find(([re]) => re.test(name));
  return match ? { kind: match[1], stem: name.replace(match[0], '') } : null;
}

/** Commands to try, in order, to unpack `file` into `dest` (for archives holding several files). */
function commandsFor(kind, file, dest) {
  const sevenZip = (bin) => [bin, ['x', '-y', `-o${dest}`, file]];
  if (process.platform === 'win32' || process.platform === 'darwin') {
    // Windows 10+ and macOS ship bsdtar, which reads zip, tar.*, 7z and most rar files
    return [['tar', ['-xf', file, '-C', dest]], sevenZip('7z')];
  }
  switch (kind) {
    case 'tar':
      return [['tar', ['-xf', file, '-C', dest]], ['bsdtar', ['-xf', file, '-C', dest]]];
    case 'zip':
      return [['unzip', ['-q', file, '-d', dest]], sevenZip('7z'), sevenZip('7za'), sevenZip('7zz'), ['bsdtar', ['-xf', file, '-C', dest]]];
    case '7z':
      return [sevenZip('7z'), sevenZip('7za'), sevenZip('7zz'), ['bsdtar', ['-xf', file, '-C', dest]]];
    case 'rar':
      return [['unrar', ['x', '-o-', file, dest + path.sep]], sevenZip('7z'), ['unar', ['-q', '-o', dest, file]], ['bsdtar', ['-xf', file, '-C', dest]]];
    default:
      return [];
  }
}

/** Decompressors that write a single-file .gz/.bz2/.xz/.zst to stdout. */
const STREAM_TOOLS = {
  gz: [['gzip', ['-dc']]],
  bz2: [['bzip2', ['-dc']]],
  xz: [['xz', ['-dc']]],
  zst: [['zstd', ['-dc']]],
};

/**
 * Runs `cmd`; resolves { started: false } if it is not installed, otherwise its exit code and stderr.
 * When `stdoutFile` is given, standard output is written there.
 */
function run(cmd, args, { stdoutFile } = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(cmd, args, { stdio: ['ignore', stdoutFile ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    let started = false;
    child.stderr.on('data', (d) => (stderr += d));
    const out = stdoutFile ? createWriteStream(stdoutFile) : null;
    if (out) child.stdout.pipe(out);
    child.once('spawn', () => (started = true));
    child.once('error', (err) => {
      if (!started && err.code === 'ENOENT') resolve({ started: false });
      else resolve({ started: true, code: -1, stderr: err.message });
    });
    child.once('close', (code) => {
      const done = () => resolve({ started: true, code, stderr });
      // Make sure everything piped to the output file has been written
      if (out && !out.writableFinished) out.once('finish', done);
      else done();
    });
  });
}

async function unpack(kind, file, dest, stem) {
  if (STREAM_TOOLS[kind] && process.platform !== 'win32') {
    for (const [cmd, args] of STREAM_TOOLS[kind]) {
      const result = await run(cmd, [...args, file], { stdoutFile: path.join(dest, stem) });
      if (result.started) return result;
    }
    return { started: false, tried: STREAM_TOOLS[kind].map(([cmd]) => cmd) };
  }
  const commands = commandsFor(kind, file, dest);
  for (const [cmd, args] of commands) {
    const result = await run(cmd, args);
    if (result.started) return result; // a real failure (bad archive, password) is reported, not retried
  }
  return { started: false, tried: commands.map(([cmd]) => cmd) };
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** "name", or "name (2)", "name (3)", ... keeping a file's extension at the end. */
async function freeName(dir, name, isDir) {
  if (!(await exists(path.join(dir, name)))) return name;
  const ext = isDir ? '' : path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
}

/** Extracts `file` next to itself and returns the name of what was created there. */
async function extractHere(file) {
  const dir = path.dirname(file);
  const info = kindOf(path.basename(file));
  if (!info) throw new Error('Not a supported archive');

  const temp = await fs.mkdtemp(path.join(dir, '.splitbeam-extract-'));
  try {
    const result = await unpack(info.kind, file, temp, info.stem);
    if (!result.started) {
      throw new Error(`No program to extract this archive was found. Install one of: ${result.tried.join(', ')}.`);
    }
    if (result.code !== 0) {
      const detail = (result.stderr || '').trim().split('\n').slice(-3).join('\n');
      throw new Error(`Extracting failed${detail ? ':\n' + detail : ` (exit code ${result.code})`}`);
    }

    const items = await fs.readdir(temp);
    if (!items.length) throw new Error('The archive is empty');
    if (items.length === 1) {
      // One top-level item: put it next to the archive as is
      const isDir = (await fs.lstat(path.join(temp, items[0]))).isDirectory();
      const name = await freeName(dir, items[0], isDir);
      await fs.rename(path.join(temp, items[0]), path.join(dir, name));
      return name;
    }
    // Several items: keep them together in a folder named after the archive
    const name = await freeName(dir, info.stem || 'extracted', true);
    await fs.rename(temp, path.join(dir, name));
    return name;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { kindOf, extractHere };
