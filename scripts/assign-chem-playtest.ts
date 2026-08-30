/**
 * 熟练度队列的固定 seed 平衡区组。
 * pnpm playtest:assign -- --levels=37-43 --participants=24 --block-size=6
 *   --anchors=37,43 --seed=20260829 --output=artifacts/difficulty/assignments.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { balancedIncompleteBlocks } from '../src/core/balanced-assignment'
import { numberOption, option } from './difficulty-shared'

function parseLevels(raw: string): number[] {
  const values: number[] = []
  for (const part of raw.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part.trim())
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      for (let value = from; value <= to; value++) values.push(value)
    } else {
      values.push(Number(part))
    }
  }
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 75)) {
    throw new Error('--levels / --anchors 只能包含 1–75 的序号或升序范围')
  }
  return [...new Set(values)]
}

const levels = parseLevels(option('levels') ?? '37-43')
const participants = numberOption('participants', 24)
const blockSize = numberOption('block-size', Math.min(6, levels.length))
const seed = numberOption('seed', 20_260_829)
const anchors = option('anchors') ? parseLevels(option('anchors')!) : []
const output = resolve(process.cwd(), option('output') ?? 'artifacts/difficulty/assignments.json')
const blocks = balancedIncompleteBlocks(levels, {
  participants,
  blockSize,
  anchors,
  seed,
  idPrefix: 'M',
})
const assignments = blocks.map((block) => ({
  ...block,
  links: block.items.map((level) =>
    `/?game=chem&level=${level}&study=mastery&assignment=${block.assignmentId}&telemetry=1`,
  ),
}))
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), config: {
  levels, participants, blockSize, anchors, seed,
}, assignments }
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`已生成 ${assignments.length} 份平衡区组：${output}`)
