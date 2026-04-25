# Runtime SDK Minimal Demo

[English](../../guides/runtime-sdk-minimal-demo.md)

这份文档给出当前 Public SDK 的最小宿主接入示例。

## 示例源码

- [runtime-sdk-stage-1-minimal.ts](../../../examples/runtime-sdk-stage-1-minimal.ts)

建议配合阅读：
- [Runtime SDK 分阶段接入](runtime-sdk-by-scenario.md)
- [Runtime SDK API 覆盖矩阵](runtime-sdk-api-coverage.md)

这一阶段默认使用 `runtime.sessions.registry.start({ agentId: "simulator-agent-acp-local" })`，同时也展示显式 `runtime.sessions.start({ agent })` 的 override 路径。

## 覆盖内容

- 创建 runtime session
- 提供最小宿主 authority handlers
- 执行一个简单 turn
- 获取 session snapshot
- 关闭 session

## 适用场景

适合用在：
- 想先看最小接入形态
- 想快速理解顶层 SDK 长什么样
- 准备再进入全场景 demo 之前

## 下一步

如果要看更完整的 session state、stream、operation、permission、resume 和 typed error handling，见：
- [Runtime SDK 分阶段接入](runtime-sdk-by-scenario.md)
- [Runtime SDK Demo](runtime-sdk-demo.md)
