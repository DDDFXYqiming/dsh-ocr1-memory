import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRenderer } from '../lib/core.js'

const execFileP = promisify(execFile)

test('RG1 long no-space CJK wraps into multiple visible lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1-render-'))
  try {
    const output = join(dir, 'cjk.png')
    const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: join(process.cwd(), 'scripts', 'render_memory.py') })
    await renderer([{ id: 1, content: '汉'.repeat(400) }], output, { width: 640, som: true })
    const { stdout } = await execFileP(process.env.PYTHON || 'python', ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.width, im.height)', output])
    const [width, height] = stdout.trim().split(/\s+/).map(Number)
    assert.equal(width, 640)
    // The old renderer treated all 400 CJK glyphs as one clipped line and
    // emitted the 200px minimum canvas. Character fallback must grow the page.
    assert.ok(height > 400, `expected wrapped multi-line image, got ${width}x${height}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RG2 paper square mode bicubic-resizes without clipping content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1-square-'))
  try {
    const output = join(dir, 'paper.png')
    const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: join(process.cwd(), 'scripts', 'render_memory.py') })
    await renderer([
      { id: 1, content: '汉'.repeat(400) },
      { id: 2, content: 'Second evidence paragraph remains on the same optical page.' },
    ], output, { width: 512, som: true, square: true })
    const { stdout } = await execFileP(process.env.PYTHON || 'python', ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.width, im.height)', output])
    assert.equal(stdout.trim(), '512 512')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
