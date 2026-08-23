/** 关卡加载：文件名（level-XX.json，零填充）决定关卡顺序 */

export interface LoadedLevel<L> {
  file: string
  level: L
}

export function loadLevels<L>(
  records: Record<string, unknown>,
  parse: (json: unknown) => L,
): LoadedLevel<L>[] {
  return Object.entries(records)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, json]) => ({ file, level: parse(json) }))
}
