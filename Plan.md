# Minecraft x LLM 智能建造助手 MVP 开发文档

## 1. 项目概述

构建一个基于 Minecraft 基岩版 (Bedrock) 的智能建造系统。通过 WebSocket 连接游戏客户端与外部 Node.js 服务器，利用 Gemini API 将玩家的自然语言指令转化为游戏内的建造行为。

## 2. 技术栈

- **游戏端：** Minecraft Bedrock Edition + 行为包 (Behavior Pack) + Script API
- **服务端：** Node.js + ws 库
- **AI 引擎：** Gemini API (Google Generative AI SDK)
- **通信协议：** Minecraft WebSocket Protocol (基于 JSON)

## 3. 核心架构设计 (Sense-Think-Act)

### Step 1: Sense (感知) - 行为包

- **监听聊天：** 脚本监听 `world.beforeEvents.chatSend`
- **提取上下文：** 获取玩家当前位置 (`location`)、维度 (`dimension`)、视角方向 (`viewDirection`)
- **上行传输：** 将数据封装为 JSON，通过 `player.runCommand("scriptevent ai:request <JSON>")` 发送

### Step 2: Think (思考) - Node.js 服务器

- **WS 监听：** 监听来自游戏的 `ScriptMessage` 类型事件
- **LLM 交互：**
  - System Prompt: 强制要求 Gemini 仅返回结构化 JSON，禁止包含任何自然语言回复
  - 坐标计算：要求 Gemini 使用基于玩家位置的相对坐标 (Offset)
- **协议转换：** 将 Gemini 的 JSON 蓝图转换为 `/scriptevent ai:build <Blueprint>` 指令

### Step 3: Act (执行) - 行为包

- **解析蓝图：** 监听 `ai:build` 消息
- **平滑构建：** 使用 `system.runJob` (或 Generator) 遍历方块列表，每 Tick 放置 1-5 个方块，防止瞬时卡顿

## 4. 通讯协议规范 (JSON Schema)

### A. 玩家请求 (`ai:request`)

```json
{
  "prompt": "在这里搭建一个2格立体石头方块",
  "origin": { "x": 10, "y": 64, "z": 10 },
  "dimension": "minecraft:overworld"
}
```

### B. AI 蓝图响应 (`ai:build`)

```json
{
  "status": "success",
  "blocks": [
    { "offset": [0, 0, 0], "type": "minecraft:stone" },
    { "offset": [1, 0, 0], "type": "minecraft:stone" },
    { "offset": [0, 0, 1], "type": "minecraft:stone" },
    { "offset": [1, 0, 1], "type": "minecraft:stone" },
    { "offset": [0, 1, 0], "type": "minecraft:stone" },
    { "offset": [1, 1, 0], "type": "minecraft:stone" },
    { "offset": [0, 1, 1], "type": "minecraft:stone" },
    { "offset": [1, 1, 1], "type": "minecraft:stone" }
  ]
}
```

## 5. 任务分解 (AI 编码建议)

### 第一阶段：Node.js 服务端基础

1. 实现一个标准的 WebSocket Server，端口 8000
2. 实现处理 Minecraft 的握手包 (`messagePurpose: "subscribe"`)
3. 集成 Gemini SDK，配置 System Prompt

### 第二阶段：行为包基础环境

1. 配置 `manifest.json`，确保包含 `@minecraft/server` 模块引用
2. 编写 `main.js`：
   - 注册连接 WebSocket 的逻辑
   - 注册 `scriptevent` 监听器

### 第三阶段：端到端连通

1. 实现"一格一格搭建"的逻辑（核心：使用 `dimension.setBlockType`）
2. 添加简单的错误处理（如 Gemini 返回非 JSON 字符串时）

## 6. 关键 System Prompt 设定

> 你是一个 Minecraft 专家。玩家会提供当前位置和建造需求。你必须输出 JSON 格式的方块列表。
>
> - 坐标必须是相对于玩家位置的偏移量 `[dx, dy, dz]`
> - 使用标准的 Minecraft 基岩版方块标识符（如 `minecraft:stone`）
> - 只输出 JSON，不输出任何其他文字
