/**
 * per-tab 读写锁。
 *
 * 设计目标：
 * - 同一个标签页上的写操作互斥，读写也互斥；只读操作之间可以并行。
 * - 不同标签页互不阻塞。
 * - 等待队列严格 FIFO，避免写请求被源源不断的读请求饿死。
 * - 等待超时抛出中文错误，不把浏览器底层异常泄漏给调用方。
 *
 * 锁只保护本进程内的操作顺序，不涉及浏览器进程或网络层。
 */

const LOCK_MODES = Object.freeze(['read', 'write'])

const MODE_LABEL = {
  read: '读',
  write: '写',
}

function normalizeMode(mode) {
  const value = String(mode ?? '').trim().toLowerCase()
  if (!LOCK_MODES.includes(value)) {
    throw new Error(`锁模式无效：${mode ?? '(空)'}。只允许 read 或 write。`)
  }
  return value
}

function normalizeTabId(tabId) {
  if (tabId && typeof tabId === 'object') {
    const value = tabId.tabId ?? tabId.tab
    return String(value ?? '').trim()
  }
  return String(tabId ?? '').trim()
}

/**
 * 标签页锁管理器。
 *
 * `withTabLock(tabId, mode, fn, { timeoutMs })` 在获得锁后执行 `fn`，
 * 无论 `fn` 成功还是失败都会释放锁。超时只发生在等待阶段；已经获得锁的
 * 操作不会被强制中断，调用方仍需自己给浏览器操作设置超时。
 */
export class TabLockManager {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs] 默认等待超时；调用方可用 actionTimeoutMs*2 传入
   */
  constructor({ timeoutMs = 30000 } = {}) {
    const configured = Number(timeoutMs)
    this.defaultTimeoutMs = Number.isFinite(configured) && configured > 0
      ? Math.max(1000, Math.round(configured))
      : 30000
    /** @type {Map<string, object>} */
    this.tabs = new Map()
  }

  /**
   * 在指定标签页上持锁执行 fn。
   *
   * @template T
   * @param {string|{tabId?: string, tab?: string}} tabId
   * @param {'read'|'write'} mode
   * @param {() => T|Promise<T>} fn
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<T>}
   */
  withTabLock(tabId, mode, fn, { timeoutMs } = {}) {
    let id
    let lockMode
    try {
      id = normalizeTabId(tabId)
      lockMode = normalizeMode(mode)
      if (!id) throw new Error('withTabLock 需要标签页 ID（例如 t1）。')
      if (typeof fn !== 'function') throw new Error('withTabLock 需要一个可执行的函数。')
    } catch (error) {
      return Promise.reject(error)
    }

    const state = this.#stateFor(id)
    const timeout = this.#resolveTimeout(timeoutMs)

    return new Promise((resolve, reject) => {
      const waiter = {
        mode: lockMode,
        fn,
        resolve,
        reject,
        timer: null,
        enqueuedAt: Date.now(),
        id: Symbol(lockMode),
      }
      waiter.timer = setTimeout(() => {
        this.#onTimeout(id, state, waiter)
      }, timeout)
      waiter.timer.unref?.()
      state.queue.push(waiter)
      this.#drain(id, state)
    })
  }

  /**
   * 主动取消某个标签页上所有等待中的请求并做清理。
   * 已经持有锁的操作不受影响；它在完成后仍会走正常的释放流程。
   */
  releaseTab(tabId) {
    const id = normalizeTabId(tabId)
    const state = this.tabs.get(id)
    if (!state) return
    state.closed = true
    for (const waiter of state.queue.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(new Error(`标签页 ${id} 已关闭，等待中的${MODE_LABEL[waiter.mode]}锁请求已取消。`))
    }
    this.#cleanup(id, state)
  }

  /** 释放所有等待中的请求并清空锁表；批量清理/释放管理器时使用。 */
  clear() {
    for (const [tabId, state] of this.tabs) {
      for (const waiter of state.queue.splice(0)) {
        if (waiter.timer) clearTimeout(waiter.timer)
        waiter.reject(new Error(`标签页 ${tabId} 的锁管理器已释放，等待中的${MODE_LABEL[waiter.mode]}锁请求已取消。`))
      }
    }
    this.tabs.clear()
  }

  /** 该标签页上是否有活动锁或排队请求。回收标签页前应据此避让。 */
  isLocked(tabId) {
    const id = normalizeTabId(tabId)
    const state = this.tabs.get(id)
    if (!state) return false
    return Boolean(state.writer) || state.readers.size > 0 || state.queue.length > 0
  }

  /** 是否持有写锁。 */
  isWriteLocked(tabId) {
    const id = normalizeTabId(tabId)
    const state = this.tabs.get(id)
    return Boolean(state?.writer)
  }

  /** 供 browser_status 使用的锁摘要。 */
  status() {
    const locks = []
    for (const [tabId, state] of this.tabs) {
      const mode = state.writer ? 'write' : state.readers.size > 0 ? 'read' : null
      if (!mode && state.queue.length === 0) continue
      let holder = null
      if (state.writer) {
        holder = { mode: 'write', since: state.writerSince }
      } else if (state.readers.size > 0) {
        holder = { mode: 'read', readers: state.readers.size, since: state.readerSince }
      }
      locks.push({
        tabId,
        mode,
        queued: state.queue.length,
        holder,
      })
    }
    return locks
  }

  #stateFor(id) {
    let state = this.tabs.get(id)
    if (!state) {
      state = {
        readers: new Set(),
        writer: null,
        writerSince: null,
        readerSince: null,
        queue: [],
        closed: false,
      }
      this.tabs.set(id, state)
    }
    return state
  }

  #resolveTimeout(timeoutMs) {
    const value = Number(timeoutMs)
    if (Number.isFinite(value) && value > 0) return Math.max(1000, Math.round(value))
    return this.defaultTimeoutMs
  }

  #onTimeout(tabId, state, waiter) {
    const index = state.queue.indexOf(waiter)
    if (index === -1) return
    state.queue.splice(index, 1)
    const timeout = waiter.timer
    if (timeout) clearTimeout(timeout)
    const modeLabel = MODE_LABEL[waiter.mode]
    const waited = Math.max(0, Date.now() - waiter.enqueuedAt)
    waiter.reject(
      new Error(
        `标签页 ${tabId} 的${modeLabel}锁等待超时（已等待 ${waited}ms）。` +
          '可能有其他操作正在占用该标签页；请稍后重试，或调用 browser_status 查看 locks。',
      ),
    )
    this.#drain(tabId, state)
    this.#cleanup(tabId, state)
  }

  #drain(tabId, state) {
    if (state.closed) return
    if (state.writer) return
    while (state.queue.length > 0) {
      const next = state.queue[0]
      if (next.mode === 'write') {
        // 写操作必须等所有读者退出；队列 FIFO 保证它不会被后到的读者插队。
        if (state.readers.size > 0) return
        state.queue.shift()
        this.#grant(tabId, state, next)
        return
      }
      // 队首是读操作时，可以连续授予多个读操作；一旦遇到写操作就停下。
      state.queue.shift()
      this.#grant(tabId, state, next)
    }
  }

  #grant(tabId, state, waiter) {
    if (waiter.timer) {
      clearTimeout(waiter.timer)
      waiter.timer = null
    }
    const token = waiter.id
    if (waiter.mode === 'write') {
      state.writer = token
      state.writerSince = Date.now()
    } else {
      state.readers.add(token)
      if (state.readerSince === null) state.readerSince = Date.now()
    }

    let released = false
    const release = () => {
      if (released) return
      released = true
      if (waiter.mode === 'write') {
        if (state.writer === token) {
          state.writer = null
          state.writerSince = null
        }
      } else {
        state.readers.delete(token)
        if (state.readers.size === 0) state.readerSince = null
      }
      this.#drain(tabId, state)
      this.#cleanup(tabId, state)
    }

    Promise.resolve()
      .then(() => waiter.fn())
      .then(
        value => {
          release()
          waiter.resolve(value)
        },
        error => {
          release()
          waiter.reject(error)
        },
      )
  }

  #cleanup(tabId, state) {
    if (state.writer || state.readers.size > 0 || state.queue.length > 0) return
    if (this.tabs.get(tabId) === state) this.tabs.delete(tabId)
  }
}

export { LOCK_MODES }
