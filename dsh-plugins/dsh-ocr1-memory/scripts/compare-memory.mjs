// Compare dsh-ocr1-memory vs dsh-memory in isolated DSH headless profiles.
// Usage: node scripts/compare-memory.mjs
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileP = promisify(execFile)

const TASKS = [
  {
    id: 'R1',
    name: 'accurate retrieval',
    fact: 'Orbit API 的 token 10 分钟过期',
    query: 'Orbit API token 过期时间',
    expected: ['Orbit API', '10 分钟'],
    prompt: (fact) => `使用记忆工具完成：先存储事实“${fact}”，然后检索“Orbit API token 过期时间”。最后把检索到的原始内容完整输出。`,
  },
  {
    id: 'R2',
    name: 'test-time learning',
    fact: '用户要求所有回复使用中文',
    query: '用户回复语言要求',
    expected: ['中文'],
    prompt: (fact) => `使用记忆工具完成：先存储规则“${fact}”，然后检索“用户回复语言要求”。最后把检索到的原始内容完整输出。`,
  },
  {
    id: 'R3',
    name: 'long-range understanding',
    fact: '第 17 条：项目的数据库密码是 S3cret-17',
    query: '第 17 条数据库密码',
    expected: ['S3cret-17'],
    prompt: (fact) => `使用记忆工具完成：先连续存储 20 条事实，其中第 17 条是“${fact}”，其他 19 条都是无关内容。然后检索“第 17 条数据库密码”。最后把检索到的原始内容完整输出。`,
  },
  {
    id: 'R4',
    name: 'conflict resolution',
    factOld: '服务器地址是 A',
    factNew: '服务器地址改为 B',
    query: '当前服务器地址',
    expected: ['B'],
    prompt: (oldF, newF) => `使用记忆工具完成：先存储“${oldF}”，再存储“${newF}”。然后检索“当前服务器地址”。最后把检索到的原始内容完整输出。`,
  },
  {
    id: 'R5',
    name: 'selective forgetting',
    fact: '临时密码是 Temp-123',
    expected: ['NOT_FOUND'],
    prompt: (fact) => `使用记忆工具完成：先存储“${fact}”，然后使用遗忘/删除/归档工具移除这条记忆，最后检索“临时密码”。如果找不到就输出 NOT_FOUND。`,
  },
]

// No-kill safety: default timeout is 0 (no timeout) so the comparison never
// kills a dsh subprocess. Set COMPARE_TIMEOUT_MS to a positive number only if
// you explicitly want a hard timeout (which would terminate the child).
async function runDsh(patchFiles, prompt, timeoutMs = Number(process.env.COMPARE_TIMEOUT_MS || 0)) {
  const args = ['--profile', 'headless']
  for (const p of patchFiles) args.push('--patch', p)
  args.push(prompt)
  const { stdout } = await execFileP('dsh', args, { shell: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

function score(output, expected) {
  const hits = expected.filter((s) => output.includes(s))
  return { exact: hits.length === expected.length, hitCount: hits.length, total: expected.length }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'memcmp-'))
  const dirA = join(root, 'ocr1-store')
  const dirB = join(root, 'memory-store')
  const patchA = join(root, 'profile-a.yml')
  const patchB = join(root, 'profile-b.yml')
  // By default the benchmark exercises OCR read-back but not per-store image
  // embeddings (embedding makes multi-store tasks much slower). Set
  // COMPARE_WITH_EMBEDDING=1 to also enable the 1280d DeepSeek-OCR embeddings.
  const withEmbedding = process.env.COMPARE_WITH_EMBEDDING === '1'
  const ocr1Config = [
    `storeDir: '${dirA.replace(/\\/g, '/')}'`,
    `ocrBaseUrl: 'http://127.0.0.1:18080/v1'`,
    `ocrModel: 'deepseek-ocr'`,
    `requireOcr: true`,
    `ocrRepeatPenalty: 1.2`,
    `ocrNoRepeatNgramSize: 30`,
  ]
  if (withEmbedding) {
    ocr1Config.push(
      `ocrEmbeddingBaseUrl: 'http://127.0.0.1:18084/v1'`,
      `ocrEmbeddingModel: 'deepseek-ocr'`,
      `ocrEmbeddingEmptyPromptTokens: 1`,
      `ocrEmbeddingAutoStart: false`,
    )
  }
  writeFileSync(patchA, `- id: dsh-memory\n  disabled: true\n- id: dsh-ocr1-memory\n  config:\n    ${ocr1Config.join('\n    ')}\n`)
  writeFileSync(patchB, `- id: dsh-ocr1-memory\n  disabled: true\n- id: dsh-memory\n  config:\n    memoryDir: '${dirB.replace(/\\/g, '/')}'\n`)

  const results = []
  for (const task of TASKS) {
    const prompt = task.prompt(task.fact, task.factNew)
    for (const [label, patch] of [['ocr1', patchA], ['memory', patchB]]) {
      const t0 = Date.now()
      try {
        const out = await runDsh([patch], prompt)
        const s = score(out, task.expected)
        results.push({ task: task.id, system: label, ...s, latencyMs: Date.now() - t0 })
        console.log(`${task.id} ${label}: exact=${s.exact} hits=${s.hitCount}/${s.total} latency=${Date.now() - t0}ms`)
      } catch (err) {
        const detail = err.stderr || err.message || String(err)
        results.push({ task: task.id, system: label, exact: false, hitCount: 0, total: task.expected.length, latencyMs: Date.now() - t0, error: detail })
        console.error(`${task.id} ${label}: ERROR ${detail}`)
      }
    }
  }

  // R6: multi-session persistence (two separate DSH invocations sharing store)
  for (const [label, patch] of [['ocr1', patchA], ['memory', patchB]]) {
    const storePrompt = '使用记忆工具存储事实：用户喜欢喝咖啡。'
    const retrievePrompt = '使用记忆工具检索：用户喜欢喝什么？最后把检索到的原始内容完整输出。'
    const t0 = Date.now()
    try {
      await runDsh([patch], storePrompt)
      const out = await runDsh([patch], retrievePrompt)
      const s = score(out, ['咖啡'])
      results.push({ task: 'R6', system: label, ...s, latencyMs: Date.now() - t0 })
      console.log(`R6 ${label}: exact=${s.exact} hits=${s.hitCount}/${s.total} latency=${Date.now() - t0}ms`)
    } catch (err) {
      const detail = err.stderr || err.message || String(err)
      results.push({ task: 'R6', system: label, exact: false, hitCount: 0, total: 1, latencyMs: Date.now() - t0, error: detail })
      console.error(`R6 ${label}: ERROR ${detail}`)
    }
  }

  console.log('\nSUMMARY')
  for (const r of results) {
    console.log(`${r.task} ${r.system}: ${r.exact ? 'PASS' : 'FAIL'} (${r.hitCount}/${r.total})${r.error ? ' ' + r.error : ''}`)
  }

  rmSync(root, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
