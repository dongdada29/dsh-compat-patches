# DSH Compat Patches

把已经验证的 DSH 插件兼容修复保存成可重复执行的代码。升级或重装插件后补丁失效时，重新检查并应用；后续故障按补丁目录逐项扩充。

当前收录：**DSH `0.2.2-rc.1` + DS-Bot `0.2.7` 的 `Cannot read properties of undefined (reading 'filter')`**。

## 下次失效时怎么恢复

在需要修复的那台电脑上运行：

```bash
git clone https://github.com/dongdada29/dsh-compat-patches.git
cd dsh-compat-patches
./repair.sh --reload
```

仓库已有本地副本时：

```bash
cd dsh-compat-patches
git pull --ff-only
./repair.sh --reload
```

私有仓库需要该 GitHub 账号的仓库访问权限。请先等待 Bot 任务结束；工具检测到正在运行或排队的 Bot 任务时会停止修复。

`repair.sh` 优先使用 Node.js 24+，没有时使用已安装 DSH 应用自带的 Node，不安装依赖。当前应用探测和安装包验收适用于 macOS。

## 一次修复做什么

1. 检查 DSH 和插件的版本，以及被修改文件的 SHA-256。
2. 将涉及的原文件备份到 DSH 数据目录的 `backups/dsh-compat-patches/`。
3. 写入补丁；已经完整打过补丁时跳过写入。
4. 使用本机 DSH 安装包里的真实 Cordis/SystemPrompt 模块复现旧错误并验证修复。
5. 使用 `--reload` 时，通过**已有的本机 Inspector** 热重载并检查插件状态；不会自动启用调试端口。Inspector 未开启时，提示正常重启 DSH。

`verification: passed` 代表安装包模块验收通过；`runtime.activation: active` 才代表当前运行时已加载。此工具不会发送真实模型请求，也不会保证模型账号、网络、额度或其他插件正常。

补丁只修改已登记插件的两处代码文件，不读取登录凭据、对话内容或模型密钥。运行时激活只访问 `127.0.0.1`，不修改其他 profile。

## 单独检查、验收和回退

```bash
node bin/dsh-patches.mjs list
node bin/dsh-patches.mjs doctor
node bin/dsh-patches.mjs verify
node bin/dsh-patches.mjs runtime
node bin/dsh-patches.mjs activate
node bin/dsh-patches.mjs restore --backup '/实际输出的备份目录'
```

回退会先核对当前文件和原文件备份，拒绝覆盖后续修改或新版本。补丁新增的文件会移到备份里的 `displaced/`，原备份继续保留。回退之后正常重启 DSH。

自定义安装位置或 profile：

```bash
node bin/dsh-patches.mjs doctor \
  --app '/Applications/DeepSeek Harness.app' \
  --profile "$HOME/.dsh/profiles/desktop" \
  --json
```

所有命令支持 `--json`。退出码：`0` 为该命令完成；`1` 为操作被拒绝或失败；`2` 为不支持的安装状态或仍需运行时激活。比如修复文件已经通过验收、但需要重启应用时，`repair` 返回 `2`。`verify` 不检查当前应用运行状态。

## 适用范围

| 补丁 | DSH | 插件 | 状态 |
| --- | --- | --- | --- |
| `ds-bot-prompt-tools` | `0.2.2-rc.1` | `ds-bot@0.2.7` | macOS 实际安装包及真实 Bot 对话已验证 |

版本或文件指纹不同会拒绝修改。新版上游可能已经修复，也可能换了接口，需要重新核对后更新规则。这个仓库可以持续保存修复方案，不能用一个旧补丁自动解决所有未来故障。

## 为后续问题添加补丁

在 `patches/catalog.json` 新增独立补丁，记录准确的版本、原文件与修复文件指纹、最小替换规则及新增文件。每项补丁在 `patches/<id>/` 保存资源与安装包验收脚本，再为修复、重装后重新应用、拒绝未知文件、回退和卸载行为增加测试。

```bash
npm test
```

自动测试使用临时目录，不修改真实用户 profile。CI 在 macOS、Linux、Windows 验证通用文件操作；这不等于 Linux/Windows 的 DSH 客户端已验收。

## 这次故障的原因

DSH `0.2.2-rc.1` 的 `system-prompt/assemble` 回调只处理提示词展示内容，工具声明在回调外组装。DS-Bot `0.2.7` 继续读取 `assembled.tools.filter(...)`，在调用模型前报错。

补丁让回调兼容缺少工具字段的情况，并在最终完成的 assembly 上保留原有的 Bot 工具过滤。普通 DSH 会话保持原工具列表，卸载插件会还原组装方法。

上游：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[DS-Bot](https://github.com/Fei2411/DS-Bot)。这是独立维护的本机兼容补丁工具，不是上游发行版。
