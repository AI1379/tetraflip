/** 撤销历史栈：依赖「状态是不可变快照」这一约定 */
export class History<S> {
  private stack: S[]

  constructor(initial: S) {
    this.stack = [initial]
  }

  get current(): S {
    return this.stack[this.stack.length - 1]
  }

  /** 已进行的步数（= 压栈次数） */
  get depth(): number {
    return this.stack.length - 1
  }

  get canUndo(): boolean {
    return this.stack.length > 1
  }

  push(state: S): void {
    this.stack.push(state)
  }

  /** 撤销一步并返回回退后的状态；不可撤销时返回 null */
  undo(): S | null {
    if (!this.canUndo) return null
    this.stack.pop()
    return this.current
  }

  reset(initial: S): void {
    this.stack = [initial]
  }
}
