import http from 'node:http'

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Live browser tool test</title></head>
<body><h1>测试企业</h1>
<p>统一社会信用代码：91310000LIVE</p>
<p>法定代表人：李四</p>
<p>注册资本：1000万元</p>
<a href="https://example.com">示例链接</a>
</body></html>`

http
  .createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
  })
  .listen(8791, '127.0.0.1', () => console.log('LIVE_TEST_SERVER http://127.0.0.1:8791'))
