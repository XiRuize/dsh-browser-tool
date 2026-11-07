## 变更说明

<!-- 这个 PR 做了什么，为什么需要它。 -->

## 类型

- [ ] 功能（feat）
- [ ] 修复（fix）
- [ ] 文档（docs）
- [ ] 重构（refactor）
- [ ] 测试 / CI（test / ci）
- [ ] 破坏性变更（breaking）

## 关联 issue

Closes #

## 验证

- [ ] `node --check` 覆盖所有改动的 `.js` / `.mjs`
- [ ] `node test/unit.mjs` 通过（如存在）
- [ ] 需要浏览器的测试已说明是否运行、在什么环境运行
- [ ] 手动验证步骤与结果如下

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --check .\index.js
```

## 文档

- [ ] 更新 `docs/tools.md`（参数 / 返回 / 错误）
- [ ] 更新 `CHANGELOG.md` 的「未发布」段
- [ ] 涉及安全边界时更新 `SECURITY.md`
- [ ] 涉及安装 / 配置时更新 `docs/installation.md`

## 安全与兼容

- [ ] 不引入 stealth / 验证码绕过 / 自动提交
- [ ] 默认值仍为 `visibility=headless`、`idleCloseMs=0`、`allowEval=false`、`allowAbsoluteArtifacts=false`、`maxTabs=24`
- [ ] 保留旧工具名与 `@eN` 语义
- [ ] 没有提交真实站点数据、profile、产物、`node_modules`

## 备注

<!-- 截图、日志、迁移说明、剩余风险。 -->
