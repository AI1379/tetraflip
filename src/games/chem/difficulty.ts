import { cellKey } from '../../core/protocol'
import type { Dir } from '../../core/protocol'
import { solve } from '../../core/solver'
import {
  analyzeStateGraph,
  enumerateStateGraph,
} from '../../core/state-graph'
import type { EnumerateStateGraphOptions, StateGraphDifficulty } from '../../core/state-graph'
import { chemGame, initialState, resolveChemStep } from './engine'
import type { ChemState } from './engine'
import type { ChemLevel } from './level'

export interface ChemMechanismProfile {
  carry: boolean
  resonance: boolean
  light: boolean
  stages: boolean
  hole: boolean
  eject: boolean
  stageShield: boolean
  hitLight: boolean
  hitCenter: boolean
  reactiveShield: boolean
  budget: boolean
  activeCount: number
}

export interface ChemExecutionMetrics {
  shortestSteps: number
  interactionSteps: number
  walkingSteps: number
  interactionDensity: number
  maxWalkingRun: number
  repeatedLightEntries: number
  budgetSlack: number | null
}

export interface ChemCausalMetrics {
  maxFlipsPerAction: number
  maxCentersChangedPerAction: number
  maxPropagationDepth: number
  maxWavesPerAction: number
  stageAdvanceActions: number
  ejectionActions: number
}

export interface ChemExactDifficulty {
  levelId: string
  name: string | null
  par: number | null
  mechanisms: ChemMechanismProfile
  graph: StateGraphDifficulty
  execution: ChemExecutionMetrics
  causal: ChemCausalMetrics
}

const adjacentCenters = (level: ChemLevel): boolean =>
  level.centers.some((a, index) =>
    level.centers.some(
      (b, other) =>
        other !== index &&
        Math.abs(a.pos[0] - b.pos[0]) + Math.abs(a.pos[1] - b.pos[1]) === 1,
    ),
  )

export function chemMechanismProfile(level: ChemLevel): ChemMechanismProfile {
  const profile = {
    carry: level.groups.length > 0,
    resonance: adjacentCenters(level),
    light: level.lights.length > 0,
    stages: level.stages.length > 1,
    hole: level.centers.some((center) => center.kind === 'trigonal'),
    eject: level.centers.some((center) => center.ejects),
    stageShield: level.centers.some((center) => center.shieldUntilStage !== undefined),
    hitLight: level.centers.some((center) => center.hitLights),
    hitCenter: level.centers.some((center) => center.hitCenters),
    reactiveShield: level.centers.some((center) => center.reactiveTo !== undefined),
    budget: level.moveLimit !== undefined,
  }
  return {
    ...profile,
    activeCount: Object.values(profile).filter(Boolean).length,
  }
}

const mechanismKey = (state: ChemState): string =>
  JSON.stringify({
    holding: state.holding,
    centers: state.centers.map((center) => ({
      arms: center.arms,
      leaving: center.leaving,
    })),
    groups: state.groups,
    stage: state.stage,
  })

function canonicalTraceMetrics(
  level: ChemLevel,
): { execution: ChemExecutionMetrics; causal: ChemCausalMetrics } {
  const result = solve(chemGame, level, {
    maxDepth: Math.max(32, (level.par ?? 0) + 2),
    maxVisits: 500_000,
  })
  if (!result.solved) throw new Error(`${level.id} 在精确难度分析中不可解`)

  let state = initialState(level)
  let interactions = 0
  let walking = 0
  let walkingRun = 0
  let maxWalkingRun = 0
  let repeatedLightEntries = 0
  const lightVisits = new Map<string, number>()
  let maxFlips = 0
  let maxCentersChanged = 0
  let maxPropagationDepth = 0
  let maxWaves = 0
  let stageAdvanceActions = 0
  let ejectionActions = 0

  for (const action of result.solution as readonly Dir[]) {
    const before = state
    const transition = resolveChemStep(before, action)
    state = transition.state
    const moved = before.player[0] !== state.player[0] || before.player[1] !== state.player[1]
    const interaction = !moved || mechanismKey(before) !== mechanismKey(state)
    if (interaction) {
      interactions++
      walkingRun = 0
    } else {
      walking++
      walkingRun++
      maxWalkingRun = Math.max(maxWalkingRun, walkingRun)
    }

    if (moved) {
      const key = cellKey(state.player[0], state.player[1])
      if (level.lights.some(([x, y]) => cellKey(x, y) === key)) {
        const visits = (lightVisits.get(key) ?? 0) + 1
        lightVisits.set(key, visits)
        if (visits > 1) repeatedLightEntries++
      }
    }

    const flips = transition.events.filter((event) => event.type === 'flip')
    const changed = new Set(flips.map((event) => event.center))
    maxFlips = Math.max(maxFlips, flips.length)
    maxCentersChanged = Math.max(maxCentersChanged, changed.size)
    maxPropagationDepth = Math.max(
      maxPropagationDepth,
      ...flips.map((event) => event.depth),
    )
    maxWaves = Math.max(maxWaves, new Set(flips.map((event) => event.wave)).size)
    if (state.stage > before.stage) stageAdvanceActions++
    if (transition.events.some((event) => event.type === 'ejection')) ejectionActions++
  }

  const steps = result.solution.length
  return {
    execution: {
      shortestSteps: steps,
      interactionSteps: interactions,
      walkingSteps: walking,
      interactionDensity: steps === 0 ? 0 : interactions / steps,
      maxWalkingRun,
      repeatedLightEntries,
      budgetSlack: level.moveLimit === undefined ? null : level.moveLimit - steps,
    },
    causal: {
      maxFlipsPerAction: maxFlips,
      maxCentersChangedPerAction: maxCentersChanged,
      maxPropagationDepth,
      maxWavesPerAction: maxWaves,
      stageAdvanceActions,
      ejectionActions,
    },
  }
}

export interface AnalyzeChemDifficultyOptions extends EnumerateStateGraphOptions {
  /** 未指定 maxDepth 时，在 par 后额外枚举多少层用于恢复分析。默认 6。 */
  recoveryHorizon?: number
}

export function analyzeChemDifficulty(
  level: ChemLevel,
  options: AnalyzeChemDifficultyOptions = {},
): ChemExactDifficulty {
  const recoveryHorizon = options.recoveryHorizon ?? 6
  const maxDepth = options.maxDepth ?? Math.max(32, (level.par ?? 0) + recoveryHorizon)
  const graph = enumerateStateGraph(chemGame, initialState(level), {
    maxDepth,
    maxStates: options.maxStates,
  })
  const trace = canonicalTraceMetrics(level)
  return {
    levelId: level.id,
    name: level.name ?? null,
    par: level.par ?? null,
    mechanisms: chemMechanismProfile(level),
    graph: analyzeStateGraph(graph),
    ...trace,
  }
}

