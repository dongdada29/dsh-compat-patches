import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchFor, sha256, inspect, repair, restore, assertIdle } from '../lib/manager.mjs';
import { installPromptAssemblyCompat } from '../patches/ds-bot-prompt-tools/prompt-assembly-compat.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-compat-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profiles/desktop');
  const app = join(directory, 'DeepSeek Harness.app');
  const pkg = join(profile, 'node_modules/ds-bot');
  await mkdir(join(pkg, 'src/host'), { recursive: true });
  await mkdir(join(app, 'Contents'), { recursive: true });
  await writeFile(join(app, 'Contents/Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>0.2.2-rc.1</string></dict></plist>');
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.2.7', type: 'module' }));
  const original = Buffer.from("import { randomUUID } from 'node:crypto'\nexport function install(rt) {\n  const { ctx, state } = rt\n  return {\n        tools: assembled.tools.filter(tool => !HIDDEN_TOOLS.includes(tool.name)),\n  }\n}\n");
  await writeFile(join(pkg, 'src/host/tools.js'), original);
  const patch = structuredClone(patchFor());
  let expected = original.toString();
  for (const replacement of patch.replacements) expected = expected.replace(replacement.before, replacement.after);
  patch.modifiedFile.originalSha256 = sha256(original);
  patch.modifiedFile.patchedSha256 = sha256(expected);
  return { directory, pkg, original, expected, options: { profile, app, patch, backupRoot: join(directory, 'backups') } };
}

test('repair, repeated repair, and restore preserve exact original bytes', async t => {
  const f = await fixture(t);
  assert.equal((await inspect(f.options)).status, 'applicable');
  const result = await repair(f.options);
  assert.equal(result.status, 'applied');
  assert.equal(result.changed, true);
  assert.deepEqual(await readFile(join(result.backup, 'original/src/host/tools.js')), f.original);
  assert.equal((await repair(f.options)).changed, false);
  assert.equal(await readFile(join(f.pkg, 'src/host/tools.js'), 'utf8'), f.expected);
  const undone = await restore(f.options, result.backup);
  assert.equal(undone.status, 'applicable');
  assert.deepEqual(await readFile(join(f.pkg, 'src/host/tools.js')), f.original);
  await assert.rejects(stat(join(f.pkg, 'src/host/prompt-assembly-compat.js')), { code: 'ENOENT' });
  assert.ok((await stat(join(result.backup, 'displaced/src/host/prompt-assembly-compat.js'))).isFile());
  await assert.rejects(restore(f.options, result.backup), /已经还原/);
});

test('reinstallation can be repaired again with a fresh backup', async t => {
  const f = await fixture(t);
  const first = await repair(f.options);
  await writeFile(join(f.pkg, 'src/host/tools.js'), f.original);
  await rename(join(f.pkg, 'src/host/prompt-assembly-compat.js'), join(f.directory, 'previous-helper.js'));
  assert.equal((await inspect(f.options)).status, 'applicable');
  const second = await repair(f.options);
  assert.equal(second.status, 'applied');
  assert.notEqual(first.backup, second.backup);
});

test('unknown versions and edited source files are refused', async t => {
  const f = await fixture(t);
  await writeFile(join(f.pkg, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.2.8' }));
  assert.equal((await inspect(f.options)).status, 'unsupported');
  await assert.rejects(repair(f.options), /版本未登记/);
  await writeFile(join(f.pkg, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.2.7' }));
  await writeFile(join(f.pkg, 'src/host/tools.js'), 'user change');
  assert.equal((await inspect(f.options)).status, 'modified');
  await assert.rejects(repair(f.options), /文件与已验证版本不同/);
  assert.equal(await readFile(join(f.pkg, 'src/host/tools.js'), 'utf8'), 'user change');
});

test('a changed helper is retained; a known partial installation can resume', async t => {
  const f = await fixture(t);
  await writeFile(join(f.pkg, 'src/host/prompt-assembly-compat.js'), 'another plugin owns this file');
  await assert.rejects(repair(f.options), /文件与已验证版本不同/);
  const payload = new URL('../patches/ds-bot-prompt-tools/prompt-assembly-compat.js', import.meta.url);
  await writeFile(join(f.pkg, 'src/host/prompt-assembly-compat.js'), await readFile(payload));
  assert.equal((await repair(f.options)).status, 'applied');
});

test('restore checks all files before writing and rejects modified originals', async t => {
  const f = await fixture(t);
  const result = await repair(f.options);
  await writeFile(join(result.backup, 'original/src/host/tools.js'), 'broken backup');
  await assert.rejects(restore(f.options, result.backup), /备份指纹不符/);
  assert.equal((await inspect(f.options)).status, 'applied');
});

test('restore will not overwrite a subsequent plugin edit or upgraded package', async t => {
  const f = await fixture(t);
  const result = await repair(f.options);
  await writeFile(join(f.pkg, 'src/host/prompt-assembly-compat.js'), 'subsequent edit');
  await assert.rejects(restore(f.options, result.backup), /补丁之后又被修改/);
  assert.equal(await readFile(join(f.pkg, 'src/host/tools.js'), 'utf8'), f.expected);
  await writeFile(join(f.pkg, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.3.0' }));
  await assert.rejects(restore(f.options, result.backup), /版本已改变/);
});

test('restore rejects path traversal in its manifest', async t => {
  const f = await fixture(t);
  const result = await repair(f.options);
  const path = join(result.backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.files[0].path = '../../private';
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(restore(f.options, result.backup), /清单不合法/);
  assert.equal((await inspect(f.options)).status, 'applied');
});

test('restore rejects forged file fingerprints in its manifest', async t => {
  const f = await fixture(t);
  const result = await repair(f.options);
  const path = join(result.backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.files[0].before = sha256('forged original');
  await writeFile(join(result.backup, 'original/src/host/tools.js'), 'forged original');
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(restore(f.options, result.backup), /文件指纹与登记补丁不符/);
  assert.equal((await inspect(f.options)).status, 'applied');
});

test('symbolic-link targets are refused before patching', async t => {
  if (process.platform === 'win32') t.skip('Creating symlinks requires host privileges on Windows.');
  else {
    const f = await fixture(t);
    const file = join(f.pkg, 'src/host/tools.js');
    const other = join(f.directory, 'outside.js');
    await rename(file, other); await symlink(other, file);
    await assert.rejects(inspect(f.options), /符号链接/);
    assert.deepEqual(await readFile(other), f.original);
  }
});

test('active or queued Bot tasks and concurrent repairs are refused', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'bot'));
  await writeFile(join(f.directory, 'bot/inflight.json'), JSON.stringify({ turns: { session: 1 }, queued: {} }));
  await assert.rejects(assertIdle(f.options.profile), /任务正在运行/);
  await assert.rejects(repair(f.options), /任务正在运行/);
  await mkdir(join(f.options.profile, '.dsh-compat-patches.lock'));
  await assert.rejects(repair(f.options), /已有修复锁/);
  assert.deepEqual(await readFile(join(f.pkg, 'src/host/tools.js')), f.original);
});

test('completed-assembly filtering preserves ordinary sessions and unwinds', async () => {
  const tools = [{ name: 'read' }, { name: 'subagent' }];
  const service = { async assemble() { return { tools, sections: [], contexts: [] }; } };
  const original = service.assemble;
  let dispose;
  const ctx = { systemPrompt: service, effect(setup) { dispose = setup(); } };
  installPromptAssemblyCompat({ ctx, isBotSession: id => id === 'bot' }, ['subagent']);
  assert.deepEqual((await service.assemble({ scope: { id: 'bot' } })).tools, [{ name: 'read' }]);
  assert.equal((await service.assemble({ agent: { session: { id: 'normal' } } })).tools, tools);
  dispose(); assert.equal(service.assemble, original);
});

test('CLI catalog and unsupported-version exit are machine-readable', async t => {
  const f = await fixture(t);
  const cli = new URL('../bin/dsh-patches.mjs', import.meta.url);
  const listed = spawnSync(process.execPath, [fileURLToPath(cli), 'list', '--json'], { encoding: 'utf8' });
  assert.equal(listed.status, 0);
  assert.equal(JSON.parse(listed.stdout)[0].id, 'ds-bot-prompt-tools');
  await writeFile(join(f.pkg, 'package.json'), JSON.stringify({ name: 'ds-bot', version: '0.3.0' }));
  const doctor = spawnSync(process.execPath, [fileURLToPath(cli), 'doctor', '--profile', f.options.profile, '--app', f.options.app, '--json'], { encoding: 'utf8' });
  assert.equal(doctor.status, 2);
  assert.equal(JSON.parse(doctor.stdout).status, 'unsupported');
});
