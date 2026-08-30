/** 可复现的轻量 PRNG；只用于分析、随机化检验与 RL，不进入游戏规则。 */
export class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error('maxExclusive 必须是正整数')
    }
    return Math.floor(this.next() * maxExclusive)
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('不能从空数组取样')
    return items[this.int(items.length)]
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let index = out.length - 1; index > 0; index--) {
      const other = this.int(index + 1)
      ;[out[index], out[other]] = [out[other], out[index]]
    }
    return out
  }
}

