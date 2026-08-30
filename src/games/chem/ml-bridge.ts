import { DIRS } from '../../core/protocol'
import type { Dir } from '../../core/protocol'
import {
  initialState,
  isShielded,
  resolveChemStep,
  stateKey,
} from './engine'
import type { ChemState, ChemTransitionEvent } from './engine'
import type { ChemLevel } from './level'

export const CHEM_ML_PROTOCOL_VERSION = 1
export const CHEM_ML_COLORS = ['red', 'blue', 'green', 'yellow', 'purple'] as const

const dirIndex = (dir: Dir): number => DIRS.indexOf(dir)

function colorIndex(color: string | null | undefined): number {
  if (color === null || color === undefined) return 0
  const index = CHEM_ML_COLORS.indexOf(color as (typeof CHEM_ML_COLORS)[number])
  if (index < 0) throw new Error(`ML bridge 遇到未登记颜色：${color}`)
  return index + 1
}

export interface ChemMlGoalDescriptor {
  center: number
  arm: number
  color: number
}

export interface ChemMlCenterDescriptor {
  pos: readonly [number, number]
  kind: 0 | 1
  shieldUntilStage: number
  ejects: 0 | 1
  hitLights: 0 | 1
  hitCenters: 0 | 1
  reactiveTo: ChemMlGoalDescriptor | null
}

export interface ChemMlLevelDescriptor {
  ordinal: number
  id: string
  name: string | null
  width: number
  height: number
  walls: readonly (readonly [number, number])[]
  lights: readonly (readonly [number, number])[]
  centers: readonly ChemMlCenterDescriptor[]
  stages: readonly (readonly ChemMlGoalDescriptor[])[]
  par: number | null
  moveLimit: number | null
}

export interface ChemMlCenterObservation {
  arms: readonly [number, number, number, number]
  leaving: number
  shielded: 0 | 1
}

export interface ChemMlGroupObservation {
  pos: readonly [number, number]
  color: number
}

export interface ChemMlObservation {
  levelOrdinal: number
  player: readonly [number, number]
  holding: number
  centers: readonly ChemMlCenterObservation[]
  groups: readonly ChemMlGroupObservation[]
  stage: number
  moves: number
  moveLimit: number | null
  won: boolean
  progress: number
}

export interface ChemMlEventCounts {
  attacks: number
  flips: number
  ejections: number
  resonanceFlips: number
  maxDepth: number
  waves: number
}

export interface ChemMlStepObservation {
  observation: ChemMlObservation
  effective: boolean
  events: ChemMlEventCounts
  stateKey?: string
}

export interface ChemMlInstance {
  ordinal: number
  level: ChemLevel
  state: ChemState
}

export function describeChemLevelForMl(level: ChemLevel, ordinal: number): ChemMlLevelDescriptor {
  return {
    ordinal,
    id: level.id,
    name: level.name ?? null,
    width: level.width,
    height: level.height,
    walls: level.walls,
    lights: level.lights,
    centers: level.centers.map((center) => ({
      pos: center.pos,
      kind: center.kind === 'trigonal' ? 1 : 0,
      shieldUntilStage: center.shieldUntilStage ?? -1,
      ejects: center.ejects ? 1 : 0,
      hitLights: center.hitLights ? 1 : 0,
      hitCenters: center.hitCenters ? 1 : 0,
      reactiveTo: center.reactiveTo
        ? {
            center: center.reactiveTo.center,
            arm: dirIndex(center.reactiveTo.arm),
            color: colorIndex(center.reactiveTo.color),
          }
        : null,
    })),
    stages: level.stages.map((stage) =>
      stage.goals.map((goal) => ({
        center: goal.center,
        arm: dirIndex(goal.arm),
        color: colorIndex(goal.color),
      })),
    ),
    par: level.par ?? null,
    moveLimit: level.moveLimit ?? null,
  }
}

/** 只编码玩家可见状态，不注入 solver 距离、最优动作或关卡 ID 特征。 */
export function observeChemForMl(state: ChemState, ordinal: number): ChemMlObservation {
  const totalStages = Math.max(1, state.stages.length)
  const active = state.stages[state.stage]
  const matches = active
    ? active.goals.filter(
        (goal) => state.centers[goal.center].arms[goal.arm] === goal.color,
      ).length
    : 0
  const progress = state.stage >= state.stages.length
    ? 1
    : (state.stage + matches / Math.max(1, active.goals.length)) / totalStages

  return {
    levelOrdinal: ordinal,
    player: state.player,
    holding: colorIndex(state.holding),
    centers: state.centers.map((center) => ({
      arms: DIRS.map((dir) => colorIndex(center.arms[dir])) as [number, number, number, number],
      leaving: dirIndex(center.leaving),
      shielded: isShielded(state, center) ? 1 : 0,
    })),
    groups: state.groups.map((group) => ({
      pos: group.pos,
      color: colorIndex(group.color),
    })),
    stage: state.stage,
    moves: state.moves,
    moveLimit: state.moveLimit ?? null,
    won: state.won,
    progress,
  }
}

function summarizeEvents(events: readonly ChemTransitionEvent[]): ChemMlEventCounts {
  const flips = events.filter((event) => event.type === 'flip')
  return {
    attacks: events.filter((event) => event.type === 'attack').length,
    flips: flips.length,
    ejections: events.filter((event) => event.type === 'ejection').length,
    resonanceFlips: flips.filter((event) => event.cause === 'resonance').length,
    maxDepth: flips.reduce((max, event) => Math.max(max, event.depth), 0),
    waves: new Set(flips.map((event) => event.wave)).size,
  }
}

export function createChemMlInstance(
  level: ChemLevel,
  ordinal: number,
  removeMoveLimit = false,
): ChemMlInstance {
  const effectiveLevel = removeMoveLimit && level.moveLimit !== undefined
    ? { ...level, moveLimit: undefined }
    : level
  return { ordinal, level: effectiveLevel, state: initialState(effectiveLevel) }
}

export function stepChemMlInstance(
  instance: ChemMlInstance,
  actionIndex: number,
  includeStateKey = false,
): { instance: ChemMlInstance; result: ChemMlStepObservation } {
  const action = DIRS[actionIndex]
  if (!action) throw new Error(`ML bridge 动作索引越界：${actionIndex}`)
  const beforeKey = stateKey(instance.state)
  const transition = resolveChemStep(instance.state, action)
  const next: ChemMlInstance = { ...instance, state: transition.state }
  return {
    instance: next,
    result: {
      observation: observeChemForMl(next.state, next.ordinal),
      effective: stateKey(next.state) !== beforeKey,
      events: summarizeEvents(transition.events),
      ...(includeStateKey ? { stateKey: stateKey(next.state) } : {}),
    },
  }
}

export const chemMlActionOrder: readonly Dir[] = DIRS

