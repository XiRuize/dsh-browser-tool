import { ACTIONS, performAction } from './act.js'
import { boundExtractResult, extractPage } from './extract.js'
import { showHud } from './hud.js'
import { toInt } from './util.js'

/**
 * 一次调用执行多步动作（借鉴 nuwa-browser 的 harness 脚本思路）。
 *
 * 目的：把「点一下 → 看一眼结果 → 再填表 → 再点」的模型往返压缩成一次工具调用。
 * 与直接开放任意 JS 相比，这里只接受**声明式步骤**（act.js 的动作集 + extract），
 * 每一步仍走原有的定位/等待/核验实现，安全边界不变。
 */

export const BATCH_MAX_STEPS = 50
export const BATCH_DEFAULT_TIMEOUT_MS = 120000
export const BATCH_MAX_TIMEOUT_MS = 175000

/** batch 支持的动作 = act 的全部动作 + extract（读取）+ goto（导航）。 */
export const BATCH_ACTIONS = [...ACTIONS, 'extract', 'goto']

const BATCH_ACTION_SET = new Set(BATCH_ACTIONS)

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function stepIndexLabel(index, total) {
  return `第 ${index}/${total} 步`
}

/**
 * 校验并规范化步骤数组。抛出的错误都带中文说明，便于模型直接改参数重试。
 * @param {unknown} value
 * @param {{maxSteps?:number}} [options]
 * @returns {object[]}
 */
export function normalizeSteps(value, { maxSteps = BATCH_MAX_STEPS } = {}) {
  if (!Array.isArray(value)) {
    throw new Error('steps 必须是数组，例如 [{ "action": "click", "ref": "e3" }, { "action": "type", "selector": "#q", "value": "x" }]。')
  }
  if (value.length === 0) throw new Error('steps 不能为空。')
  if (value.length > maxSteps) throw new Error(`steps 最多 ${maxSteps} 步，收到 ${value.length} 步。`)

  return value.map((raw, index) => {
    const where = `第 ${index + 1} 步`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${where}必须是对象。`)
    }
    const rawAction = String(raw.action || '').trim()
    const action = rawAction.toLowerCase() === 'waitfor' ? 'waitFor' : rawAction
    if (!action) throw new Error(`${where}缺少 action。可用：${BATCH_ACTIONS.join('、')}。`)
    if (!BATCH_ACTION_SET.has(action)) {
      throw new Error(`${where}的 action=${action} 不受支持。可用：${BATCH_ACTIONS.join('、')}。`)
    }

    const step = { ...raw, action }
    if (raw.label !== undefined) {
      const label = String(raw.label).trim().slice(0, 80)
      if (label) step.label = label
      else delete step.label
    }
    if (step.timeoutMs !== undefined) step.timeoutMs = toInt(step.timeoutMs, 0, 1000, 180000) || undefined
    if (step.timeoutMs === undefined) delete step.timeoutMs
    if (action === 'extract') {
      // extract 不是动作，去掉动作专属字段，避免误传给提取层。
      for (const key of ['verify', 'state', 'urlPattern', 'responseUrl', 'submit', 'exact', 'dialog', 'drag', 'files']) {
        delete step[key]
      }
    }
    if (action === 'goto') {
      if (!String(step.url || '').trim()) throw new Error(`${where}的 action=goto 需要 url。`)
      step.url = String(step.url).trim()
    }
    return step
  })
}

function summarizeExtract(result, savedPath) {
  return {
    mode: result.mode,
    url: result.url,
    title: result.title,
    ...(result.content !== undefined ? { text: result.content } : {}),
    ...(result.dataText !== undefined ? { dataText: result.dataText } : {}),
    ...(result.data !== undefined && result.data !== null ? { data: result.data } : {}),
    truncated: Boolean(result.truncated),
    nextCursor: result.nextCursor ?? null,
    savedPath: savedPath || null,
  }
}

export async function runExtractStep(manager, page, step, config) {
  const spec = {
    mode: step.mode,
    selector: step.selector || step.container,
    itemSelector: step.itemSelector,
    labels: step.labels,
    fields: step.fields,
  }
  if (step.offset !== undefined) spec.offset = step.offset
  if (step.limit !== undefined) spec.limit = step.limit

  const maxChars = toInt(step.maxChars, config.extractMaxChars || 30000, 1000, 200000)
  const result = await extractPage(page, spec)
  const bounded = boundExtractResult(result, maxChars)
  let savedPath = null
  if (result.truncated || bounded.truncated) {
    const full = result.content ?? JSON.stringify(result.data ?? {}, null, 2)
    savedPath = await manager.saveText(full, {
      prefix: 'extract',
      ext: result.content !== null && result.content !== undefined ? '.txt' : '.json',
    })
  }
  return summarizeExtract(bounded, savedPath)
}

/**
 * 顺序执行步骤；默认失败即停，并把已完成的步骤一并带回。
 *
 * @param {object} manager BrowserManager
 * @param {{page:object, tabId?:string}} state 标签页状态
 * @param {object[]} steps normalizeSteps() 的结果
 * @param {{config?:object, exec?:object, stopOnError?:boolean, timeoutMs?:number}} [options]
 * @returns {Promise<{ok:true, steps:object[], extract:object|null, ms:number}>}
 */
export async function runBatch(manager, state, steps, options = {}) {
  const config = options.config || {}
  const exec = options.exec || null
  const stopOnError = options.stopOnError !== false
  const timeoutMs = Math.min(
    BATCH_MAX_TIMEOUT_MS,
    Math.max(1000, Number(options.timeoutMs) || BATCH_DEFAULT_TIMEOUT_MS),
  )
  const started = Date.now()
  const deadline = started + timeoutMs
  const total = steps.length
  const results = []
  let extract = null

  const partial = (failedAt, message) => {
    const error = new Error(message)
    error.batch = { steps: results, extract, failedAt, ms: Date.now() - started }
    return error
  }

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    const where = stepIndexLabel(i + 1, total)
    if (exec?.signal?.aborted) throw partial(i + 1, `${where}之前操作已取消。`)
    if (Date.now() > deadline) throw partial(i + 1, `${where}之前已达到批量超时（${timeoutMs}ms），已完成 ${results.length} 步。`)

    const page = state?.page
    if (!page || page.isClosed?.()) throw partial(i + 1, `${where}之前标签页已关闭。`)

    const label = step.label || step.action
    const stepStarted = Date.now()
    await showHud(page, { label: `${i + 1}/${total} ${label}`, step: i + 1, total, tone: 'running' }, config)

    try {
      if (step.action === 'goto') {
        const response = await page.goto(step.url, {
          waitUntil: step.waitUntil || 'domcontentloaded',
          timeout: Math.min(180000, Math.max(1000, Number(step.timeoutMs) || 45000)),
        })
        results.push({
          index: i + 1,
          action: 'goto',
          label: step.label || '',
          ok: true,
          ms: Date.now() - stepStarted,
          message: `已打开 ${page.url()}${response ? `（HTTP ${response.status()}）` : ''}`,
        })
      } else if (step.action === 'extract') {
        const extracted = await runExtractStep(manager, page, step, config)
        extract = extracted
        results.push({
          index: i + 1,
          action: 'extract',
          label: step.label || '',
          ok: true,
          ms: Date.now() - stepStarted,
          extract: extracted,
        })
      } else {
        const actionResult = await performAction(
          manager,
          state,
          { ...step, verify: step.verify === true },
          config,
          exec,
        )
        results.push({
          index: i + 1,
          action: step.action,
          label: step.label || '',
          ok: true,
          ms: Date.now() - stepStarted,
          message: actionResult.message || '',
          verify: step.verify === true ? actionResult.verify ?? null : null,
        })
      }
    } catch (error) {
      const message = errorMessage(error)
      results.push({
        index: i + 1,
        action: step.action,
        label: step.label || '',
        ok: false,
        ms: Date.now() - stepStarted,
        error: message,
      })
      await showHud(page, { label: `${i + 1}/${total} ${label} 失败`, step: i + 1, total, tone: 'error' }, config)
      const failure = partial(i + 1, `${where}（${step.action}）失败：${message}`)
      if (stopOnError) throw failure
      continue
    }
  }

  await showHud(state?.page, { label: `已完成 ${total} 步`, step: total, total, tone: 'ok' }, config)
  return { ok: true, steps: results, extract, ms: Date.now() - started }
}

