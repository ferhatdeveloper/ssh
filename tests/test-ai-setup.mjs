#!/usr/bin/env node
// ============================================================================
// Gerçek test ortamı kurulumu
// ----------------------------------------------------------------------------
// Mock yok. Kendi geçici sshd'sini başlatır (port 2222), WireGuard için gerekli
// izinler için sudo kullanmaz; testler kendi yazma alanında çalışır.
//
// Kullanım:
//   node tests/test-ai-setup.mjs
//   node tests/test-ai-setup.mjs teardown    # test ortamını temizler
//
// Çıktı:
//   /tmp/wgtest-ssh/  — sshd çalışma dizini, host key'ler
//   /tmp/wgtest-user/ — test kullanıcısının yazılabilir home dizini
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TEST_DIR = '/tmp/wgtest-ssh';
const TEST_HOME = '/tmp/wgtest-user';
const TEST_PORT = 2222;
const TEST_USER = process.env.TEST_USER || os.userInfo().username;
const PID_FILE = path.join(TEST_DIR, 'sshd.pid');
const ERR_FILE = path.join(TEST_DIR, 'sshd.err');

function log(s) { console.log(`[setup] ${s}`); }

function teardown() {
  if (existsSync(PID_FILE)) {
    try { process.kill(parseInt(readFileSync(PID_FILE, 'utf8').trim()), 'SIGTERM'); } catch {}
  }
  // sshd bazen yan process'ler bırakır, onları da temizle
  try {
    const pids = execSync(`pgrep -f "sshd -f ${TEST_DIR}"`).toString().trim().split('\n');
    for (const p of pids) {
      try { process.kill(parseInt(p), 'SIGTERM'); } catch {}
    }
  } catch {}
  if (existsSync(TEST_DIR)) {
    log(`Removing ${TEST_DIR}`);
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  if (existsSync(TEST_HOME)) {
    log(`Removing ${TEST_HOME}`);
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
}

async function setup() {
  if (existsSync(TEST_DIR)) {
    log(`Cleaning previous test dir ${TEST_DIR}`);
    teardown();
  }

  mkdirSync(TEST_DIR, { mode: 0o700 });
  mkdirSync(TEST_HOME, { mode: 0o700 });
  mkdirSync(`${TEST_HOME}/.ssh`, { mode: 0o700, recursive: true });

  // 1) SSH host key ve client key (gerçek RSA 2048 — mock değil)
  log('Generating RSA host key (real ssh-keygen)...');
  execSync(`ssh-keygen -t rsa -b 2048 -f ${TEST_DIR}/host_rsa -N "" -q`, { stdio: 'inherit' });
  log('Generating RSA client key...');
  execSync(`ssh-keygen -t rsa -b 2048 -f ${TEST_HOME}/.ssh/id_test -N "" -q`, { stdio: 'inherit' });

  // 2) authorized_keys hazırla
  const pubKey = readFileSync(`${TEST_HOME}/.ssh/id_test.pub`, 'utf8').trim();
  writeFileSync(`${TEST_HOME}/.ssh/authorized_keys`, pubKey);
  chmodSync(`${TEST_HOME}/.ssh/authorized_keys`, 0o600);
  chmodSync(`${TEST_HOME}/.ssh/id_test`, 0o600);

  // 3) sshd yapılandırması (gerçek openssh sshd, mock değil)
  // StrictModes no: TEST_HOME sahipliği test user'dan farklı olabilir (test amaçlı)
  // AuthorizedKeysFile tam yol: kendi dizinimize işaret ediyor
  const sshdConfig = `Port ${TEST_PORT}
ListenAddress 127.0.0.1
HostKey ${TEST_DIR}/host_rsa
PidFile ${PID_FILE}
PermitRootLogin no
PubkeyAuthentication yes
AuthorizedKeysFile ${TEST_HOME}/.ssh/authorized_keys
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
Subsystem sftp /usr/libexec/sftp-server
LogLevel ERROR
StrictModes no
AllowUsers ${TEST_USER}
`;
  writeFileSync(`${TEST_DIR}/sshd_config`, sshdConfig);
  log(`Wrote sshd_config for ${TEST_USER}@127.0.0.1:${TEST_PORT}`);

  // 4) sshd'yi başlat
  log(`Starting sshd on port ${TEST_PORT}...`);
  try {
    execSync(`/usr/sbin/sshd -f ${TEST_DIR}/sshd_config -E ${ERR_FILE}`, { stdio: 'inherit' });
  } catch (e) {
    log(`sshd start failed: ${e.message}`);
    if (existsSync(ERR_FILE)) log(`sshd errors:\n${readFileSync(ERR_FILE, 'utf8')}`);
    throw e;
  }
  // sshd fork eder, biraz bekle
  await new Promise(r => setTimeout(r, 800));

  // 5) Bağlantı testi — gerçekten çalışıyor mu?
  log(`Testing SSH connection to 127.0.0.1:${TEST_PORT} as ${TEST_USER}...`);
  try {
    const out = execSync(
      `ssh -i ${TEST_HOME}/.ssh/id_test -p ${TEST_PORT} -o StrictHostKeyChecking=no ` +
      `-o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ` +
      `${TEST_USER}@127.0.0.1 'whoami; echo HOST_OK; uname -s; pwd'`,
      { encoding: 'utf8', timeout: 10000 }
    );
    if (!out.includes('HOST_OK')) throw new Error('whoami did not return HOST_OK marker');
    log('SSH OK:\n' + out.split('\n').map(l => '    ' + l).join('\n'));
  } catch (e) {
    log(`SSH test failed: ${e.message}`);
    if (existsSync(ERR_FILE)) log(`sshd errors:\n${readFileSync(ERR_FILE, 'utf8')}`);
    throw e;
  }

  // 6) WireGuard var mı bak (gerçek durumu raporla)
  let wgInfo = 'wg: not installed';
  try {
    const v = execSync('wg --version 2>&1', { encoding: 'utf8' }).trim();
    wgInfo = `wg: ${v.split('\n')[0]}`;
  } catch {}
  log(wgInfo);

  console.log('\n=== Setup complete ===');
  console.log(`SSH target:  ssh -i ${TEST_HOME}/.ssh/id_test -p ${TEST_PORT} ${TEST_USER}@127.0.0.1`);
  console.log(`Workdir:     ${TEST_HOME} (wireguard test files will live here)`);
  console.log(`To teardown: node tests/test-ai-setup.mjs teardown`);
}

const arg = process.argv[2];
if (arg === 'teardown' || arg === 'cleanup') {
  teardown();
  log('Teardown complete');
} else {
  setup().catch(e => {
    console.error('Setup failed:', e.message);
    process.exit(1);
  });
}
