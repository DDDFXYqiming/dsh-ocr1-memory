import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject } from '../lib/index.js'
import { readMemoryIndexContext } from '../lib/context.js'

async function makeContext() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr1-integration-'))
  const registeredTools = []
  const listeners = new Map()
  const skills = []
  const prompts = []
  const injected = []
  const effects = []
  const agent = { id: 'agent-a', inject(value) { injected.push(value) } }
  const services = {
    agents: { get(id) { return id === agent.id ? agent : null } },
    sessionQuery: null,
  }
  const ctx = {
    tools: {
      register(tool) {
        registeredTools.push(tool)
        return () => {}
      },
    },
    skills: {
      register(skill) {
        skills.push(skill)
        return () => {}
      },
    },
    systemPrompt: {
      context(value) {
        prompts.push(value)
        return () => {}
      },
    },
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') effects.push(disposer)
    },
    get(name) {
      return services[name]
    },
    on(name, listener) {
      const list = listeners.get(name) || []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) || []
        listeners.set(name, current.filter((item) => item !== listener))
      }
    },
  }
  apply(ctx, {
    storeDir: dir,
    memoryDir: dir,
    useMockRenderer: true,
    autoNamespace: false,
    defaultNamespace: 'test',
    autoInjectContext: true,
    contextMode: 'index',
    autoPending: true,
    maintainEveryTurns: 1,
    reflectPendingThreshold: 1,
    reflectSopsThreshold: 100,
  })
  return {
    dir,
    ctx,
    registeredTools,
    listeners,
    skills,
    prompts,
    injected,
    async close() {
      for (const f of effects) await f()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function tool(env, name) {
  const result = env.registeredTools.find((item) => item.name === name)
  assert.ok(result, `missing tool ${name}`)
  return result
}

async function emit(env, name, ...args) {
  for (const listener of env.listeners.get(name) || []) await listener(...args)
}

test('plugin wires governance, runtime skill, optical-backed writes, and L1 context', async () => {
  const env = await makeContext()
  try {
    assert.deepEqual(inject, ['tools', 'systemPrompt', 'skills', 'agents', 'sessionQuery'])
    assert.equal(env.registeredTools.length, 26)
    assert.ok(env.skills.some((skill) => skill.name === 'memory'))
    assert.ok(env.prompts.some((prompt) => prompt.name === 'ocr1-memory:index'))

    const write = await tool(env, 'memory_write').execute({
      topic: 'runtime-fact',
      entry_type: 'fact',
      content: 'The integration path is verified.',
      evidence: 'integration test completed successfully',
    })
    assert.equal(write.optical.tier, 'vivid')
    const read = await tool(env, 'memory_read').execute({ name: 'runtime-fact' })
    assert.match(read.content, /integration path/)
    await tool(env, 'ocr1_mem_update').execute({
      id: write.optical.id,
      text: 'The integration path is updated and verified.',
    })
    const synchronized = await tool(env, 'memory_read').execute({ name: 'runtime-fact' })
    assert.match(synchronized.content, /updated and verified/)
    const retrieved = await tool(env, 'memory_retrieve').execute({ query: 'updated verified', topK: 3 })
    assert.equal(retrieved.optical_backend, true)
    assert.equal(retrieved.results[0].retrieval, 'optical')
    const searched = await tool(env, 'memory_search').execute({ query: 'integration path', namespace: 'test' })
    assert.equal(searched.results[0].namespace, 'test')
    const promoted = await tool(env, 'memory_promote').execute({
      topic: 'runtime-fact',
      entry_type: 'fact',
      from_namespace: 'test',
      to_namespace: 'default',
      archive_source: false,
    })
    assert.equal(promoted.promoted, true)
    const promotedRead = await tool(env, 'memory_read').execute({ name: 'runtime-fact', namespace: 'default' })
    assert.match(promotedRead.content, /integration path/)

    const indexContext = readMemoryIndexContext({
      memoryDir: env.dir,
      defaultNamespace: 'test',
      autoNamespace: false,
      opticalStoreDir: env.dir,
      maxEntries: 3,
      maxChars: 2000,
    })
    assert.match(indexContext, /runtime-fact/)
    assert.doesNotMatch(indexContext, /The integration path is verified\./)
  } finally {
    await env.close()
  }
})

test('tools/result then turn/end creates pending and reflection without formal auto-write', async () => {
  const env = await makeContext()
  try {
    await emit(env, 'tools/result', { agent: { id: 'agent-a' }, name: 'shell' }, { isError: true, error: 'first failure' })
    await emit(env, 'tools/result', { agent: { id: 'agent-a' }, name: 'shell' }, { isError: false, text: 'verified success' })
    await emit(env, 'session/event', { id: 'agent-a' }, { type: 'turn/end', seq: 7 })

    const pending = await tool(env, 'memory_pending').execute({ namespace: 'test' })
    assert.equal(pending.pending.length, 1)
    assert.match(pending.pending[0].content, /retry-sequence/)
    assert.equal(env.injected.length, 1)
    assert.match(env.injected[0].content[0].text, /pending 候选/)

    const state = JSON.parse(await readFile(join(env.dir, 'test', 'turn-state.json'), 'utf8'))
    assert.equal(state.totalTurns, 1)
    await new Promise((resolve) => setImmediate(resolve))
    const report = JSON.parse(await readFile(join(env.dir, 'test', 'maintenance-report.json'), 'utf8'))
    assert.equal(report.stats.facts, 0)
  } finally {
    await env.close()
  }
})
