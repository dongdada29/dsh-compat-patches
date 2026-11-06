// DSH 0.2.2 keeps tools outside the presentation waterfall. Filter the completed
// assembly so Bot-local tools remain hidden before the request is logged or sent.
export function installPromptAssemblyCompat(rt, hiddenTools) {
  const service = rt.ctx.systemPrompt
  const descriptor = service === undefined ? undefined : Object.getOwnPropertyDescriptor(service, 'assemble')
  const assemble = service?.assemble
  if (typeof assemble !== 'function') return
  const hidden = new Set(hiddenTools)
  const compatible = async function (...args) {
    const assembled = await assemble.apply(this, args)
    const context = args[0]
    const agent = context?.agent ?? context?.scope
    const id = agent?.session?.id ?? agent?.id
    if (!rt.isBotSession(id)) return assembled
    return { ...assembled, tools: assembled.tools.filter(tool => !hidden.has(tool.name)) }
  }
  rt.ctx.effect(() => {
    service.assemble = compatible
    return () => {
      if (Object.getOwnPropertyDescriptor(service, 'assemble')?.value !== compatible) return
      if (descriptor === undefined) delete service.assemble
      else Object.defineProperty(service, 'assemble', descriptor)
    }
  }, 'ds-bot: DSH 0.2.2 prompt assembly compatibility')
}
