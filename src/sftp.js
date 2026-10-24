// SFTP support for the main process.
//
// Remote locations are addressed as `sftp://user@host:port/absolute/path`. A session is opened once
// per user@host:port with the renderer's saved profile (and password/passphrase, kept in memory
// only) and is reconnected transparently if the connection drops.
'use strict';

const SftpClient = require('ssh2-sftp-client');
const { utils: sshUtils } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const posix = path.posix;
const URL_RE = /^sftp:\/\/([^@/]+)@(\[[^\]]+\]|[^:/]+)(?::(\d+))?(\/.*)?$/;

const sessions = new Map(); // key -> { profile, secret, client, alive, reconnecting }
let knownHostsFile = null;
let onStatus = () => {};

function init(userDataDir, statusCallback) {
  knownHostsFile = path.join(userDataDir, 'sftp_known_hosts.json');
  onStatus = statusCallback;
}

// ---------- locations ----------

function isRemote(p) {
  return typeof p === 'string' && p.startsWith('sftp://');
}

function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function hostId(profile) {
  return `${formatHost(profile.host)}:${Number(profile.port) || 22}`;
}

function keyOf(profile) {
  return `${profile.username}@${hostId(profile)}`;
}

function normalizeRemotePath(p) {
  const n = posix.normalize(p || '/');
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

function parse(url) {
  const m = URL_RE.exec(url);
  if (!m) throw new Error(`Not a valid SFTP location: ${url}`);
  return { key: `${m[1]}@${m[2]}:${m[3] || 22}`, remotePath: normalizeRemotePath(m[4]) };
}

function format(key, remotePath) {
  return `sftp://${key}${normalizeRemotePath(remotePath)}`;
}

function join(url, ...parts) {
  const { key, remotePath } = parse(url);
  return format(key, posix.join(remotePath, ...parts));
}

function basename(url) {
  return posix.basename(parse(url).remotePath);
}

function sameSession(a, b) {
  return isRemote(a) && isRemote(b) && parse(a).key === parse(b).key;
}

// ---------- host keys ----------

async function loadKnownHosts() {
  try {
    return JSON.parse(await fs.readFile(knownHostsFile, 'utf8'));
  } catch {
    return {};
  }
}

async function trustHost(id, fingerprint) {
  const known = await loadKnownHosts();
  known[id] = fingerprint;
  await fs.mkdir(path.dirname(knownHostsFile), { recursive: true });
  await fs.writeFile(knownHostsFile, JSON.stringify(known, null, 2));
}

// ---------- connections ----------

function isEncryptedKey(keyData) {
  const parsed = sshUtils.parseKey(keyData);
  return parsed instanceof Error && /passphrase/i.test(parsed.message);
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Connects a new client. Errors the renderer must act on are thrown with a code prefix:
 * SFTP_HOST_KEY {json}, SFTP_NEED_SECRET, SFTP_PASSPHRASE, SFTP_AUTH.
 */
async function openClient(profile, secret) {
  const id = hostId(profile);
  const known = await loadKnownHosts();
  let hostProblem = null;
  let probeOnly = false;

  const config = {
    host: profile.host.replace(/^\[|\]$/g, ''),
    port: Number(profile.port) || 22,
    username: profile.username,
    readyTimeout: 20000,
    keepaliveInterval: 20000,
    hostVerifier: (key) => {
      const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
      if (known[id] === fingerprint) return true;
      hostProblem = { host: id, fingerprint, previous: known[id] || null };
      return false;
    },
  };

  if (profile.auth === 'password') {
    // Without a password yet, still connect: the host key gets checked before anything is typed
    if (secret) config.password = secret;
  } else if (profile.auth === 'key') {
    if (!profile.keyPath) throw new Error('No private key file is set for this server');
    const keyData = await fs.readFile(expandHome(profile.keyPath));
    if (secret) config.passphrase = secret;
    if (!secret && isEncryptedKey(keyData)) {
      // Check the host key before asking for the passphrase: connect without credentials first
      probeOnly = true;
    } else {
      config.privateKey = keyData;
    }
  } else {
    // Windows has no SSH_AUTH_SOCK; its built-in OpenSSH agent listens on a named pipe
    config.agent =
      process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
    if (!config.agent) throw new Error('No SSH agent is running (SSH_AUTH_SOCK is not set)');
  }

  const client = new SftpClient();
  try {
    await client.connect(config);
  } catch (err) {
    client.end().catch(() => {});
    if (hostProblem) throw new Error(`SFTP_HOST_KEY ${JSON.stringify(hostProblem)}`);
    if (probeOnly) throw new Error('SFTP_PASSPHRASE');
    const msg = String(err.message || err);
    if (/passphrase|bad decrypt|encrypted/i.test(msg)) throw new Error('SFTP_PASSPHRASE');
    if (/authentication methods failed/i.test(msg)) {
      throw new Error(profile.auth === 'password' && !secret ? 'SFTP_NEED_SECRET' : 'SFTP_AUTH');
    }
    throw new Error(msg.replace(/^connect: (getConnection: )?/, ''));
  }
  if (probeOnly) {
    // The server let us in without credentials; still use the key as configured
    client.end().catch(() => {});
    throw new Error('SFTP_PASSPHRASE');
  }
  return client;
}

function watch(key, session) {
  const dropped = () => {
    if (sessions.get(key) !== session || !session.alive) return;
    session.alive = false;
    onStatus(key, false);
  };
  session.client.on('close', dropped);
  session.client.on('end', dropped);
  session.client.on('error', dropped);
}

/** Connects (or reuses the session for) a profile and returns the URL to open. */
async function connect(profile, secret) {
  const key = keyOf(profile);
  let session = sessions.get(key);
  if (!session || (!session.alive && secret)) {
    const client = await openClient(profile, secret);
    if (session && session.client) session.client.end().catch(() => {});
    session = { profile, secret, client, alive: true };
    sessions.set(key, session);
    watch(key, session);
    onStatus(key, true);
  } else {
    session.profile = profile;
  }
  const client = await clientFor(key);
  let start = '';
  if (profile.remotePath) start = await client.realPath(profile.remotePath).catch(() => '');
  if (!start) start = await client.realPath('.');
  return { key, url: format(key, start) };
}

async function clientFor(key) {
  const session = sessions.get(key);
  if (!session) throw new Error(`Not connected to ${key}. Open it from the Network list.`);
  if (!session.alive) {
    // Reconnect once for every caller that hits a dropped session at the same time
    session.reconnecting ??= openClient(session.profile, session.secret)
      .then((client) => {
        session.client = client;
        session.alive = true;
        watch(key, session);
        onStatus(key, true);
      })
      .finally(() => {
        session.reconnecting = null;
      });
    await session.reconnecting;
  }
  return session.client;
}

async function disconnect(key) {
  const session = sessions.get(key);
  sessions.delete(key);
  if (session) await session.client.end().catch(() => {});
  onStatus(key, false);
}

function connectedKeys() {
  return [...sessions].filter(([, s]) => s.alive).map(([key]) => key);
}

async function endAll() {
  await Promise.all([...sessions.keys()].map(disconnect));
}

// ---------- file operations ----------

async function at(url) {
  const { key, remotePath } = parse(url);
  return { key, remotePath, client: await clientFor(key) };
}

async function list(url) {
  const { key, remotePath, client } = await at(url);
  const items = await client.list(remotePath);
  const entries = await Promise.all(
    items.map(async (item) => {
      const full = posix.join(remotePath, item.name);
      const entry = {
        name: item.name,
        path: format(key, full),
        isDir: item.type === 'd',
        isLink: item.type === 'l',
        size: item.size,
        mtime: item.modifyTime,
        hidden: item.name.startsWith('.'),
      };
      if (entry.isLink) {
        try {
          const st = await client.stat(full); // follow the link
          entry.isDir = st.isDirectory;
          entry.size = st.size;
          entry.mtime = st.modifyTime;
        } catch {
          // broken link
        }
      }
      return entry;
    })
  );
  return {
    path: format(key, remotePath),
    parent: remotePath === '/' ? null : format(key, posix.dirname(remotePath)),
    entries,
  };
}

async function exists(url) {
  const { remotePath, client } = await at(url);
  return Boolean(await client.exists(remotePath));
}

async function isDir(url) {
  const { remotePath, client } = await at(url);
  try {
    return (await client.stat(remotePath)).isDirectory;
  } catch {
    return false;
  }
}

async function rename(url, newName) {
  const { remotePath, client } = await at(url);
  const dest = posix.join(posix.dirname(remotePath), newName);
  if (await client.exists(dest)) throw new Error(`"${newName}" already exists`);
  await client.rename(remotePath, dest);
}

async function mkdir(url, name) {
  const { remotePath, client } = await at(url);
  await client.mkdir(posix.join(remotePath, name));
}

/** Permanently deletes a file or folder (servers have no trash). */
async function remove(url) {
  const { remotePath, client } = await at(url);
  const type = await client.exists(remotePath);
  if (type === 'd') await client.rmdir(remotePath, true);
  else if (type) await client.delete(remotePath);
}

/** Moves within one server. */
async function moveWithin(srcUrl, destUrl) {
  const { remotePath: src, client } = await at(srcUrl);
  const { remotePath: dest } = parse(destUrl);
  if (dest === src || dest.startsWith(src + '/')) throw new Error('Cannot move a folder into itself');
  if (await client.exists(dest)) await remove(destUrl);
  await client.rename(src, dest);
}

async function download(url, localDest) {
  const { remotePath, client } = await at(url);
  if ((await client.stat(remotePath)).isDirectory) {
    await fs.mkdir(localDest, { recursive: true });
    await client.downloadDir(remotePath, localDest);
  } else {
    await client.fastGet(remotePath, localDest);
  }
}

async function upload(localSrc, url) {
  const { remotePath, client } = await at(url);
  if ((await fs.stat(localSrc)).isDirectory()) await client.uploadDir(localSrc, remotePath);
  else await client.fastPut(localSrc, remotePath);
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'splitbeam-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Copies between two remote locations (same or different servers) through a local temp folder. */
async function copyRemote(srcUrl, destUrl) {
  const { remotePath: src } = parse(srcUrl);
  if (sameSession(srcUrl, destUrl) && parse(destUrl).remotePath.startsWith(src + '/')) {
    throw new Error('Cannot copy a folder into itself');
  }
  await withTempDir(async (dir) => {
    const local = path.join(dir, posix.basename(src));
    await download(srcUrl, local);
    await upload(local, destUrl);
  });
}

/** Downloads a remote file to a fresh temp folder (kept so the opened app can read it). */
async function downloadToTemp(url) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'splitbeam-open-'));
  const local = path.join(dir, basename(url));
  await download(url, local);
  return local;
}

module.exports = {
  init,
  isRemote,
  join,
  basename,
  sameSession,
  trustHost,
  connect,
  disconnect,
  connectedKeys,
  endAll,
  list,
  exists,
  isDir,
  rename,
  mkdir,
  remove,
  moveWithin,
  download,
  upload,
  copyRemote,
  downloadToTemp,
};
