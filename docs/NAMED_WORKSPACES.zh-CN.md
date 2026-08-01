# 命名式多工作区

AgentPort 可以同时授权多个彼此独立的目录，而不必把 `WORKSPACE_ROOT`
扩大到整个用户主目录。

## 推荐配置

在 daemon 的 `.env` 中保留默认工作区：

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
```

在 daemon `.env` 同目录创建 `workspaces.json`：

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

标准 daemon 布局通常是：

```text
/home/YOUR_USER/.agentport/daemon/.env
/home/YOUR_USER/.agentport/daemon/workspaces.json
```

创建或修改文件后，需要重启 daemon。

## 环境变量配置方式

容器或托管部署可以使用内联 JSON：

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
DEFAULT_WORKSPACE=projects
WORKSPACE_ROOTS_JSON={"projects":"/home/YOUR_USER/workspace","openclaw":"/home/YOUR_USER/.openclaw"}
```

也可以显式指定配置文件：

```env
WORKSPACE_ROOTS_FILE=./workspaces.json
```

相对路径形式的 `WORKSPACE_ROOTS_FILE` 会以 daemon `.env` 所在目录为基准。

配置优先级如下：

1. 运行时 `/update-workspace` 覆盖；该接口会有意切换成单工作区模式；
2. `WORKSPACE_ROOTS_JSON`；
3. `WORKSPACE_ROOTS_FILE`；
4. 与当前 `.env` 同目录的 `workspaces.json`；
5. 旧版单根目录 `WORKSPACE_ROOT`。

## 路径写法

假设 `projects` 是默认工作区：

```text
content-analyzer/README.md
projects:/content-analyzer/README.md
workspace://projects/content-analyzer/README.md
openclaw:/workspace/AGENTS.md
workspace://openclaw/workspace/AGENTS.md
/home/YOUR_USER/.openclaw/workspace/AGENTS.md
```

普通相对路径会使用默认工作区。绝对路径保持兼容，并自动归属到包含该路径的已配置工作区。
非默认工作区的返回结果会保留命名式 `path`，同时返回 `relativePath`、`namedPath`
和 `workspace` 字段，避免后续调用因为只使用普通相对路径而错误回落到默认工作区。

项目配置也支持命名路径：

```json
{
  "projects": {
    "content-analyzer": {
      "server": "debian-main",
      "root": "projects:/content-analyzer",
      "defaultBranch": "main"
    }
  }
}
```

## 安全规则

- 工作区名称必须匹配 `[A-Za-z][A-Za-z0-9._-]{0,63}`；
- 单个 daemon 最多支持 32 个命名工作区；
- 规范化后重复或互相包含、重叠的根目录会被拒绝；
- `..` 不能离开当前选中的命名工作区；
- 一个工作区内的软链接不能跳到另一个工作区，也不能跳到未配置目录；
- 旧版普通相对路径仍然只属于默认工作区。

命名工作区是权限边界，不只是显示别名。选择 `projects:/...` 后，不能通过软链接访问
`openclaw:/...`。

## 从整个主目录权限迁移

修改前：

```env
WORKSPACE_ROOT=/home/YOUR_USER
```

修改后：

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
```

同时创建：

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

这样 `/home/YOUR_USER/.ssh`、`/home/YOUR_USER/.config` 和其他无关目录就不会进入
AgentPort 的文件访问与命令工作目录范围。

## 验证命令

```bash
npm run test:workspaces
npm run privacy:check
```
