# MC_AGENT

Minecraft Bedrock Edition AI 建造助手 —— 在聊天框输入自然语言，AI 帮你搭建筑。

## How It Works

```
玩家聊天 "!ai 一个石头小屋"
    │
    ▼  (Minecraft 通过 /wsserver 发送 PlayerMessage)
Node.js Server
    │  ① 发送 /querytarget 获取玩家坐标
    │  ② 调用 Gemini API 生成方块蓝图 (JSON)
    │  ③ 通过 /scriptevent 分块发送给行为包
    ▼
行为包 Script API
    └─ system.runJob 逐 tick 平滑放置方块
```

## Features

- **自然语言建造** —— `!ai a stone hut` / `!ai 一个木头平台`
- **Gemini 驱动** —— 结构化 JSON 输出，自动校验方块 ID
- **平滑放置** —— 每 tick 放一个方块，无卡顿
- **分块传输** —— 自动拆分大蓝图，安全传输
- **构建日志** —— 每轮请求保存为 Markdown，方便复盘

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Regolith](https://bedrock-oss.github.io/regolith/) (Bedrock Addon 构建工具)
- Minecraft Bedrock Edition (开启作弊)
- [Gemini API Key](https://aistudio.google.com/apikey)

### 1. 安装依赖

```bash
# 服务端
cd server
npm install

# 行为包准备
cd ../
regolith install-all
```

### 2. 配置环境变量

```bash
cp server/.env.example server/.env
```

编辑 `server/.env`：

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.0-flash
PORT=8000
CHUNK_SIZE=5
PROMPT_BLOCK_TYPE_LIMIT=0
```

### 3. 构建行为包

```bash
regolith run
```

行为包会自动导出到 `com.mojang/development_behavior_packs/`。

### 4. 启动服务

```bash
cd server
npx tsx src/index.ts
```

### 5. 游戏内连接

```
/connect localhost:8000
```

然后在聊天框输入：

```
!ai a 3x3 stone platform
```

## Project Structure

```
MC_AGENT/
├── server/                  # Node.js 服务端 (TypeScript)
│   ├── src/
│   │   ├── index.ts         # WS Server + 流程编排
│   │   ├── ws-handler.ts    # Minecraft WS 协议处理
│   │   └── gemini.ts        # Gemini API 集成
│   └── logs/                # 构建日志 (每轮一个 .md)
├── packs/
│   ├── BP/                  # 行为包
│   │   ├── manifest.json
│   │   └── scripts/
│   │       └── main.ts      # scriptevent 监听 + runJob 放置
│   └── RP/                  # 资源包 (预留)
├── data/
│   └── ts_compiler/         # Regolith 本地 esbuild filter
├── config.json              # Regolith 配置
└── CLAUDE.md                # 开发指南 & 踩坑记录
```

## Configuration

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `GEMINI_API_KEY` | *(必填)* | Gemini API 密钥 |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini 模型 |
| `PORT` | `8000` | WebSocket 服务端口 |
| `CHUNK_SIZE` | `5` | 每个 scriptevent 包含的方块数 |
| `PROMPT_BLOCK_TYPE_LIMIT` | `0` | system prompt 中 blockType palette 上限；`0` 表示不裁剪 |

## Limitations (MVP)

- 仅支持单人游戏
- 每次最多 200 个方块
- 无撤销功能
- 无对话记忆（每次请求独立）
- 需要开启作弊模式

## Tech Stack

| 组件 | 技术 |
|------|------|
| 服务端 | Node.js + TypeScript + [tsx](https://github.com/privatenumber/tsx) |
| AI | [Gemini API](https://ai.google.dev/) (`@google/genai`) |
| 通信 | WebSocket (`ws`) + Minecraft WS Protocol |
| 行为包构建 | [Regolith](https://bedrock-oss.github.io/regolith/) + esbuild |
| 行为包运行时 | `@minecraft/server` Script API |

## License

MIT
