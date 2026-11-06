import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [pkg, runtimeRoot] = process.argv.slice(2)
if (!pkg || !runtimeRoot) throw new Error('Usage: verify.mjs <installed-package> <runtime-root>')
const load = name => import(pathToFileURL(join(runtimeRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const { Context } = await load('cordis')
const { createScope } = await load('dsh-scope')
const { default: SystemPrompt } = await load('dsh-system-prompt')
const { installPromptAssemblyCompat } = await import(pathToFileURL(join(pkg, 'src/host/prompt-assembly-compat.js')).href)
const patchedSource = readFileSync(join(pkg, 'src/host/tools.js'), 'utf8')
const originalFilter = '        tools: assembled.tools.filter(tool => !HIDDEN_TOOLS.includes(tool.name)),'
const guardedFilter = '        ...(Array.isArray(assembled.tools) ? { tools: assembled.tools.filter(tool => !HIDDEN_TOOLS.includes(tool.name)) } : {}),'
assert.ok(patchedSource.includes(guardedFilter))
const hidden = ['subagent', 'ask_user_question']
const callback = source => {
  const start = source.indexOf("agent.ctx.on('system-prompt/assemble', ") + "agent.ctx.on('system-prompt/assemble', ".length
  const end = source.indexOf('\n    })\n    held.filtered', start)
  assert.ok(start > 0 && end > start)
  return new Function('HIDDEN_TOOLS', 'HIDDEN_SECTIONS', 'return (' + source.slice(start, end) + '\n})')(hidden, new Set(['tool:subagent']))
}
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  ctx.systemPrompt.tools(() => ({ schemas: ['read', ...hidden].map(name => ({name, description: name, parameters: {}})) }))
  ctx.systemPrompt.section({ name: 'tool:subagent', order: 1, text: 'hidden guidance' })
  ctx.systemPrompt.context({ name: 'workdir', order: 1, text: 'preserved context' })
  const bot = { id: 'compat-test-bot', session: { id: 'compat-test-bot' } }
  let inner
  const scope = ctx.plugin(host => { inner = createScope(host, bot).ctx })
  await scope.await()
  const removeOld = inner.on('system-prompt/assemble', callback(patchedSource.replace(guardedFilter, originalFilter)))
  await assert.rejects(ctx.systemPrompt.assemble({scope: bot, agent: bot}), /Cannot read properties of undefined \(reading 'filter'\)/)
  console.log('PASS original DS-Bot 0.2.7 reproduces the exact failure against installed DSH runtime')
  removeOld()
  inner.on('system-prompt/assemble', callback(patchedSource))
  const patch = ctx.plugin(Object.assign(host => installPromptAssemblyCompat({ctx:host, isBotSession: id => id === bot.id},hidden), { inject: ['systemPrompt'] }))
  await patch.await()
  const assembled = await ctx.systemPrompt.assemble({scope: bot, agent: bot})
  assert.deepEqual(assembled.tools.map(tool=>tool.name), ['read'])
  assert.ok(!assembled.sections.some(section=>section.name==='tool:subagent'))
  assert.deepEqual(assembled.contexts,[{name:'workdir',text:'preserved context'}])
  console.log('PASS patched Bot assembly preserves normal tools and contexts, hides delegation and question tools')
  const normal = await ctx.systemPrompt.assemble({scope:{id:'normal'},agent:{id:'normal'}})
  assert.equal(normal.tools.length,3)
  assert.ok(normal.sections.some(section=>section.name==='tool:subagent'))
  console.log('PASS normal DSH sessions retain their tools and guidance')
  const fromScopeOnly = await ctx.systemPrompt.assemble({scope:bot})
  assert.deepEqual(fromScopeOnly.tools.map(tool=>tool.name),['read'])
  await patch.dispose()
  const restored = await ctx.systemPrompt.assemble({scope:bot,agent:bot})
  assert.equal(restored.tools.length,3)
  console.log('PASS scope-only callers and plugin disposal restore the original assembly method')
} finally { await ctx.fiber.dispose() }
