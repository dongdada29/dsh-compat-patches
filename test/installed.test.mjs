import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { inspect, repair, restore, verify, patchFor, sha256 } from '../lib/manager.mjs';

test('installed DSH modules validate repair, reapply after reinstall, and exact rollback in a temporary profile', async t => {
  if (process.platform !== 'darwin') return t.skip('Requires an installed macOS DSH app and supported DS-Bot source.');
  const app = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app';
  const installed = join(homedir(), '.dsh/profiles/desktop/node_modules/ds-bot/src/host/tools.js');
  try { await access(join(app, 'Contents/MacOS/DeepSeek Harness')); await access(installed); }
  catch { return t.skip('DSH app or DS-Bot is not installed on this test runner.'); }
  const patch = patchFor();
  let source = await readFile(installed, 'utf8');
  if (sha256(source) === patch.modifiedFile.patchedSha256) for (const { before, after } of [...patch.replacements].reverse()) source = source.replace(after, before);
  if (sha256(source) !== patch.modifiedFile.originalSha256) return t.skip('Installed source is outside this patch version.');
  const directory = await mkdtemp(join(tmpdir(), 'dsh-installed-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profiles/desktop');
  const pkg = join(profile, 'node_modules/ds-bot');
  await mkdir(join(pkg, 'src/host'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.2.7', type: 'module' }));
  await writeFile(join(pkg, 'src/host/tools.js'), source);
  const options = { app, profile, backupRoot: join(directory, 'backups') };
  const supported = await inspect(options);
  if (supported.status === 'unsupported') return t.skip('Installed app version is outside this patch.');
  const first = await repair(options);
  assert.equal(first.status, 'applied');
  assert.equal((await verify(options)).verification, 'passed');
  // Simulate a package manager restoring the original source after an update.
  await writeFile(join(pkg, 'src/host/tools.js'), source);
  const reapplied = await repair(options);
  assert.equal(reapplied.changed, true);
  assert.equal((await verify(options)).verification, 'passed');
  // Restore through the original backup so the helper did not exist before it.
  assert.equal((await restore(options, first.backup)).status, 'applicable');
  assert.equal(await readFile(join(pkg, 'src/host/tools.js'), 'utf8'), source);
});
