/**
 * Python 离线代理的常驻 JSONL bridge。stdout 只输出协议包，调试信息必须走 stderr。
 *
 * 启动：pnpm exec vite-node scripts/chem-ml-bridge.ts
 */
import { createInterface } from 'node:readline'
import { loadChemLevels } from './difficulty-shared'
import {
  CHEM_ML_COLORS,
  CHEM_ML_PROTOCOL_VERSION,
  chemMlActionOrder,
  createChemMlInstance,
  describeChemLevelForMl,
  observeChemForMl,
  stepChemMlInstance,
} from '../src/games/chem/ml-bridge'
import type { ChemMlInstance } from '../src/games/chem/ml-bridge'
import { stateKey } from '../src/games/chem/engine'

type JsonRecord = Record<string, unknown>

interface HelloCommand {
  type: 'hello'
}

interface ResetCommand {
  type: 'reset'
  levels: number[]
  removeMoveLimit: boolean
  includeStateKeys: boolean
}

interface ResetIndicesCommand {
  type: 'resetIndices'
  indices: number[]
  levels: number[]
  removeMoveLimit: boolean
  includeStateKeys: boolean
}

interface StepCommand {
  type: 'step'
  actions: number[]
  includeStateKeys: boolean
}

interface TraceCommand {
  type: 'trace'
  level: number
  actions: number[]
  removeMoveLimit: boolean
}

type BridgeCommand = HelloCommand | ResetCommand | ResetIndicesCommand | StepCommand | TraceCommand

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function integerArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
    throw new Error(`${name} 必须是整数数组`)
  }
  return value as number[]
}

const optionalBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error('布尔选项类型错误')
  return value
}

function parseCommand(line: string): BridgeCommand {
  const parsed: unknown = JSON.parse(line)
  if (!isRecord(parsed) || typeof parsed.type !== 'string') throw new Error('缺少 command.type')
  switch (parsed.type) {
    case 'hello':
      return { type: 'hello' }
    case 'reset':
      return {
        type: 'reset',
        levels: integerArray(parsed.levels, 'levels'),
        removeMoveLimit: optionalBoolean(parsed.removeMoveLimit, false),
        includeStateKeys: optionalBoolean(parsed.includeStateKeys, false),
      }
    case 'resetIndices':
      return {
        type: 'resetIndices',
        indices: integerArray(parsed.indices, 'indices'),
        levels: integerArray(parsed.levels, 'levels'),
        removeMoveLimit: optionalBoolean(parsed.removeMoveLimit, false),
        includeStateKeys: optionalBoolean(parsed.includeStateKeys, false),
      }
    case 'step':
      return {
        type: 'step',
        actions: integerArray(parsed.actions, 'actions'),
        includeStateKeys: optionalBoolean(parsed.includeStateKeys, false),
      }
    case 'trace': {
      if (!Number.isInteger(parsed.level)) throw new Error('level 必须是整数')
      return {
        type: 'trace',
        level: parsed.level as number,
        actions: integerArray(parsed.actions, 'actions'),
        removeMoveLimit: optionalBoolean(parsed.removeMoveLimit, false),
      }
    }
    default:
      throw new Error(`未知 command.type：${parsed.type}`)
  }
}

const namedLevels = loadChemLevels()
const levelByOrdinal = new Map(namedLevels.map((row) => [row.ordinal, row.level]))
let instances: ChemMlInstance[] = []

function levelAt(ordinal: number) {
  const level = levelByOrdinal.get(ordinal)
  if (!level) throw new Error(`不存在物理关卡 ${ordinal}`)
  return level
}

function resetObservation(instance: ChemMlInstance, includeStateKey: boolean) {
  return {
    observation: observeChemForMl(instance.state, instance.ordinal),
    effective: false,
    events: { attacks: 0, flips: 0, ejections: 0, resonanceFlips: 0, maxDepth: 0, waves: 0 },
    ...(includeStateKey ? { stateKey: instance.state.won ? 'won' : undefined } : {}),
  }
}

function stateKeyResult(instance: ChemMlInstance, includeStateKey: boolean) {
  if (!includeStateKey) return resetObservation(instance, false)
  return { ...resetObservation(instance, false), stateKey: stateKey(instance.state) }
}

function handle(command: BridgeCommand): unknown {
  if (command.type === 'hello') {
    return {
      ok: true,
      type: 'hello',
      protocolVersion: CHEM_ML_PROTOCOL_VERSION,
      actionOrder: chemMlActionOrder,
      colors: CHEM_ML_COLORS,
      levels: namedLevels.map((row) => describeChemLevelForMl(row.level, row.ordinal)),
    }
  }

  if (command.type === 'reset') {
    instances = command.levels.map((ordinal) =>
      createChemMlInstance(levelAt(ordinal), ordinal, command.removeMoveLimit),
    )
    return {
      ok: true,
      type: 'reset',
      items: instances.map((instance) => stateKeyResult(instance, command.includeStateKeys)),
    }
  }

  if (command.type === 'resetIndices') {
    if (command.indices.length !== command.levels.length) {
      throw new Error('indices 与 levels 长度必须相同')
    }
    const items: { index: number; item: ReturnType<typeof stateKeyResult> }[] = []
    for (let offset = 0; offset < command.indices.length; offset++) {
      const index = command.indices[offset]
      if (index < 0 || index >= instances.length) throw new Error(`resetIndices 越界：${index}`)
      const ordinal = command.levels[offset]
      const instance = createChemMlInstance(levelAt(ordinal), ordinal, command.removeMoveLimit)
      instances[index] = instance
      items.push({ index, item: stateKeyResult(instance, command.includeStateKeys) })
    }
    return { ok: true, type: 'resetIndices', items }
  }

  if (command.type === 'step') {
    if (command.actions.length !== instances.length) {
      throw new Error(`actions 长度 ${command.actions.length} 与环境数 ${instances.length} 不同`)
    }
    const items = instances.map((instance, index) => {
      const stepped = stepChemMlInstance(instance, command.actions[index], command.includeStateKeys)
      instances[index] = stepped.instance
      return stepped.result
    })
    return { ok: true, type: 'step', items }
  }

  let instance = createChemMlInstance(
    levelAt(command.level),
    command.level,
    command.removeMoveLimit,
  )
  const totals = { attacks: 0, flips: 0, ejections: 0, resonanceFlips: 0, maxDepth: 0, waves: 0 }
  for (const action of command.actions) {
    const stepped = stepChemMlInstance(instance, action, true)
    instance = stepped.instance
    totals.attacks += stepped.result.events.attacks
    totals.flips += stepped.result.events.flips
    totals.ejections += stepped.result.events.ejections
    totals.resonanceFlips += stepped.result.events.resonanceFlips
    totals.maxDepth = Math.max(totals.maxDepth, stepped.result.events.maxDepth)
    totals.waves += stepped.result.events.waves
  }
  return {
    ok: true,
    type: 'trace',
    observation: observeChemForMl(instance.state, instance.ordinal),
    stateKey: stateKey(instance.state),
    events: totals,
  }
}

const emit = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (line.trim().length === 0) return
  try {
    const command = parseCommand(line)
    emit(handle(command))
  } catch (error) {
    emit({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
