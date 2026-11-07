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

  <div id="out"></div>
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
    if (url.pathname === '/frame') return html(response, frame)
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
