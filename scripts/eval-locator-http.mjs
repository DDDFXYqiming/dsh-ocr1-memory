#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createOcrLocatorHttpClient } from '../lib/core.js'

function option(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const manifest = resolve(option('manifest', 'data/hotpotqa-30/train.jsonl'))
const baseUrl = option('base-url', 'http://127.0.0.1:18081/v1')
const model = option('model', 'deepseek-ocr-memory')
const limit = Math.max(1, Number(option('limit', '12')) || 12)
const timeoutMs = Math.max(1, Number(option('timeout-ms', '180000')) || 180000)
const rows = readFileSync(manifest, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .slice(0, limit)
  .map((line) => JSON.parse(line))

const locate = createOcrLocatorHttpClient({ baseUrl, model, timeoutMs })
let exact = 0
let f1Sum = 0
let failures = 0
for (const row of rows) {
  try {
    const result = await locate(resolve(row.image), row.question, row.labels.length)
    const got = result.labels
    const gold = row.labels
    if (got.every((value, index) => value === gold[index])) exact += 1
    let tp = 0
    let fp = 0
    let fn = 0
    for (let index = 0; index < gold.length; index += 1) {
      if (gold[index] && got[index]) tp += 1
      else if (!gold[index] && got[index]) fp += 1
      else if (gold[index] && !got[index]) fn += 1
    }
    const precision = tp + fp ? tp / (tp + fp) : 0
    const recall = tp + fn ? tp / (tp + fn) : 0
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0
    f1Sum += f1
    console.log(`${row.id} f1=${f1.toFixed(3)} raw=${result.raw}`)
  } catch (error) {
    failures += 1
    console.error(`${row.id} ERROR ${error?.message || error}`)
  }
}

const evaluated = rows.length
const summary = {
  manifest,
  baseUrl,
  model,
  evaluated,
  exact,
  failures,
  meanF1: evaluated ? Number((f1Sum / evaluated).toFixed(6)) : 0,
}
console.log(`SUMMARY ${JSON.stringify(summary)}`)
if (failures) process.exitCode = 1
