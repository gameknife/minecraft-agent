# MC_AGENT - Claude Code 项目指南

## 项目概述

Minecraft 基岩版 x LLM 智能建造助手。玩家在聊天中输入 `!ai <描述>`，通过 Gemini API 生成建造蓝图，行为包逐方块放置。

架构：Node.js WebSocket Server ← `/wsserver` → Minecraft 客户端 → 行为包 Script API

## 目录结构

```
MC_AGENT/
├── server/                # Node.js 服务端 (TypeScript, tsx 直接运行)
│   ├── src/
│   │   ├── index.ts       # 入口：WS Server + 流程编排
│   │   ├── ws-handler.ts  # Minecraft WS 协议处理
│   │   └── gemini.ts      # Gemini API 集成
│   ├── logs/              # 每轮构建的 md 日志 (gitignored)
│   └── .env               # 配置 (gitignored)
├── packs/
│   ├── BP/
│   │   ├── manifest.json  # @minecraft/server 1.16.0
│   │   └── scripts/
│   │       └── main.ts    # scriptevent 监听 + runJob 放置
│   └── RP/
├── data/
│   └── ts_compiler/       # 本地 Regolith filter (esbuild)
│       ├── compiler.js
│       └── package.json
└── config.json            # Regolith 配置
```

## 构建与运行

- 服务端：`cd server && npx tsx src/index.ts`
- 行为包：`regolith run`（输出到 com.mojang/development_behavior_packs/）
- 游戏内：`/wsserver ws://localhost:8000`，然后 `!ai <描述>`

## 关键经验（踩坑记录）

### Regolith
- **不要用远程 `system_template_esbuild` filter**，用本地 `ts_compiler` filter（`runWith: "nodejs"`）
- TS 源码放在 `packs/BP/scripts/main.ts`，compiler.js 编译后输出 main.js 到同目录
- `dataPath` 是 `"./data"`，filter 脚本路径相对于项目根目录

### Minecraft WS 协议
- `/querytarget` 的 `statusMessage` 带本地化前缀（中文版为 `"目标数据：[...]"`），必须用 `indexOf("[")` 提取 JSON 部分再 parse
- `/querytarget` 返回的坐标在 `position` 子对象内：`targets[0].position.x`，不是顶层 `targets[0].x`
- `PlayerMessage` 事件需过滤 `type === "chat"`，否则 tellraw 回显会触发无限循环

### scriptevent 分块
- `/scriptevent` 消息有长度限制，大 JSON 会截断导致行为包 JSON.parse 崩溃
- 默认 CHUNK_SIZE=5（通过 .env 配置），每块约 400-500 字符，安全范围内
- 分块间 150ms 延迟，避免客户端过载

### 行为包 Script API
- 用 `block.setType(blockType)` 而非 `BlockPermutation.resolve()` + `setPermutation()`，前者对无效方块名更健壮
- generator 内的异常必须 try/catch，否则 `system.runJob` 会导致脚本引擎崩溃
- `system.afterEvents.scriptEventReceive.subscribe` 不传 options 参数，手动在回调内判断 `event.id`

## 配置项 (.env)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| GEMINI_API_KEY | (必填) | Gemini API 密钥 |
| GEMINI_MODEL | gemini-2.0-flash | 模型名 |
| PORT | 8000 | WS 服务端口 |
| CHUNK_SIZE | 5 | scriptevent 每块方块数 |
