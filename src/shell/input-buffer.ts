/**
 * 回合制动画期间的单槽输入缓冲：只保留最新一步，避免丢键，也避免积累不可控长队列。
 */
export class SingleSlotInputBuffer<A> {
  private value: A | undefined

  get pending(): A | undefined {
    return this.value
  }

  queue(action: A): void {
    this.value = action
  }

  take(): A | undefined {
    const action = this.value
    this.value = undefined
    return action
  }

  clear(): void {
    this.value = undefined
  }
}
