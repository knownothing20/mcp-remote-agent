---
name: agentport
description: AI Remote Development Gateway for MCP, CLI fallback, SSH recovery, and persistent daemon jobs - 让 AI Agent 稳定操作远程 Linux 开发环境。触发词：远程连接、远程执行、远端命令、远程文件、remote、MCP、AI Agent、守护进程、脚本执行、job、status、logs、base64转义、文件元信息、stat、配置热重载、remote_config
license: MIT
---

# agentport

AI Remote Development Gateway for MCP, CLI, SSH, and persistent daemon jobs

让 AI Agent 通过稳定远程开发网关操作 Linux 服务器：支持原生 MCP、CLI fallback、daemon HTTP API、SSH 恢复和持久 Job。

**类比**：VS Code Remote SSH 是给人用的，agentport 是给 AI 用的。

**v2.5.0**

## 首次使用快速引导（先过 4 项）

为避免"能看到 skill 但 remote_* 工具不可用"，第一次使用时必须先检查这 4 项：

1. **MCP 注册是否正确**
   - 目标 AI 软件的 MCP 配置里必须有 `agentport`
   - `command`/`args` 路径必须是当前机器可执行的绝对路径
2. **skill 是否安装完整**
   - `SKILL.md`、`index.js`、`package.json`、`local/agentport.json` 必须存在
3. **依赖是否安装完整（关键门槛）**
   - `node_modules` 必须存在
   - `ssh2`、`@modelcontextprotocol/sdk`、`axios` 必须可用
   - 任何依赖缺失都可能导致 MCP 进程启动即崩溃，进而 `remote_*` 工具无法注入
4. **连接信息是否正确**
   - `connections.json` 中的 `host/port/username/password(privateKey)` 必须可用
   - daemon 模式下 `url/authToken/clientId` 必须与远端 `.env` 对齐

### 失败特征 -> 根因（优先看这个）

| 现象/报错 | 根因 | 处理 |
|---|---|---|
| `Cannot find package 'ssh2'` | 客户端依赖未安装或损坏 | 在 skill 目录执行 `npm install`（或 `pnpm install`）后重开会话 |
| `Yallist is not a constructor` | 本机 npm/tar 运行环境异常 | 先修复 Node/npm（建议重装 Node LTS），再重装依赖 |
| 只看到 SKILL 文档，看不到 `remote_*` | MCP 进程启动失败或注入失败 | 先修依赖/注册，再重开会话触发重新注入 |

### AI 强制执行顺序（禁止跳步）

1. 先确认依赖：`node_modules` + `ssh2` 可用
2. 再进入会话并执行 `remote_connect()`
3. 再执行 `remote_health()`
4. 只有第 2、3 步都成功，才允许执行其余 `remote_*`

> 不允许先做远程操作再回头补依赖检查。

## AI 开场强制模板（每次新会话先执行）

```text
[PRECHECK_REQUIRED]
1) 先执行 remote_connect()
   - 必须返回连接列表
   - 必须确认当前连接正确
2) 再执行 remote_health()
   - 必须返回健康 JSON

[BLOCK_ON_FAILURE]
若未返回健康 JSON（例如只返回文档、工具不可见、超时）：
- 立即停止后续 remote_* 操作
- 直接提示：当前会话注入失败，请重开会话或重载 MCP 后重试
```

通过以上预检后，才进入正式读写/执行。

---

## 核心原则：agentport.json 是唯一配置入口

> **所有可变配置都集中在 `agentport.json` 的 `variables` 区。**
> 部署到新环境时，只需修改这一个文件，然后运行 `node sync.cjs` 自动同步到所有下游文件。

`variables` 分两组：

| 组 | 变量 | 用途 |
|----|------|------|
| **客户端** | `remoteUrl`、`authToken`、`clientId`、`timeoutMs`、`skillDir`、`nodePath` | 本地 MCP 连接远端守护进程的配置 |
| **MCP 注册** | `mcpConfigPath`、`mcpServerName` | 目标 AI 工具的 MCP 配置文件路径和服务名 |
| **服务端** | `serverPort`、`serverBindHost`、`serverWorkspaceRoot`、`serverEnableDashboard`、`serverExecTimeoutMs`、`serverExecMaxConcurrency`、`serverDaemonDir`、`serverAuditLogPath`、`serverAuthTokens`、`serverAdminTokens` | 远程守护进程的运行配置 |

`sync.cjs` 自动把这些变量同步到：

| 目标文件 | 同步内容 |
|----------|----------|
| `package.json` | version、name、description |
| `index.js` | version 常量、启动日志 |
| `SKILL.md` | 版本号 |
| `<mcpConfigPath>` | MCP server 注册（变量替换，路径由 agentport.json 的 mcpConfigPath 决定） |
| `server/.env` | 服务端运行配置（自动生成） |
| `test/test.cjs` | 安装后诊断与兼容测试入口 |

---

## 目录结构

```
agentport/
├── SKILL.md                        # 本说明文件
├── index.js                        # MCP server 主程序（客户端）
├── package.json                    # 客户端依赖声明
├── agentport.example.json   # 配置模板（复制到 local/agentport.json 后修改）
├── sync.cjs                        # 变量同步脚本
├── test/                           # 安装后诊断与跨平台回归测试
├── local/                          # 本地配置（不上传 Git）
│   ├── agentport.json       # ⭐ 唯一配置入口（从模板复制）
│   ├── connections.json            # ⭐ 动态连接配置（可选）
│   └── server/.env                 # 服务端配置（由 sync.cjs 自动生成）
└── server/                         # 远程守护进程（部署到 Linux 服务器）
    ├── server.js                   # 守护进程主程序
    ├── agentport-manager.sh # 进程守护脚本（崩溃 5s 自动拉起）
    └── package.json                # 服务端依赖声明
```

---

## 动态连接功能（v2.3.0+）

支持在多个远程服务器之间动态切换，无需重启 MCP 服务。

### 配置文件：connections.json

```json
{
  "connections": [
    {
      "name": "prod",
      "description": "Production server",
      "url": "http://YOUR_SERVER_IP:3183",
      "authToken": "your-token",
      "clientId": "your-client-id"
    },
    {
      "name": "dev",
      "description": "Dev server",
      "url": "http://YOUR_DEV_SERVER_IP:3183",
      "authToken": "your-token",
      "clientId": "your-client-id"
    }
  ],
  "default": "prod"
}
```

### 使用方法

1. **查看可用连接**：
   ```
   remote_connect()
   ```

2. **切换到指定连接**：
   ```
   remote_connect(connection="dev")
   ```

3. **所有后续操作**会自动使用当前连接，直到再次切换。

### 工具列表

| 工具 | 说明 | SSH 模式 | 守护进程模式 |
|------|------|----------|--------------|
| `remote_ssh_info` | 扫描本地 SSH 环境（密钥、config、已知主机） | ✅ | ✅ |
| `remote_setup` | 引导式连接设置（密码/密钥） | ✅ | ❌ |
| `remote_connect` | 切换远程连接或查看可用连接 | ✅ | ✅ |
| `remote_health` | 检查当前连接的健康状态 | ✅ | ✅ |
| `remote_read` | 读取远程文件 | ✅ | ✅ |
| `remote_write` | 写入远程文件 | ✅ | ✅ |
| `remote_stat` | 获取文件元信息 | ✅ | ✅ |
| `remote_glob` | 搜索远程文件 | ✅ | ✅ |
| `remote_status` | 获取连接诊断信息 | ✅ | ✅ |
| `remote_bash` | 执行远程命令 | ✅ | ✅ |
| `remote_script` | 执行远程脚本 | ✅ | ✅ |
| `remote_script_async` | 异步执行远程脚本 | ❌ | ✅ |
| `remote_batch` | 批量操作 | ✅ | ✅ |
| `remote_exec_async` | 异步执行命令 | ❌ | ✅ |
| `remote_task` | 查询异步任务状态 | ❌ | ✅ |
| `remote_config` | 读取/修改远程配置 | ❌ | ✅ |

---

## SSH 直连模式（v2.4.0+）

支持通过 SSH 直接连接远程服务器，无需部署守护进程。适合快速开始开发。

### 配置文件：connections.json

```json
{
  "connections": [
    {
      "name": "ssh-dev",
      "type": "ssh",
      "description": "Development server (SSH direct)",
      "host": "YOUR_SERVER_IP",
      "port": 22,
      "username": "root",
      "privateKey": "~/.ssh/id_rsa"
    },
    {
      "name": "daemon-prod",
      "type": "daemon",
      "description": "Production server (daemon mode)",
      "url": "http://YOUR_SERVER_IP:3183",
      "authToken": "YOUR_AUTH_TOKEN",
      "clientId": "YOUR_CLIENT_ID"
    }
  ],
  "default": "ssh-dev"
}
```

### SSH 连接参数

| 参数 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `type` | 连接类型，必须是 `ssh` | ✅ | - |
| `host` | 服务器 IP 或域名 | ✅ | - |
| `port` | SSH 端口 | ❌ | 22 |
| `username` | SSH 用户名 | ✅ | - |
| `privateKey` | SSH 私钥路径 | ❌ | - |
| `password` | SSH 密码 | ❌ | - |
| `passphrase` | 私钥密码 | ❌ | - |

### 使用方法

1. **配置 SSH 连接**：
   ```bash
   cp local/connections.json.example local/connections.json
   # 编辑 connections.json，添加 SSH 连接配置
   ```

2. **切换到 SSH 连接**：
   ```
   remote_connect(connection="ssh-dev")
   ```

3. **检查连接状态**：
   ```
   remote_health()
   ```

4. **开始开发**：
   ```
   remote_bash(command="ls -la")
   remote_read(path="/path/to/file")
   remote_write(path="/path/to/file", content="Hello World")
   ```

### SSH 模式 vs 守护进程模式

| 特性 | SSH 模式 | 守护进程模式 |
|------|----------|--------------|
| **部署要求** | 无需部署 | 需要部署守护进程 |
| **连接方式** | SSH 直连 | HTTP API |
| **异步执行** | ❌ 不支持 | ✅ 支持 |
| **配置管理** | ❌ 不支持 | ✅ 支持 |
| **工作区隔离** | ❌ 无 | ✅ 有 |
| **适用场景** | 快速开发、临时使用 | 长期开发、生产环境 |

### 从 SSH 模式升级到守护进程模式

1. **通过 SSH 部署守护进程**：
   ```bash
   # 上传服务端文件
   scp server/* user@server:~/.agentport/daemon/
   
   # 在服务器上安装依赖
   ssh user@server "cd ~/.agentport/daemon && npm install"
   
   # 启动守护进程
   ssh user@server "cd ~/.agentport/daemon && nohup node server.js > server.log 2>&1 &"
   ```

2. **更新 connections.json**：
   ```json
   {
     "name": "daemon-prod",
     "type": "daemon",
     "url": "http://YOUR_SERVER_IP:3183",
     "authToken": "YOUR_AUTH_TOKEN",
     "clientId": "YOUR_CLIENT_ID"
   }
   ```

3. **切换到守护进程模式**：
   ```
   remote_connect(connection="daemon-prod")
   ```

---

## remote_ssh_info 本地 SSH 环境扫描（v2.5.0+）

独立扫描本地 SSH 环境，返回完整的 SSH 资源信息。

> **注意**：`remote_setup` 已内置扫描逻辑——未提供认证时会自动扫描并返回推荐。`remote_ssh_info` 适合在不需要连接的场景下单独使用（如查看已有密钥、检查 config 配置等）。

### 返回内容

| 字段 | 说明 |
|------|------|
| `privateKeys` | 本地私钥列表（文件名、类型、是否加密） |
| `publicKeys` | 公钥列表 |
| `configHosts` | `~/.ssh/config` 中已配置的主机 |
| `knownHosts` | `known_hosts` 中已连接过的主机 |
| `savedConnections` | `connections.json` 中已保存的连接 |

### AI 使用规则

`remote_ssh_info` 适合以下场景单独使用：
1. 用户只想查看本地有哪些 SSH 密钥和配置
2. 用户在配置其他工具（如 VS Code Remote SSH）前查看可用资源
3. 排查 SSH 连接问题时查看 known_hosts 和 config

---

## remote_setup 引导式连接设置（v2.5.0+）

新增的 `remote_setup` 工具可以引导用户完成连接配置，全程无需了解 SSH 专业知识。

### 使用方法

#### 1. 测试连接（不保存配置）

```
remote_setup(
  host="YOUR_SERVER_IP",
  username="your-username",
  password="your-password"
)
```

或使用密钥：

```
remote_setup(
  host="YOUR_SERVER_IP",
  username="your-username",
  privateKey="~/.ssh/id_ed25519"
)
```

#### 2. 保存连接配置

去掉 `testOnly` 参数即可自动保存：

```
remote_setup(
  host="YOUR_SERVER_IP",
  username="your-username",
  password="your-password",
  name="my-server",
  description="开发服务器"
)
```

#### 3. 自动部署守护进程

SSH 连接成功后，`remote_setup` 会自动：
- 检查服务器上是否已部署守护进程
- 如果未部署，自动上传服务端文件
- 安装 npm 依赖
- 生成认证配置
- 启动守护进程服务
- 切换到守护进程模式

### 参数说明

| 参数 | 说明 | 必填 | 示例 |
|------|------|------|------|
| `host` | 服务器 IP 或域名 | ✅ | `YOUR_SERVER_IP` |
| `username` | SSH 用户名 | ✅ | `your-username` |
| `port` | SSH 端口 | ❌ | 22 |
| `password` | 登录密码 | 密码或密钥二选一 | - |
| `privateKey` | 私钥文件路径 | 密码或密钥二选一 | `~/.ssh/id_ed25519` |
| `passphrase` | 私钥密码（如果密钥有保护） | ❌ | - |
| `name` | 连接名称 | ❌ | 自动生成 |
| `description` | 连接描述 | ❌ | 自动生成 |
| `testOnly` | 仅测试不保存 | ❌ | `true` |

### (AI 必须遵守) remote_setup 安装引导规则

#### 1. 连接前必须先扫描本地 SSH 环境

`remote_setup` **代码层面已内置扫描逻辑**：当调用时未提供 `password` 和 `privateKey`，会自动扫描本地 SSH 环境并返回智能推荐。

AI 只需直接调用 `remote_setup(host, username)`，工具会自动返回扫描结果和推荐选项，AI 根据返回内容引导用户选择。

**标准流程：**

```
用户: 帮我连接 192.0.2.10

AI: 好的，我来帮你设置连接。
    [调用 remote_setup(host="192.0.2.10", username="root")]

    工具返回 needsAuth=true，AI 展示扫描结果：

    🔍 SSH 环境扫描结果：
    ✅ 发现 2 个私钥：id_ed25519（未加密）、id_rsa（已加密）
    ✅ SSH config 中有匹配主机 'dev' → 192.0.2.10:22
    ✅ known_hosts 中已记录此主机

    你想用哪个方式连接？
    1. 使用 id_ed25519 密钥（推荐，未加密）
    2. 使用 id_rsa 密钥（需要输入密钥密码）
    3. 使用密码登录

情况 B：无可用密钥
    🔍 SSH 环境扫描结果：
    ❌ 未找到私钥
    ❌ SSH config 中无匹配配置

    你想要：
    1. 使用密码登录（输入 SSH 密码即可）
    2. 使用加密密钥（需提供密钥密码）

情况 C：SSH config 已有完整配置
    🔍 SSH 环境扫描结果：
    ✅ SSH config 中发现 'prod' → 192.0.2.10:22 user=root key=~/.ssh/id_ed25519

    检测到 SSH config 中已有此服务器的配置，直接使用 config 中的设置连接吗？
    （选择"是"则直接调用 remote_setup 带上 config 中的信息）
```

**关键原则：**
- 不要跳过扫描直接问"用密码还是密钥"
- 有 config 匹配时优先推荐 config（零配置）
- 有多个密钥时列出让用户选择，不要自动选第一个
- 没有密钥时提供两个选项：密码登录 或 使用加密密钥
- 用户选择后，带上正确参数再次调用 `remote_setup`

#### 2. 分步提问，一次只问一个参数

AI 在引导用户配置连接时，**必须一次只询问一个参数**，不要一次性列出所有问题。
推荐提问顺序：host → username → remote_setup（自动扫描）→ 认证方式选择 → password/privateKey → workspaceRoot（可选）

#### 3. 术语规范

| 术语 | 含义 | 推荐默认值 |
|------|------|-----------|
| `workspaceRoot` / 工作区根目录 | 远程开发的安全边界，所有文件操作限制在此目录内 | `/home/<username>/workspace` |
| `authToken` / 认证令牌 | API 鉴权令牌 | 自动生成，不需用户提供 |

⚠️ **禁止使用"工作目录"一词**——这会让用户误以为是普通的项目目录，实际上 `workspaceRoot` 是安全沙箱的根路径。

#### 4. 理想对话流程示范

```
AI: 请问你要连接的服务器 IP 地址是什么？
用户: 192.0.2.10

AI: SSH 用户名是什么？（一般是 root 或你的 Linux 用户名）
用户: yourname

AI: 好的，我来帮你设置连接。
    [调用 remote_setup(host="192.0.2.10", username="yourname")]

    🔍 SSH 环境扫描结果：
    ✅ 发现 2 个私钥：id_ed25519（未加密）、id_rsa（已加密）
    ✅ known_hosts 中已记录此主机

    你想用哪个方式连接？
    1. 使用 id_ed25519 密钥（推荐，未加密）
    2. 使用 id_rsa 密钥（需要输入密钥密码）
    3. 使用密码登录

用户: 1

AI: [调用 remote_setup(host="192.0.2.10", username="yourname", privateKey="~/.ssh/id_ed25519")]
    ✅ SSH 连接测试成功
    ⏳ 正在部署守护进程...
    ✅ 守护进程已启动

    **连接信息：**
    - SSH: yourname@192.0.2.10:22
    - Daemon: http://192.0.2.10:3183
    - 工作区: /home/yourname

    📊 Dashboard: http://192.0.2.10:3183/?token=xxx

    还有其他服务器需要连接吗？如果没有的话，可以开始远程开发了！
```

#### 5. 多服务器接力配置

一台服务器配置完成后，AI 应该**主动询问**用户是否还有其他服务器需要连接。
如果用户有多台服务器，重复 `remote_setup` 流程，所有连接会自动保存在 `connections.json` 中。
后续使用 `remote_connect(connection="连接名")` 在服务器之间切换。

#### 6. Token 自动生成

如果用户未提供 `authToken`，AI 应该**自动在远程服务器上执行命令生成安全 Token**，而不是询问用户。
生成命令示例：
```bash
echo "token-$(hostname)-$(date +%s)-$(head -c 8 /dev/urandom | base64 | tr -dc 'a-z0-9')"
```

---

## 部署步骤（从零开始）

### 第 1 步：准备远程 Linux 服务器

确保服务器已安装 Node.js（v18+）和 npm。

### 第 2 步：上传服务端文件

将 `server/` 目录下的文件上传到远程服务器：

```bash
# 在远程服务器上
mkdir -p <serverDaemonDir>

# 从本地 scp（在本地执行）
scp server/server.js server/agentport-manager.sh server/package.json YOUR_USER@YOUR_SERVER:<serverDaemonDir>/
```

### 第 3 步：配置 local/agentport.json（本地）

复制模板并填写真实配置：

```bash
cp agentport.example.json local/agentport.json
```

编辑 `local/agentport.json`，**只需要改 `variables` 区**：

```json
{
  "name": "agentport",
  "version": "2.5.0",
  "variables": {
    "remoteUrl": "http://你的服务器IP:3183",
    "authToken": "你的客户端token",
    "clientId": "你的客户端名称",
    "timeoutMs": "120000",
    "skillDir": "skill目录的绝对路径",
    "nodePath": "node",

    "mcpConfigPath": "你的AI工具的MCP配置文件路径",
    "mcpServerName": "agentport",

    "serverPort": "3183",
    "serverBindHost": "0.0.0.0",
    "serverWorkspaceRoot": "/home/你的用户名/你的工作区",
    "serverEnableDashboard": "true",
    "serverExecTimeoutMs": "120000",
    "serverExecMaxConcurrency": "2",
    "serverDaemonDir": "/home/你的用户名/.agentport/daemon",
    "serverAuditLogPath": "/home/你的用户名/.agentport/daemon/audit.log",
    "serverAuthTokens": "client1=token1,client2=token2",
    "serverAdminTokens": "token1,token2"
  }
}
```

#### mcpConfigPath 常见平台参考

不同 AI 工具的 MCP 配置文件路径不同，`mcpConfigPath` 填对应的路径即可：

| AI 工具 | mcpConfigPath（Windows） | mcpConfigPath（macOS/Linux） |
|---------|--------------------------|------------------------------|
| **WorkBuddy** | `C:\Users\<用户>\.workbuddy\mcp.json` | `~/.workbuddy/mcp.json` |
| **Claude Desktop** | `C:\Users\<用户>\AppData\Roaming\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| **Cursor** | `<项目目录>\.cursor\mcp.json` | `<项目目录>/.cursor/mcp.json` |
| **Windsurf** | `C:\Users\<用户>\.codeium\windsurf\mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` |
| **Cline (VS Code)** | 写入 VS Code `settings.json` 的 `mcp` 字段 | 同左 |

> 💡 **部署到新 AI 工具时**，只需要改两个变量：`skillDir`（指向新安装位置）和 `mcpConfigPath`（指向新工具的配置文件），然后 `node sync.cjs` 一键同步。

#### MCP 注册（通用）

**其他 AI 工具部署时**，sync.cjs 可能无法自动写入配置文件（格式/路径不同）。需要手动在目标软件的 MCP 配置中添加以下内容：

**JSON 格式**（如 WorkBuddy、Cursor）：
```json
{
  "mcpServers": {
    "agentport": {
      "command": "node",
      "args": ["<skillDir>/index.js"],
      "env": {
        "MCP_REMOTE_URL": "<remoteUrl>",
        "MCP_REMOTE_AUTH_TOKEN": "<authToken>",
        "MCP_REMOTE_CLIENT_ID": "<clientId>",
        "MCP_REMOTE_TIMEOUT_MS": "<timeoutMs>"
      }
    }
  }
}
```

**TOML 格式**（如 Codex）：
```toml
[mcp_servers.agentport]
command = "node"
args = [ "<skillDir>/index.js" ]
env.MCP_REMOTE_URL = "<remoteUrl>"
env.MCP_REMOTE_AUTH_TOKEN = "<authToken>"
env.MCP_REMOTE_CLIENT_ID = "<clientId>"
env.MCP_REMOTE_TIMEOUT_MS = "<timeoutMs>"
```

> ⚠️ 将 `<skillDir>`、`<remoteUrl>`、`<authToken>`、`<clientId>`、`<timeoutMs>` 替换为 agentport.json 中对应的值。

> ⚠️ `agentport.json` 含敏感信息，不要提交到 Git。

#### Token 格式说明

- **AUTH_TOKENS**：`客户端名=密钥`，逗号分隔。例如 `my-laptop-codex=codex-abc123,my-desktop-workbuddy=workbuddy-xyz789`
- **ADMIN_TOKENS**：密钥列表，逗号分隔。拥有 admin token 可访问 Dashboard 和 `/api/config`
- 建议格式：`{主机名}-{软件名}-{随机后缀}`，如 `my-laptop-workbuddy-a1b2c3d4e5f6`

### 第 4 步：运行 sync

```bash
cd <skillDir>    # 即 agentport.json 中 skillDir 的值，如 ~/.workbuddy/skills/agentport

# 安装客户端依赖
npm install

# 执行同步（自动更新 package.json、index.js、mcp.json、server/.env 等）
node sync.cjs

# 预览模式（只看差异不写文件）
node sync.cjs --dry-run

# 检查一致性
node sync.cjs --check
```

### 第 5 步：部署服务端 .env

sync 后 `local/server/.env` 已自动生成，上传到远程服务器：

```bash
scp local/server/.env YOUR_USER@YOUR_SERVER:<serverDaemonDir>/
```

### 第 6 步：启动远程守护进程

```bash
# SSH 到远程服务器
cd <serverDaemonDir>
npm install
nohup bash agentport-manager.sh >> boot.log 2>&1 &
```

设置开机自启（可选）：

```bash
(crontab -l 2>/dev/null; echo "@reboot sleep 10 && /bin/bash <serverDaemonDir>/agentport-manager.sh") | crontab -
```

### 第 7 步：验证

```bash
# 本地测试
node test/test.cjs

# 或仅本地检查（不需要远端在线）
node test/test.cjs --local-only
```

在 AI 对话中输入 `远程连接测试`，AI 会自动调用 `remote_health` 检查。

---

## 工具一览

| 工具 | 说明 | 版本 |
|------|------|------|
| `remote_health` | 检查远端守护进程是否可达（优先 GET /healthz） | v1.0 |
| `remote_read` | 读取远程文件（ETag 缓存，304 条件读不重传） | v1.0 |
| `remote_write` | 写入远程文件（自动 CRLF→LF、去 BOM、`expectedEtag` 乐观锁） | v2.1 |
| `remote_stat` | 获取远程文件元信息（大小、修改时间、类型） | v2.1 |
| `remote_glob` | 按 glob 规则搜索远程文件 | v1.0 |
| `remote_bash` | 执行远程命令（含特殊字符自动 base64 编码，避免转义问题） | v2.1 |
| `remote_script` | 执行多行脚本（写入临时文件再执行，彻底避免 bash 转义/编码问题） | v2.1 |
| `remote_script_async` | 将多行脚本提交为持久后台任务并立即返回 taskId | v2.5 |
| `remote_status` | 综合诊断：连接状态、延迟、缓存命中率、操作统计 | v1.2 |
| `remote_batch` | 批量操作，一次请求最多 20 个 read/stat/glob/bash | v2.0 |
| `remote_exec_async` | 异步执行长耗时命令，立即返回 taskId | v2.0 |
| `remote_task` | 查询异步命令状态和输出 | v2.0 |
| `remote_config` | 读取或修改远端守护进程配置（.env），修改后自动热重载，无需重启服务 | v2.2.1 |
| `remote_setup` | 引导式连接设置，自动部署守护进程 | v2.5.0 |

### 工具参数详情

**remote_health**
- 无参数

**remote_read**
- `path` (必填): 文件路径，⚠️ 必须在工作区（WORKSPACE_ROOT）内，否则返回 Access denied

**remote_write**
- `path` (必填): 文件路径，⚠️ 必须在工作区内
- `content` (必填): UTF-8 文本内容（自动清理 CRLF→LF 和 UTF-8 BOM）
- `expectedEtag` (可选): 乐观并发锁，防止覆盖他人修改

**remote_stat**
- `path` (必填): 文件路径，⚠️ 必须在工作区内，返回大小、修改时间、是否为文件/目录

**remote_glob**
- `pattern` (必填): glob 模式，如 `**/*.ts`、`src/**/*.py`
- `cwd` (可选): 搜索起始目录

**remote_bash**
- `command` (必填): 要执行的 bash 命令（含 `$` `` ` `` `\` `!` `"` `#` `;` `&` `|` 等特殊字符时自动 base64 编码，无需手动处理）
- `cwd` (可选): 工作目录

**remote_script**
- `content` (必填): 脚本内容，原样写入远程临时文件执行，不经过 bash -c 解析
- `interpreter` (可选): 解释器，默认 `bash`，支持 `bash`、`sh`、`python3`、`node` 等
- `cwd` (可选): 工作目录

**remote_batch**
- `operations` (必填): 操作数组，每项含 `type` (read/stat/glob/bash) 及对应参数

**remote_exec_async**
- `command` (必填): 要异步执行的 bash 命令
- `cwd` (可选): 工作目录
- 返回 `taskId`，用 `remote_task` 轮询结果

**remote_task**
- `taskId` (必填): `remote_exec_async` 返回的任务 ID

**remote_config**
- `action` (必填): `read` 或 `write`
  - `read`：读取远端当前配置（token 自动脱敏显示）
  - `write`：写入新配置并触发热重载，**无需重启服务**
- `config` (write 时必填): 新的 .env 完整内容（整文件替换）

> 💡 `remote_config` 适合以下场景：
> - 动态添加/删除客户端 token
> - 修改工作区目录
> - 调整超时/并发参数
> - 修改后自动重载，服务不中断

---

## 客户端环境变量

在 `agentport.json` 的 `variables` 中配置，通过 `sync.cjs` 自动写入 `mcp.json`：

| 变量 | 对应 agentport.json key | 说明 | 必填 | 默认值 |
|------|--------------------------------|------|------|--------|
| `MCP_REMOTE_URL` | `remoteUrl` | 远端守护进程地址 | ✅ | — |
| `MCP_REMOTE_AUTH_TOKEN` | `authToken` | API 鉴权 token | ✅ | — |
| `MCP_REMOTE_CLIENT_ID` | `clientId` | 客户端标识（用于远端审计日志） | 推荐 | — |
| `MCP_REMOTE_TIMEOUT_MS` | `timeoutMs` | 请求超时（毫秒） | 否 | `120000` |
| `MCP_REMOTE_PRESERVE_CRLF` | — | 写文件时保留 CRLF（默认自动转 LF） | 否 | `false` |

> 💡 旧版环境变量名 `NIUMA_SSH_*` 仍然兼容，但建议使用新名称。

#### MCP 注册变量

| 变量 | 对应 agentport.json key | 说明 | 必填 | 默认值 |
|------|--------------------------------|------|------|--------|
| — | `mcpConfigPath` | 目标 AI 工具的 MCP 配置文件路径（sync.cjs 据此写入） | ✅ | — |
| — | `mcpServerName` | MCP 注册的 server 名称 | 否 | `agentport` |
| — | `skillDir` | skill 安装目录绝对路径（用于生成 MCP args） | ✅ | — |
| — | `nodePath` | node 可执行文件路径 | 否 | `node` |

---

## 服务端环境变量

在 `agentport.json` 的 `variables` 中配置，通过 `sync.cjs` 自动生成 `server/.env`：

| .env 变量 | 对应 agentport.json key | 说明 | 默认值 |
|-----------|---------------------|------|--------|
| `PORT` | `serverPort` | 服务端口 | `3183` |
| `BIND_HOST` | `serverBindHost` | 绑定地址 | `0.0.0.0` |
| `WORKSPACE_ROOT` | `serverWorkspaceRoot` | 工作区根目录，限制文件读写范围 | — |
| `ENABLE_DASHBOARD` | `serverEnableDashboard` | 是否开启网页控制台 | `true` |
| `EXEC_TIMEOUT_MS` | `serverExecTimeoutMs` | 命令执行超时（毫秒） | `120000` |
| `EXEC_MAX_CONCURRENCY` | `serverExecMaxConcurrency` | 最大并发执行数 | `2` |
| `AUDIT_LOG_PATH` | `serverAuditLogPath` | 审计日志路径 | daemon 目录下 |
| `AUTH_TOKENS` | `serverAuthTokens` | API 客户端鉴权，格式 `clientId=token,clientId=token` | — |
| `ADMIN_TOKENS` | `serverAdminTokens` | Dashboard 鉴权，格式 `token1,token2` | — |
| `ALLOW_BASH_EXEC` | — | 是否允许 `remote_bash` 执行任意命令 | `true` |
| `ALLOWED_COMMANDS` | — | 命令白名单，逗号分隔。为空时无限制（除非 ALLOW_BASH_EXEC=false） | — |

---

## 远端 API 路径

MCP client 自动回退，优先新版：

| 操作 | 新版路径 | 旧版路径 | 方法 |
|------|---------|---------|------|
| 健康检查 | `/healthz` | — | GET |
| 读文件 | `/api/fs/read` | `/read` | POST |
| 写文件 | `/api/fs/write` | `/write` | POST |
| 搜索 | `/api/fs/glob` | `/glob` | POST |
| 执行 | `/api/exec` | `/bash` | POST |
| 脚本执行 | `/api/exec/script` | — | POST |
| 批量 | `/api/batch` | — | POST |
| 异步执行 | `/api/exec/async` | — | POST |
| 任务查询 | `/api/task/:id` | — | GET |
| 配置读取 | `/api/config` | — | GET |
| 配置写入 | `/api/config` | — | PUT |
| 状态统计 | `/api/stats` | — | GET |
| 错误日志 | `/api/errors` | — | GET |

---

## Dashboard

浏览器访问（需带 admin token）：

```
http://<服务器IP>:3183/?token=your-admin-token
```

Dashboard 功能：
- 查看服务状态和在线客户端
- 热切换工作区目录（无需重启）
- 查看审计日志

---

## 使用规范（AI 必须遵守）

### 自动健康检查

- **首次操作前**，必须先调用 `remote_health` 确认远端服务可达
- **连续操作间隔 > 5 分钟**时，重新检查健康状态
- **写入操作前**必须确认连接正常
- 健康检查失败时，不要继续执行后续操作，直接告知用户

### 会话注入自检（强烈推荐）

为避免"只看到 skill 文档、却无法调用 remote_* 工具"的状态漂移，每次开启新会话时先执行下面 3 步：

1. 调用 `remote_connect()` 查看是否返回连接列表
2. 立即调用 `remote_health()`
3. 仅当 `remote_health()` 返回 JSON 健康结果时，再开始远程读写/执行

如果 `remote_health()` 没有返回健康 JSON（例如只返回说明文档、工具不可见、超时），直接判定为注入失败：
- 不要在当前会话继续硬做
- 立即重开会话或重载 MCP 配置后再试

推荐首句触发词：`远程连接测试`（先健康检查，再进入正式任务）

### 操作重试

- 网络错误（ECONNREFUSED / ETIMEDOUT / ECONNRESET）**自动重试 1 次**
- 重试前等待 2 秒
- 连续失败 2 次后停止并通知用户
- 非网络错误（参数错误、404、权限不足等）**不重试**

### 常见场景工作流

| 场景 | 推荐工作流 |
|------|-----------|
| 查看远程文件 | `remote_health` → `remote_read` |
| 编辑远程文件 | `remote_health` → `remote_read` → 修改 → `remote_write` |
| 执行远程命令 | `remote_health` → `remote_bash`（简单命令）或 `remote_script`（多行脚本） |
| 搜索远程代码 | `remote_health` → `remote_glob` |
| 查看文件信息 | `remote_health` → `remote_stat` |
| 批量读多个文件 | `remote_health` → `remote_batch` |
| 长耗时任务 | `remote_health` → `remote_exec_async` / `remote_script_async` → `remote_task` 轮询 |
| 修改远端配置 | `remote_config read` → 修改 → `remote_config write`（自动热重载） |
| 添加新客户端 | `remote_config read` → 在 AUTH_TOKENS 末尾追加 `新客户端名=新token` → `remote_config write` |
| 连接诊断 | `remote_status` |

### 转义与编码规范

| 规则 | 说明 |
|------|------|
| ✅ 优先用 `remote_write` 写文件 | 不走 bash，无转义问题 |
| ✅ 多行脚本用 `remote_script` | 脚本写入临时文件再执行，彻底绕过 bash -c 解析 |
| ✅ 简单命令含 `$` `` ` `` 等用 `remote_bash` | 自动 base64 编码，无需手动处理 |
| ✅ `remote_write` 自动清理 CRLF/BOM | Windows→Linux 写文件不会残留 `\r` |
| ❌ 不要用 `remote_bash "cat > file"` 写文件 | 走 bash 解析，转义容易出错 |
| ❌ 不要用 `remote_bash` 拼接含 `$` `` ` `` 的多行内容 | 即使有 base64 兜底，脚本模式更可靠 |

### 路径限制规范

| 规则 | 说明 |
|------|------|
| ✅ 文件操作用工作区内路径 | `remote_read`/`remote_write`/`remote_stat`/`remote_glob` 的路径必须在 `WORKSPACE_ROOT` 内 |
| ✅ 使用相对路径更安全 | 如 `package.json`、`src/main.py`，自动解析为工作区内路径 |
| ❌ 不要对工作区外路径做文件操作 | `/`、`/tmp/`、`/etc/` 等会返回 `Access denied` |
| ✅ `remote_bash` 不受此限制 | 命令在 shell 中执行，可以访问任何路径 |
| ⚠️ 写临时文件用 `WORKSPACE_ROOT/.agentport-tmp/` | `remote_script` fallback 自动使用此路径 |

### Windows 环境注意事项

| 问题 | 规则 |
|------|------|
| `curl` 被别名 | 用 `curl.exe` 而非 `curl`（PowerShell 把 `curl` 映射到 `Invoke-WebRequest`） |
| curl 卡住 | 加 `-4` 强制 IPv4：`curl.exe -4 -s URL` |
| CRLF 残留 | `remote_write` 已自动清理 CRLF→LF，无需手动处理 |
| BOM 残留 | `remote_write` 已自动去 BOM，`agentport.json` 读取也做了 BOM 剥离 |
| PowerShell 转义 | 不要在 PS 中用 `node -e` 传递复杂脚本，写 `.cjs` 文件再执行 |
| 测试脚本后缀 | 用 `.cjs` 而非 `.js`（`package.json` 的 `"type": "module"` 会让 `.js` 被视为 ESM） |

---

## 故障排查

### 服务启动失败

| 现象 | 原因 | 解决 |
|------|------|------|
| 端口不可达 | 守护进程未启动 | `cd <serverDaemonDir> && nohup bash agentport-manager.sh >> boot.log 2>&1 &` |
| 多个 node server.js 进程 | manager.sh 重复启动 | `pkill -9 -f agentport-manager; pkill -9 -f 'server.js'; sleep 1; cd <serverDaemonDir> && nohup bash agentport-manager.sh >> boot.log 2>&1 &` |
| EADDRINUSE | 端口被占用 | `lsof -i :3183` 找到占用进程并 kill |
| 401/403 | Token 不匹配 | 检查本地 `agentport.json` 的 authToken 与远端 `.env` 的 AUTH_TOKENS |
| 新增 token 不生效 | dotenv 不覆盖已有环境变量 | manager.sh 已自动 unset，确认使用最新版；或用 `remote_config write` 热重载 |

### 客户端连接失败

| 错误 | 原因 | 排查 |
|------|------|------|
| ECONNREFUSED | 服务未启动 | 检查 crontab、查看 `agentport.log` |
| ETIMEDOUT | 网络不通 | `ping` 服务器 IP、检查防火墙 |
| 401 / 403 | Token 不匹配 | 检查本地 `agentport.json` 与远端 `.env` |
| Access denied | 路径超出 WORKSPACE_ROOT | 使用工作区内路径或相对路径 |
| ENOENT | 文件不存在 | 检查路径，注意 `WORKSPACE_ROOT` 限制 |
| 500 | 服务端错误 | 查看 `agentport.log` |
| curl 卡住 | PowerShell 别名 + IPv6 | 用 `curl.exe -4` 替代 `curl` |

---

## 安全建议

1. **不要提交真实 token**：`agentport.json` 含敏感信息，确保在 `.gitignore` 中排除
2. **对外发布仅分享模板**：使用 `agentport.example.json`，不含真实地址和 token
3. **工作区隔离**：远端通过 `WORKSPACE_ROOT` 限制文件访问范围，防止越权
4. **PowerShell 传脚本到远端**：必须用 base64 编码（PS 会解析 `$` `$(...)` 等为变量）
5. **多客户端隔离**：每个客户端使用不同的 `CLIENT_ID`，远端审计日志可追溯
6. **命令执行限制**：
   - 生产环境建议设置 `ALLOW_BASH_EXEC=false` 禁用 `remote_bash`
   - 或使用 `ALLOWED_COMMANDS=git,npm,node,python3` 限制可执行命令
   - 脚本执行 (`remote_script`) 始终受解释器白名单限制
7. **Admin Token 安全**：
   - Admin token 可访问 Dashboard 和配置修改，**不要泄露**
   - 建议与客户端 token 分开生成，定期轮换
   - 生产环境可设置 `ENABLE_DASHBOARD=false` 禁用网页控制台

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v2.5.0 | 2026-04 | `remote_setup` 引导式连接 + 自动部署守护进程；SSH 客户端支持密码和密钥认证 |
| v2.4.0 | 2026-04 | SSH 直连模式；`remote_setup` 引导式设置工具 |
| v2.3.1 | 2026-04 | 安全修复：脚本解释器白名单、命令执行可配置限制；新增 Dashboard HTML UI；新增 setup-autostart-agentport.sh 自启动配置脚本；重构目录结构，配置文件移至 local/ 目录 |
| v2.2.1 | 2026-04 | 新增 `remote_config` 配置热重载工具；niuma.json 升级为变量中心（客户端+服务端配置统一管理）；新增 sync.cjs 自动同步变量到所有下游文件；服务端文件纳入 skill 包 `server/` 目录；SKILL.md 全面重构 |
| v2.2.0 | 2026-04 | 重构 `ensureHealthy()` 辅助函数消除重复代码；`remote_exec_async` 补全 base64 编码；`remote_task` duration 支持 timestamp 和 ISO string；`remote_script` interpreter 增加白名单安全校验；`remote_read` cacheMiss 统计修正；`remote_health` 补全 `recordOp` |
| v2.1.0 | 2026-04 | 新增 `remote_script` 脚本执行、`remote_stat` 文件元信息；bash 命令自动 base64 转义；write 自动清理 CRLF/BOM；health 改用 /healthz；工具 description 中文化；健康检查失败返回 isError |
| v2.0.0 | 2026-04 | 新增 `remote_batch`、`remote_exec_async`、`remote_task`；ETag 缓存；连接健康缓存 |
| v1.1.0 | 2026-04 | 新增 `remote_status` 综合诊断；`NIUMA_SSH_CLIENT_ID` 支持 |
| v1.0.0 | 2026-03 | 初始版本：read/write/glob/bash/health |

---

## 安装后测试

安装完成后，运行测试脚本验证本地文件和远程连接是否正常：

```bash
cd <skillDir>    # 即 agentport.json 中 skillDir 的值

# 完整测试（本地检查 + 远程连接测试）
node test/test.cjs

# 仅本地检查（不需要远端服务在线）
node test/test.cjs --local-only

# 显示详细输出
node test/test.cjs --verbose
```

### 测试覆盖范围

| 阶段 | 测试项 | 说明 |
|------|--------|------|
| **Phase 1: 本地检查** | 核心文件存在 | SKILL.md、index.js、package.json、agentport.json |
| | 依赖安装 | node_modules、@modelcontextprotocol/sdk、axios |
| | index.js 关键代码 | ensureHealthy、ALLOWED_INTERPRETERS、base64 编码等 |
| | 版本号 | package.json 版本匹配 |
| | 配置完整性 | agentport.json 中 REMOTE_URL、AUTH_TOKEN 已配置 |
| **Phase 2: 远程连接** | 健康检查 | GET /healthz 返回 ok |
| | 文件操作 | stat、glob、read（含 ETag）、write + 回读验证 + 清理 |
| | 命令执行 | 简单命令、特殊字符（base64 编码）、管道 |
| | 脚本执行 | bash 多行脚本、python3 解释器 |
| | 批量操作 | batch 混合操作 |
| | 异步执行 | exec_async + task 轮询 + duration 不为 NaN |
| | 诊断 | /api/stats 可达 |
| | UTF-8 | 中文输出正确 |
| **Phase 2e: 边界与兼容** | 路径越界 | stat `/` 和 write `/tmp` 应被拒绝（Access denied） |
| | BOM 清理 | sanitizeContent 剥离 BOM |
| | exitCode 兼容 | formatExecOutput 支持 `code` 和 `exitCode` |
| | isDir 兼容 | remote_stat 支持 `isDir` 和 `isDirectory` |
| | workspaceRoot 缓存 | healthz 响应缓存工作区根路径 |

### 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 全部通过 |
| 1 | 有测试失败 |
| 2 | 致命错误（配置缺失等） |

### 常见失败排查

| 失败项 | 原因 | 解决 |
|--------|------|------|
| node_modules missing | 未安装依赖 | `cd <skillDir> && npm install` |
| agentport.json not found | 配置文件未创建 | `cp agentport.example.json local/agentport.json` 并填写真实配置 |
| REMOTE_URL missing | 环境变量未配置 | 编辑 agentport.json 填写 remoteUrl |
| remote_health: ECONNREFUSED | 远端服务未启动 | 在远端执行一键启动命令 |
| remote_health: HTTP 401 | Token 不匹配 | 检查 authToken 与远端 .env 一致 |
| duration is NaN | 服务端返回 ISO 字符串而非时间戳 | v2.2.0 已修复，确认 index.js 已更新 |
