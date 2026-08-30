import { readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { chemGame } from '../src/games/chem'
import type { ChemLevel } from '../src/games/chem/level'

export interface NamedChemLevel {
  file: string
  ordinal: number
  level: ChemLevel
}

const levelsDir = resolve(process.cwd(), 'src/games/chem/levels')

function normalizeName(raw: string): string {
  const stem = basename(raw, '.json')
  if (stem.startsWith('level-')) return stem
  return `level-${stem.padStart(2, '0')}`
}

export function loadChemLevels(requested: readonly string[] = []): NamedChemLevel[] {
  const names = requested.length > 0
    ? requested.map(normalizeName)
    : readdirSync(levelsDir)
        .filter((file) => /^level-\d+\.json$/.test(file))
        .map((file) => basename(file, '.json'))
        .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
  return names.map((file) => ({
    file,
    ordinal: Number(file.slice(6)),
    level: chemGame.parseLevel(JSON.parse(readFileSync(resolve(levelsDir, `${file}.json`), 'utf8'))),
  }))
}

export function option(name: string): string | undefined {
  return process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

export function numberOption(name: string, fallback: number): number {
  const raw = option(name)
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value)) throw new Error(`--${name} 必须是数字`)
  return value
}

export function listOption(name: string, fallback: readonly number[]): number[] {
  const raw = option(name)
  if (raw === undefined) return [...fallback]
  const values = raw.split(',').map(Number)
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`--${name} 必须是逗号分隔数字`)
  }
  return values
}

export function positionalArgs(): string[] {
  return process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
}
