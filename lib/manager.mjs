import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat, lstat, realpath, open } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const catalog = JSON.parse(await readFile(join(root, 'patches/catalog.json'), 'utf8'));

export function patchFor(id = 'ds-bot-prompt-tools') {
  const patch = catalog.patches.find(item => item.id === id);
  if (!patch) throw new Error(`未知补丁：${id}`);
  return patch;
}

async function optionalFile(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function inside(base, path) {
  const part = relative(base, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')));
}

async function target(packageRoot, name) {
  const path = resolve(packageRoot, name);
  if (!inside(packageRoot, path) || path === packageRoot) throw new Error(`非法目标路径：${name}`);
  let current = path;
  while (current !== packageRoot) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`目标路径包含符号链接：${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
  return path;
}

export async function appVersion(app) {
  const path = join(app, 'Contents/Info.plist');
  const text = await readFile(path, 'utf8');
  const match = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  if (match) return match[1];
  if (process.platform === 'darwin') return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path], { encoding: 'utf8' }).trim();
  throw new Error('无法读取 DSH 应用版本；请使用 --app 指定 macOS 应用目录。');
}

async function desiredFiles(patch, original) {
  let text = original.toString('utf8');
  for (const { before, after } of patch.replacements) {
    if (text.split(before).length !== 2) throw new Error(`补丁锚点不唯一：${patch.id}`);
    text = text.replace(before, after);
  }
  const result = new Map([[patch.modifiedFile.path, Buffer.from(text)]]);
  if (sha256(result.get(patch.modifiedFile.path)) !== patch.modifiedFile.patchedSha256) throw new Error('生成的补丁文件与登记指纹不符。');
  for (const file of patch.addedFiles) {
    const bytes = await readFile(join(root, file.payload));
    if (sha256(bytes) !== file.sha256) throw new Error(`补丁资源指纹不符：${file.payload}`);
    result.set(file.path, bytes);
  }
  return result;
}

export async function inspect({ profile, app, patch = patchFor() }) {
  const version = await appVersion(app);
  let packageRoot;
  try { packageRoot = await realpath(join(profile, 'node_modules', patch.package)); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'missing', patch: patch.id, dshVersion: version, message: `未安装 ${patch.package}` }; throw error; }
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const result = { patch: patch.id, dshVersion: version, pluginVersion: pkg.version, packageRoot };
  if (pkg.name !== patch.package || !patch.dshVersions.includes(version) || !patch.pluginVersions.includes(pkg.version)) return { ...result, status: 'unsupported', message: '版本未登记，拒绝套用旧补丁。' };
  const current = await optionalFile(await target(packageRoot, patch.modifiedFile.path));
  const hash = current && sha256(current);
  const additions = await Promise.all(patch.addedFiles.map(async file => {
    const bytes = await optionalFile(await target(packageRoot, file.path));
    return bytes === null ? 'missing' : sha256(bytes) === file.sha256 ? 'applied' : 'modified';
  }));
  if (hash === patch.modifiedFile.patchedSha256 && additions.every(value => value === 'applied')) return { ...result, status: 'applied', message: '补丁文件完整。运行时是否已加载需单独检查。' };
  if (hash === patch.modifiedFile.originalSha256 && !additions.includes('modified')) return { ...result, status: 'applicable', message: '版本与原文件指纹匹配，可修复。' };
  return { ...result, status: 'modified', message: '文件与已验证版本不同，保留现状并停止。' };
}

async function atomicWrite(path, bytes, mode = 0o644) {
  const temporary = path + '.compat-' + randomUUID();
  await mkdir(dirname(path), { recursive: true });
  const file = await open(temporary, 'wx', mode);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

/** Serialize cooperating patch operations. A crashed process leaves a visible lock. */
async function locked(options, action) {
  const directory = join(options.profile, '.dsh-compat-patches.lock');
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`已有修复锁：${directory}；先确认没有其他修复进程。`); throw error; }
  try { return await action(); }
  finally {
    // Preserve lock metadata in the local backup area instead of deleting files.
    const locks = join(options.backupRoot, 'completed-locks');
    await mkdir(locks, { recursive: true, mode: 0o700 });
    await rename(directory, join(locks, randomUUID()));
  }
}

export async function assertIdle(profile) {
  const path = join(dirname(dirname(profile)), 'bot/inflight.json');
  const bytes = await optionalFile(path);
  if (bytes === null) return;
  const current = JSON.parse(bytes);
  const active = Object.keys(current.turns ?? {}).length + Object.keys(current.queued ?? {}).length;
  if (active > 0) throw new Error('检测到 Bot 任务正在运行或排队，等待任务结束后再修复或热重载。');
}

export async function repair(options) {
  return locked(options, async () => {
    const patch = options.patch ?? patchFor();
    const before = await inspect({ ...options, patch });
    if (before.status === 'applied') return { ...before, changed: false };
    if (before.status !== 'applicable') throw new Error(before.message);
    await assertIdle(options.profile);
    const original = await readFile(await target(before.packageRoot, patch.modifiedFile.path));
    const files = await desiredFiles(patch, original);
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
    const backup = join(options.backupRoot, id);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const entries = [];
    for (const [name, after] of files) {
      const path = await target(before.packageRoot, name);
      const bytes = await optionalFile(path);
      const allowed = name === patch.modifiedFile.path ? patch.modifiedFile.originalSha256 : patch.addedFiles.find(file => file.path === name).sha256;
      if ((name === patch.modifiedFile.path && bytes === null) || (bytes !== null && sha256(bytes) !== allowed)) throw new Error('目标文件在检查后发生变化，保留现状。');
      const mode = bytes === null ? 0o644 : (await stat(path)).mode & 0o777;
      if (bytes !== null) {
        await mkdir(dirname(join(backup, 'original', name)), { recursive: true });
        await writeFile(join(backup, 'original', name), bytes, { mode });
      }
      entries.push({ path: name, before: bytes === null ? null : sha256(bytes), after: sha256(after), mode });
    }
    const manifest = { format: 1, patch: patch.id, packageRoot: before.packageRoot, dshVersion: before.dshVersion, pluginVersion: before.pluginVersion, phase: 'prepared', files: entries };
    const save = () => atomicWrite(join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o600);
    await save();
    try {
      // Publish dependencies before the file importing them.
      for (const item of [...entries.slice(1), entries[0]]) {
        const path = await target(before.packageRoot, item.path);
        const current = await optionalFile(path);
        if ((current === null ? null : sha256(current)) !== item.before) throw new Error('目标文件在备份后发生变化，停止写入。');
        await atomicWrite(path, files.get(item.path), item.mode);
      }
      manifest.phase = 'applied'; await save();
    } catch (error) {
      manifest.phase = 'incomplete'; await save();
      throw new Error(`${error.message}；备份保留于 ${backup}，请先执行 restore。`, { cause: error });
    }
    return { ...await inspect({ ...options, patch }), changed: true, backup, activation: 'not-checked' };
  });
}

export async function restore(options, backup) {
  return locked(options, async () => {
    await assertIdle(options.profile);
    const patch = options.patch ?? patchFor();
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
    const expectedPaths = [patch.modifiedFile.path, ...patch.addedFiles.map(file => file.path)];
    if (manifest.format !== 1 || manifest.patch !== patch.id || !['prepared', 'applied', 'incomplete'].includes(manifest.phase)
      || !Array.isArray(manifest.files) || manifest.files.length !== expectedPaths.length
      || manifest.files.some((file, index) => file.path !== expectedPaths[index])) throw new Error('备份清单不合法或已经还原。');
    const [main, ...added] = manifest.files;
    if (main.before !== patch.modifiedFile.originalSha256 || main.after !== patch.modifiedFile.patchedSha256
      || added.some((item, index) => item.after !== patch.addedFiles[index].sha256 || (item.before !== null && item.before !== item.after))
      || manifest.files.some(item => !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777)) throw new Error('备份清单的文件指纹与登记补丁不符。');
    const current = await inspect({ ...options, patch });
    if (current.packageRoot !== manifest.packageRoot || current.pluginVersion !== manifest.pluginVersion || current.dshVersion !== manifest.dshVersion) throw new Error('安装位置或版本已改变，拒绝覆盖新版本。');
    // Validate every current and backup file before restoring any file.
    const originals = new Map();
    for (const item of manifest.files) {
      const bytes = await optionalFile(await target(manifest.packageRoot, item.path));
      const hash = bytes === null ? null : sha256(bytes);
      if (hash !== item.after && hash !== item.before) throw new Error(`文件在补丁之后又被修改：${item.path}`);
      if (item.before !== null) {
        const originalPath = resolve(backup, 'original', item.path);
        if (!inside(resolve(backup, 'original'), originalPath)) throw new Error('备份路径越界。');
        const original = await readFile(originalPath);
        if (sha256(original) !== item.before) throw new Error(`原文件备份指纹不符：${item.path}`);
        originals.set(item.path, original);
      }
    }
    for (const item of manifest.files) {
      const path = await target(manifest.packageRoot, item.path);
      if (item.before !== null) await atomicWrite(path, originals.get(item.path), item.mode);
      else if (await optionalFile(path) !== null) {
        const displaced = join(backup, 'displaced', item.path);
        await mkdir(dirname(displaced), { recursive: true });
        await rename(path, displaced);
      }
    }
    manifest.phase = 'restored';
    await atomicWrite(join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o600);
    return { ...await inspect({ ...options, patch }), restored: true, backup, activation: 'restart-required' };
  });
}

export function applicationPaths(app) {
  return { executable: join(app, 'Contents/MacOS/DeepSeek Harness'), runtimeRoot: join(app, 'Contents/Resources/app.asar/dsh') };
}

export async function verify(options) {
  const current = await inspect(options);
  if (current.status !== 'applied') throw new Error(`无法验收：${current.message}`);
  const { executable, runtimeRoot } = applicationPaths(options.app);
  const script = join(root, 'patches', current.patch, 'verify.mjs');
  const output = execFileSync(executable, [script, current.packageRoot, runtimeRoot], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  return { ...current, verification: 'passed', checks: output.trim().split('\n'), modelRequestSent: false, activation: 'not-checked' };
}
