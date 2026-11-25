import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * curl 传输引擎（0.9）。
 *
 * 动机：部分门户会按 TLS 指纹/Python 客户端特征直接掐连接（dataroom 实测
 * Monaqasat 对 urllib 返回 TLS EOF，curl 正常）。这里用系统 curl.exe 作为
 * 第二条 HTTP 通道：浏览器 UA、HTTP/2、`--noproxy '*'` 绕系统代理、独立 Cookie jar。
 *
 * 只做「换个客户端取数」，不做验证码识别/绕过。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
export const CURL_META_MARKER = '\n<<<DSH_CURL_META>>>'

let availability = null
let http2Support = null

/** 系统是否带 curl（Windows 10+ 自带 curl.exe）。 */
export function curlAvailable() {
  if (availability !== null) return availability
  try {
    const result = spawnSync('curl', ['--version'], { timeout: 5000, encoding: 'utf8' })
    availability = result.status === 0
  } catch {
    availability = false
  }
  return availability
}

/** 系统 curl 是否编译了 HTTP/2（Windows 自带 curl 常常没有）。 */
export function curlSupportsHttp2() {
  if (http2Support !== null) return http2Support
  try {
    const result = spawnSync('curl', ['--version'], { timeout: 5000, encoding: 'utf8' })
    http2Support = result.status === 0 && /HTTP2/i.test(String(result.stdout || ''))
  } catch {
    http2Support = false
  }
  return http2Support
}

function headerArgs(headers = {}) {
  const args = []
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null || value === '') continue
    args.push('-H', `${key}: ${value}`)
  }
  return args
}

/** 纯函数：生成 curl 参数（便于单测）。 */
export function buildCurlArgs(options = {}) {
  const {
    url,
    method = 'GET',
    headers = {},
    bodyFile = '',
    headerFile = '',
    outputFile = '',
    cookieJar = '',
    userAgent = DEFAULT_UA,
    referer = '',
    timeoutMs = 30000,
    http2 = false,
    followRedirects = true,
    proxy = 'none',
  } = options

  const args = ['-sS', '--compressed', '--max-time', String(Math.max(1, Math.ceil(Number(timeoutMs) / 1000)))]
  if (followRedirects) args.push('-L')
  if (http2) args.push('--http2')
  if (proxy === 'none') args.push('--noproxy', '*')
  else if (proxy) args.push('--proxy', String(proxy))
  if (userAgent) args.push('-A', String(userAgent))
  if (referer) args.push('-e', String(referer))
  args.push(...headerArgs(headers))
  if (cookieJar) args.push('-b', cookieJar, '-c', cookieJar)
  if (outputFile) args.push('-o', outputFile)
  if (headerFile) args.push('-D', headerFile)
  args.push('-w', `${CURL_META_MARKER}%{http_code}|%{content_type}|%{size_download}|%{time_total}|%{url_effective}`)
  const verb = String(method || 'GET').toUpperCase()
  if (verb !== 'GET') args.push('-X', verb)
  if (bodyFile) args.push('--data-binary', `@${bodyFile}`)
  args.push(String(url))
  return args
}

function parseHeaders(raw) {
  const blocks = String(raw || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\n+/)
    .filter(Boolean)
  const last = blocks[blocks.length - 1] || ''
  const headers = {}
  for (const line of last.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  return headers
}

function parseMeta(stdout) {
  const idx = String(stdout || '').lastIndexOf('<<<DSH_CURL_META>>>')
  if (idx < 0) return { meta: null, stderrText: String(stdout || '') }
  const raw = String(stdout).slice(idx + '<<<DSH_CURL_META>>>'.length).trim()
  const [status, contentType, size, time, finalUrl] = raw.split('|')
  return {
    meta: {
      status: Number(status) || 0,
      contentType: contentType || '',
      size: Number(size) || 0,
      time: Number(time) || 0,
      finalUrl: finalUrl || '',
    },
    stderrText: String(stdout).slice(0, idx),
  }
}

async function tempPath(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`)
}

/**
 * 执行一次 HTTP 请求。
 * @returns {Promise<{status:number, headers:object, body:string, contentType:string, bytes:number, elapsedMs:number, finalUrl:string, engine:'curl'}>}
 */
export async function runCurl(options = {}) {
  if (!curlAvailable()) {
    throw new Error(
      '系统未找到 curl：curl 引擎需要本机 curl（Windows 10+ 自带 curl.exe）。' +
        '可改用 engine=playwright，或安装 curl 后重试。',
    )
  }
  const bodyFile = options.body ? await tempPath('dsh-curl-body', '.txt') : ''
  const headerFile = await tempPath('dsh-curl-head', '.txt')
  const outputFile = await tempPath('dsh-curl-out', '.bin')
  try {
    if (bodyFile) await fs.writeFile(bodyFile, String(options.body), 'utf8')
    const jar = options.cookieJar ? String(options.cookieJar).replace(/^~(?=$|[\\/])/, os.homedir()) : ''
    if (jar) {
      try {
        await fs.mkdir(path.dirname(jar), { recursive: true })
        const handle = await fs.open(jar, 'a')
        await handle.close()
      } catch {
        /* jar 目录不可写时交给 curl 报错 */
      }
    }
    const args = buildCurlArgs({
      ...options,
      // Windows 自带 curl 可能没有 HTTP/2；按实际能力决定，避免直接报错。
      http2: options.http2 ?? curlSupportsHttp2(),
      bodyFile,
      headerFile,
      outputFile,
      cookieJar: jar,
    })
    const started = Date.now()
    const result = await new Promise(resolve => {
      const child = spawn('curl', args, { windowsHide: true })
      const out = []
      const err = []
      child.stdout.on('data', chunk => out.push(chunk))
      child.stderr.on('data', chunk => err.push(chunk))
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, Math.max(2000, Number(options.timeoutMs || 30000) + 5000))
      if (typeof timer.unref === 'function') timer.unref()
      child.on('error', error => {
        clearTimeout(timer)
        resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err), spawnError: error })
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
      })
    })

    if (result.spawnError) {
      throw new Error(`curl 启动失败：${result.spawnError.message}。可改用 engine=playwright。`)
    }
    const stdout = result.stdout.toString('utf8')
    const { meta } = parseMeta(stdout)
    const stderr = result.stderr.toString('utf8').trim()
    if (result.code !== 0 || !meta) {
      const reason = stderr || `exit=${result.code}`
      throw new Error(`curl 请求失败：${reason.slice(0, 300)}。可检查网络/代理，或改用 engine=playwright。`)
    }
    let headerRaw = ''
    try {
      headerRaw = await fs.readFile(headerFile, 'utf8')
    } catch {
      headerRaw = ''
    }
    const buf = await fs.readFile(outputFile)
    const body = buf.toString('utf8')
    return {
      engine: 'curl',
      status: meta.status,
      headers: parseHeaders(headerRaw),
      body,
      contentType: meta.contentType || '',
      bytes: buf.length,
      elapsedMs: Date.now() - started,
      finalUrl: meta.finalUrl || options.url || '',
    }
  } finally {
    for (const file of [bodyFile, headerFile, outputFile]) {
      if (!file) continue
      try {
        await fs.rm(file, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
