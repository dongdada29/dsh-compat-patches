#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { catalog, patchFor, inspect, repair, restore, verify } from '../lib/manager.mjs';
import { activate } from '../lib/runtime.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { profile: { type: 'string' }, app: { type: 'string' }, patch: { type: 'string' }, backup: { type: 'string' }, 'backup-root': { type: 'string' }, reload: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, 'inspector-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
const help = `DSH 兼容补丁恢复工具

node bin/dsh-patches.mjs doctor
node bin/dsh-patches.mjs repair --reload
node bin/dsh-patches.mjs verify
node bin/dsh-patches.mjs runtime
node bin/dsh-patches.mjs activate
node bin/dsh-patches.mjs restore --backup <备份目录>
node bin/dsh-patches.mjs list

选项：--profile <目录> --app <DeepSeek Harness.app>
      --patch <补丁 ID> --backup-root <目录> --inspector-url <本地地址> --json

只应用登记版本与指纹匹配的补丁。不会启动 Inspector 或发送模型请求。
修复后可用现有 Inspector 热重载；不可用时正常重启 DSH 即可。`;

function print(value) {
  if (values.json) console.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value)) for (const item of value) console.log(`${item.id}: ${item.title}`);
  else {
    for (const key of ['patch', 'status', 'message', 'dshVersion', 'pluginVersion', 'packageRoot', 'changed', 'backup', 'restored', 'activation', 'active', 'reason', 'note']) if (value[key] !== undefined) console.log(`${key}: ${value[key]}`);
    const verification = typeof value.verification === 'string' ? value : value.verification;
    if (verification) {
      console.log(`verification: ${verification.verification}`);
      for (const check of verification.checks ?? []) console.log(check);
    }
    if (value.runtime) console.log(`runtime: ${JSON.stringify(value.runtime)}`);
  }
}

try {
  if (values.help) { console.log(help); process.exitCode = 0; }
  else {
    const command = positionals[0] ?? 'doctor';
    if (positionals.length > 1) throw new Error('每次只接受一个命令。');
    const profile = resolve(values.profile ?? join(homedir(), '.dsh/profiles/desktop'));
    const options = { profile, app: resolve(values.app ?? process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'), patch: patchFor(values.patch), backupRoot: resolve(values['backup-root'] ?? join(dirname(dirname(profile)), 'backups/dsh-compat-patches')), inspectorUrl: values['inspector-url'] };
    let result;
    if (command === 'list') result = catalog.patches.map(({ id, title, dshVersions, pluginVersions }) => ({ id, title, dshVersions, pluginVersions }));
    else if (command === 'doctor') { result = await inspect(options); if (!['applied', 'applicable'].includes(result.status)) process.exitCode = 2; }
    else if (command === 'verify') result = await verify(options);
    else if (command === 'runtime') { result = await activate(options, { checkOnly: true }); if (!result.active) process.exitCode = 2; }
    else if (command === 'activate') {
      const check = await inspect(options);
      if (check.status !== 'applied') throw new Error('先运行 repair 并通过 verify，再加载运行时。');
      await verify(options);
      result = await activate(options);
      if (!result.active) process.exitCode = 2;
    } else if (command === 'repair') {
      result = await repair(options);
      result.verification = await verify(options);
      result.runtime = values.reload ? await activate(options) : { activation: 'restart-required', reason: '尚未检查运行时；重启 DSH 或运行 activate。' };
      if (!result.runtime.active) process.exitCode = 2;
    } else if (command === 'restore') {
      if (!values.backup) throw new Error('restore 必须使用 --backup 指定本工具创建的备份目录。');
      if (values.reload) throw new Error('restore 后请正常重启 DSH；此命令不接受 --reload。');
      result = await restore(options, resolve(values.backup));
      process.exitCode = 2;
    } else throw new Error(`未知命令：${command}\n${help}`);
    print(result);
  }
} catch (error) {
  if (values.json) console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  else console.error(`失败：${error.message}`);
  process.exitCode = 1;
}
