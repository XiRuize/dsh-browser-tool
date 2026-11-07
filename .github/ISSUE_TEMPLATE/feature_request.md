---
name: Feature request
about: 提出新能力或改进建议
title: "[feat] "
labels: ["enhancement"]
assignees: []
---

## 需求背景

<!-- 你在什么场景下遇到了什么问题？现有工具为什么不够用？ -->

## 期望能力

<!-- 描述目标行为，而不是具体实现。 -->

## 建议的接口（可选）

```json
{
  "tool": "browser_observe",
  "args": {}
}
```

## 涉及范围

- [ ] 工具面（`lib/tools.js`）
- [ ] 观测 / 检查（observe / inspect）
- [ ] 动作 / 提取（act / extract）
- [ ] 网络 / 采集（network / collect）
- [ ] 工作区 / 锁（workspace / locks）
- [ ] 生命周期 / 恢复（host）
- [ ] 文档 / 技能 / CI

## 兼容性

- 是否需要保留旧参数：
- 是否影响默认值（`visibility`、`idleCloseMs`、`allowEval` 等）：
- 是否涉及安全边界（eval、产物路径、登录态、下载/上传）：

## 验收标准

<!-- 怎样算做完了？给出可验证的检查项。 -->

- [ ]
- [ ]

## 备选方案

<!-- 你考虑过但放弃的做法，以及原因。 -->

## 补充

<!-- 参考实现、上游提案、相关 issue。 -->
