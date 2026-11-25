import crypto from 'node:crypto'

/**
 * mentis 系门户（巴林 TenderBoard / 阿曼 Esnaad 同族）表单哈希复现。
 *
 * 来源：`FormValidate.js` 的 `createFormHash`，以及 dataroom 里已实机跑通的
 * `tb_fetch.py`。机制：
 *   - 按 DOM 顺序把「非空表单值」串接；
 *   - `encparam` = 参与字段名（逗号连接，同样按 DOM 顺序）；
 *   - `hashval` = sha256(串接值)；
 *   - POST 时把 encparam/hashval 一并提交，且未勾选的 checkbox/radio 不提交。
 */

export const MENTIS_EXCLUDED_NAMES = Object.freeze([
  'controlList',
  'controlValues',
  'encparam',
  'hashval',
  'signTime',
  'encList',
  'enc',
  'fieldsname',
  'randomnoForPopup',
  'masterCtrl',
  'bc1',
  'bc2',
  'bc3',
  'bc4',
  'bc5',
  'bc6',
  'bc7',
  'strTndAltTitle',
  'strTndAltDesc',
  'txtAltCompanyName',
  'tempVendorUndertaking',
  'strAltVendorUndertaking',
  'strSaveAmendSubjAlt',
  'strTndAltRemk',
  'FormEncrypted',
  'sign1',
])

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g
const TAG_RE = /<(input|select|option|textarea)\b([^>]*)>/gi

function parseAttrs(raw = '') {
  const attrs = {}
  let match
  ATTR_RE.lastIndex = 0
  while ((match = ATTR_RE.exec(raw))) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? ''
  }
  const bool = name => new RegExp(`(^|\\s)${name}(\\s|=|$|/)`, 'i').test(raw)
  return {
    attrs,
    disabled: bool('disabled'),
    checked: bool('checked'),
    selected: bool('selected'),
    multiple: bool('multiple'),
    readonly: bool('readonly'),
  }
}

/** 按 DOM 顺序解析 input / select / option（够用即可，不追求完整 HTML 解析器）。 */
export function parseFormFields(html) {
  const fields = []
  let currentSelect = null
  let match
  TAG_RE.lastIndex = 0
  while ((match = TAG_RE.exec(String(html || '')))) {
    const tag = match[1].toLowerCase()
    const info = parseAttrs(match[2])
    if (tag === 'input') {
      currentSelect = null
      fields.push({
        kind: 'input',
        name: info.attrs.name || '',
        value: info.attrs.value ?? '',
        type: (info.attrs.type || 'text').toLowerCase(),
        disabled: info.disabled,
        checked: info.checked,
        id: info.attrs.id || '',
      })
    } else if (tag === 'select') {
      currentSelect = {
        kind: 'select',
        name: info.attrs.name || '',
        disabled: info.disabled,
        multiple: info.multiple,
        options: [],
      }
      fields.push(currentSelect)
    } else if (tag === 'option' && currentSelect) {
      currentSelect.options.push({
        value: info.attrs.value ?? '',
        selected: info.selected,
      })
    }
  }
  return fields
}

function queryValue(url, name) {
  const q = String(url || '').includes('?') ? String(url).split('?')[1] : ''
  for (const pair of q.split('&')) {
    const [key, ...rest] = pair.split('=')
    if (key === name) return rest.join('=') ?? ''
  }
  return null
}

function currentSelectValue(field) {
  const options = field.options || []
  if (options.length === 0) return ''
  const selected = options.find(option => option.selected)
  return (selected || options[0]).value ?? ''
}

function normalizeValue(value) {
  return String(value ?? '').replace(/(\r\n|\n|\r)/g, ' ').trim()
}

/**
 * 复现 createFormHash。
 * @param {object[]} fields parseFormFields() 的结果
 * @param {{actionUrl?:string, excluded?:Iterable<string>}} [options]
 * @returns {{encparam:string, hashval:string, values:string, names:string[]}}
 */
export function buildFormHash(fields, options = {}) {
  const actionUrl = String(options.actionUrl || '')
  const excluded = new Set(options.excluded || MENTIS_EXCLUDED_NAMES)
  const counts = new Map()
  for (const field of fields) {
    if (field.kind !== 'input' || !field.name) continue
    counts.set(field.name, (counts.get(field.name) || 0) + 1)
  }

  let values = ''
  const names = []
  const seen = new Set()

  const pushQuery = name => {
    if (!actionUrl.includes('?')) return
    const qv = queryValue(actionUrl, name)
    if (qv) values += normalizeValue(qv)
  }

  for (const field of fields) {
    if (field.kind !== 'input') continue
    const name = field.name
    const type = field.type
    if (type === 'file' || type === 'button' || type === 'submit' || field.disabled) continue
    if (!name || excluded.has(name)) continue
    if ((field.id || '').startsWith('nitSign_') || (field.id || '').startsWith('openDataH_')) continue
    const value = field.value
    if (!value) continue
    if (type === 'checkbox' || type === 'radio') {
      if (normalizeValue(value) && field.checked) values += value
      if (normalizeValue(value) && !seen.has(name)) {
        names.push(name)
        seen.add(name)
      }
      continue
    }
    if (normalizeValue(value)) {
      if ((counts.get(name) || 0) > 1) {
        if (!seen.has(name)) {
          for (const other of fields) {
            if (other.kind === 'input' && other.name === name && !other.disabled) {
              const otherValue = other.value
              if (otherValue && normalizeValue(otherValue)) values += otherValue
            }
          }
          pushQuery(name)
        }
      } else {
        values += value
        pushQuery(name)
      }
    }
    if (!seen.has(name)) {
      names.push(name)
      seen.add(name)
    }
  }

  for (const field of fields) {
    if (field.kind !== 'select' || field.disabled || !field.name) continue
    const name = field.name
    if (!seen.has(name)) {
      names.push(name)
      seen.add(name)
    }
    const current = currentSelectValue(field)
    if (!['Font', 'Size'].includes(current)) values += current
  }

  const encparam = names.join(',')
  const normalized = normalizeValue(values)
  const hashval = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
  return { encparam, hashval, values: normalized, names }
}

/** 复现 FormData(frm)：DOM 顺序、含空值、排除未勾选与按钮、末尾补 encparam/hashval。 */
export function buildFormBody(fields, encparam, hashval) {
  const parts = []
  for (const field of fields) {
    if (field.kind === 'input') {
      const type = field.type
      if (type === 'file' || type === 'button' || type === 'submit' || field.disabled || !field.name) continue
      if ((type === 'checkbox' || type === 'radio') && !field.checked) continue
      if (field.name === 'encparam') {
        parts.push(['encparam', encparam])
        continue
      }
      if (field.name === 'hashval') {
        parts.push(['hashval', hashval])
        continue
      }
      parts.push([field.name, field.value ?? ''])
    } else if (field.kind === 'select' && field.name && !field.disabled) {
      parts.push([field.name, currentSelectValue(field)])
    }
  }
  parts.push(['encparam', encparam])
  parts.push(['hashval', hashval])
  return parts
}

/**
 * 用 overrides 覆盖表单字段（签名前）。
 * - 字符串：input 设 value；select 按 option value 选中；
 * - 布尔：勾选/取消 checkbox/radio；
 * - null/undefined：跳过。
 */
export function applyOverrides(fields, overrides = {}) {
  if (!overrides || typeof overrides !== 'object') return fields
  for (const [name, value] of Object.entries(overrides)) {
    for (const field of fields) {
      if (field.name !== name) continue
      if (field.kind === 'select') {
        if (typeof value === 'boolean') continue
        for (const option of field.options) option.selected = option.value === String(value)
      } else if (field.kind === 'input') {
        if (typeof value === 'boolean') {
          if (field.type === 'checkbox' || field.type === 'radio') field.checked = value
        } else if (value !== null && value !== undefined) {
          field.value = String(value)
        }
      }
    }
  }
  return fields
}

/** 从 HTML 里取第一个 form 的 action（用于 sign.page 未给 action 时兜底）。 */
export function findFormAction(html, baseUrl = '') {
  const match = /<form\b([^>]*)>/i.exec(String(html || ''))
  if (!match) return ''
  const action = parseAttrs(match[1]).attrs.action || ''
  if (!action) return baseUrl
  try {
    return new URL(action, baseUrl).href
  } catch {
    return action
  }
}
