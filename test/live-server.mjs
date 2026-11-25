import crypto from 'node:crypto'
import http from 'node:http'

/**
 * 本地测试服务（e2e.mjs 与 deep.mjs 共用）。
 *
 * 页面刻意包含：
 * - 重复文字的按钮（#containerA / #containerB 下各一个“确认”）；
 * - 两个带相同选项文字的 select（.pick），用于验证 container 限定；
 * - 表格、labeled 字段、iframe、长列表、target=_blank 弹窗、JSON 接口。
 *
 * 所有页面只用于本机回环测试，不访问外网。
 */

const longItems = Array.from({ length: 200 }, (_, index) => `<li>列表项 ${index + 1}</li>`).join('')

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>测试公司详情</title>
<style>body{font-family:sans-serif} #out{min-height:1.2em}</style></head>
<body>
  <h1>测试科技有限公司</h1>
  <p class="credit">统一社会信用代码：91310000TEST</p>
  <p id="legal">法定代表人：张三</p>
  <form id="company-form" name="company" action="/submit" method="get" onsubmit="return false">
    <label for="q">公司名称</label>
    <input id="q" name="q" placeholder="输入公司名称">
    <select id="sel" name="sel">
      <option value="a">选项A</option>
      <option value="b">选项B</option>
      <option value="c">选项C</option>
    </select>
    <input type="checkbox" id="agree" name="agree"><label for="agree">同意条款</label>
    <button id="go" type="button"
      onclick="document.getElementById('out').textContent='查询:'+document.getElementById('q').value">查询</button>
  </form>

  <table id="t"><caption>基本信息</caption>
    <thead><tr><th>项目</th><th>值</th></tr></thead>
    <tbody>
      <tr><td>统一社会信用代码</td><td>91310000TEST</td></tr>
      <tr><td>法定代表人</td><td>张三</td></tr>
      <tr><td>注册资本</td><td>1000万元</td></tr>
    </tbody>
  </table>

  <a href="/detail">详情链接</a>
  <a href="/detail?popup=1" target="_blank" rel="noopener">弹出详情</a>
  <button id="load" type="button"
    onclick="fetch('/api/company').then(r=>r.text()).then(t=>document.getElementById('out').textContent=t)">加载接口</button>

  <div id="containerA"><button id="confirmA" type="button"
    onclick="document.getElementById('out').textContent='A'">确认</button></div>
  <div id="containerB"><button id="confirmB" type="button"
    onclick="document.getElementById('out').textContent='B'">确认</button></div>

  <div id="wrapA">
    <label for="pickA">选项容器 A</label>
    <select class="pick" id="pickA"><option value="a1">选项A</option><option value="a2">选项A2</option></select>
  </div>
  <div id="wrapB">
    <label for="pickB">选项容器 B</label>
    <select class="pick" id="pickB"><option value="b1">选项A</option><option value="b2">选项B2</option></select>
  </div>

  <p id="dupText">贵州茅台</p>
  <div id="combo">
    <input id="comboInput" type="text" role="combobox" aria-expanded="true" autocomplete="off">
    <ul id="comboList" role="listbox" style="margin:0;padding:0;list-style:none">
      <li role="option" id="comboOption" tabindex="-1"
        onclick="document.getElementById('out').textContent='option-hit'">贵州茅台</li>
    </ul>
  </div>
  <div id="rich" contenteditable="true" role="textbox" aria-label="富文本">残留文本</div>

  <div id="out"></div>
  <iframe src="/tiny-verify" width="1" height="1" title="隐形验证"></iframe>
  <iframe src="/frame" title="测试 frame"></iframe>
  <ul id="long-list">${longItems}</ul>
  <script>fetch('/api/bootstrap')</script>
</body></html>`

const detail = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>详情页</title></head><body>
<h1>详情页</h1><p>这是详情内容</p>
<table><tr><th>字段</th><th>值</th></tr><tr><td>状态</td><td>存续</td></tr></table>
</body></html>`

const frame = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Frame</title></head><body>
<button id="iframeBtn" onclick="document.body.insertAdjacentHTML('beforeend','<p>iframe 已点击</p>')">iframe按钮</button>
</body></html>`

const list = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>列表页</title></head><body>
<h1>列表页</h1><ul id="items">
${Array.from(
  { length: 5 },
  (_, index) =>
    `<li class="item"><h3 class="item-title">条目 ${index + 1}</h3><span class="item-author">作者${index + 1}</span><a class="item-link" href="/detail?n=${index + 1}">查看</a></li>`,
).join('')}
</ul></body></html>`

function pagedPage(pageNo) {
  const items = Array.from({ length: 3 }, (_, index) => {
    const n = (pageNo - 1) * 3 + index + 1
    return `<li class="page-item"><h3 class="page-title">第${pageNo}页条目${n}</h3><a class="page-link" href="/detail?n=${n}">查看</a></li>`
  }).join('')
  const prev = pageNo > 1 ? `<a class="prev" href="/paged?page=${pageNo - 1}">上一页</a>` : ''
  const next =
    pageNo < 3
      ? `<a class="next" href="/paged?page=${pageNo + 1}">下一页</a>`
      : '<span class="next disabled" aria-disabled="true">下一页</span>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>分页列表 第${pageNo}页</title></head>
<body><h1>分页列表</h1><ul id="page-items">${items}</ul><nav class="pagination">${prev}${next}</nav></body></html>`
}


const SIGN_PAGE = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>签名表单</title></head>',
  '<body><form action="/api/signed" method="post">',
  '<input type="text" name="a" value="1">',
  '<input type="text" name="b" value="2">',
  '<input type="hidden" name="encparam" value="">',
  '<input type="hidden" name="hashval" value="">',
  '<input type="checkbox" name="c" value="on" checked>',
  '<input type="checkbox" name="d" value="off">',
  '<select name="s"><option value="Z2">Z2</option><option value="Z1" selected>Z1</option></select>',
  '<button type="submit">提交</button>',
  '</form></body></html>',
].join('')

// 与 lib/form-sign.js 相互独立的期望值：a=1,b=2,c=on,s=Z1 → "12onZ1"；encparam 含 d（未勾选也占名）
const SIGN_EXPECT = { values: "12onZ1", encparam: "a,b,c,d,s" }

function readBody(request) {
  return new Promise(resolve => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function verifySigned(request, response) {
  const raw = await readBody(request)
  const params = new URLSearchParams(raw)
  const hashval = params.getAll('hashval').pop() || ''
  const encparam = params.getAll('encparam').pop() || ''
  const expected = crypto.createHash('sha256').update(SIGN_EXPECT.values).digest('hex')
  const ok = hashval === expected && encparam === SIGN_EXPECT.encparam
  json(response, {
    ok,
    encparam,
    hashval,
    expectedHash: expected,
    a: params.get('a'),
    s: params.get('s'),
    hasD: params.has('d'),
  })
}
function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function html(response, value) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(value)
}

/**
 * 启动随机端口的本地测试服务。
 * @returns {Promise<{server: import('node:http').Server, base: string, port: number, close: () => Promise<void>}>}
 */
export async function startLocalServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/api/company') {
      json(response, { name: '测试科技有限公司', creditCode: '91310000TEST' })
      return
    }
    if (url.pathname === '/api/bootstrap') {
      json(response, { ok: true })
      return
    }
    if (url.pathname === '/detail') return html(response, detail)
    if (url.pathname === '/list') return html(response, list)
    if (url.pathname === '/paged') {
      const pageNo = Math.min(3, Math.max(1, Number(url.searchParams.get('page')) || 1))
      return html(response, pagedPage(pageNo))
    }
    if (url.pathname === '/sign-page') return html(response, SIGN_PAGE)
    if (url.pathname === '/api/signed') {
      verifySigned(request, response).catch(error => json(response, { ok: false, error: String(error?.message || error) }))
      return
    }
    if (url.pathname === '/api/block') {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><head><title>Security Page</title></head><body>NCGR access denied</body></html>')
      return
    }
    if (url.pathname === '/frame') return html(response, frame)
    // 隐形第三方验证 iframe：只用来验证「不因隐藏 iframe 里的验证码字样误报」。
    if (url.pathname === '/tiny-verify') {
      return html(
        response,
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>verify</title></head><body style="margin:0"><div style="width:1px;height:1px;overflow:hidden">人机验证 captcha</div></body></html>',
      )
    }
    // 真正的验证拦截页：主 frame 可见文本就该报警。
    if (url.pathname === '/verify') {
      return html(
        response,
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>安全验证</title></head><body><h1>请完成安全验证</h1><p>请拖动滑块完成验证</p></body></html>',
      )
    }
    // 带第三方验证组件的页面：用来验证 humanCheck 识别与 waitForHuman 交接。
    if (url.pathname === '/captcha') {
      return html(
        response,
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>安全验证</title></head><body>' +
          '<h1>请完成安全验证</h1>' +
          '<iframe src="/recaptcha/api2/anchor?k=test" width="304" height="78" title="recaptcha"></iframe>' +
          '</body></html>',
      )
    }
    if (url.pathname === '/recaptcha/api2/anchor') {
      return html(
        response,
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>reCAPTCHA</title></head><body>protected by reCAPTCHA</body></html>',
      )
    }
    return html(response, page)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  return {
    server,
    base,
    port,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}
