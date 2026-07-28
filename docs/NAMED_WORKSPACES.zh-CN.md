# 命名式多工作区

AgentPort 可以同时授权多个彼此独立的目录，而不必把 `WORKSPACE_ROOT`
扩大到整个用户主目录。

## 推荐配置

在 daemon 的 `.env` 中保留默认工作目录：

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
```

在 `.env` 同一目录创建 `workspaces.json`：

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

标准部署一般对应：

```text
/home/YOUR_USER/.agentport/daemon/.env
/home/YOUR_USER/.agentport/daemon/workspaces.json
```

创建或修改后重启 AgentPort daemon。

## 其他配置方式

容器或托管环境可以直接使用环境变量：

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
DEFAULT_WORKSPACE=projects
WORKSPACE_ROOTS_JSON={"projects":"/home/YOUR_USER/workspace","openclaw":"/home/YOUR_USER/.openclaw"}
```

也可以指定独立文件：

```env
WORKSPACE_ROOTS_FILE=./workspaces.json
```

相对路径会以 daemon `.env` 所在目录为基准解析。

配置优先级如下：

1. `/update-workspace` 运行时覆盖；该操作会有意切换回单工作区；
2. `WORKSPACE_ROOTS_JSON`；
3. `WORKSPACE_ROOTS_FILE`；
4. `.env` 同目录的 `workspaces.json`；
5. 旧版单目录 `WORKSPACE_ROOT`。

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

相对路径自动进入默认工作区；原有绝对路径仍然兼容，并会自动匹配包含该路径的、最具体的命名根目录。

项目配置也可以直接使用命名路径：

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

## 安全边界

- 工作区名称必须符合 `[A-Za-z][A-Za-z0-9._-]{0,63}`；
- 一个 daemon 最多配置 32 个命名根目录；
- 不允许两个名称指向同一个规范化目录；
- `..` 不能越过当前选中的命名工作区；
- 一个工作区里的软链接不能跳到另一个工作区，也不能跳到未授权目录；
- 旧版相对路径仍然只落在默认工作区。

命名工作区是实际权限边界，不只是显示别名。访问 `projects:/...` 时，不能借助软链接进入 `openclaw:/...`。

## 从整个主目录权限迁移

修改前：

```env
WORKSPACE_ROOT=/home/YOUR_USER
```

修改后：

```env
WORKSPACE_ROOT=/home/YOUR_USER/workspace
```

并增加：

```json
{
  "default": "projects",
  "roots": {
    "projects": "/home/YOUR_USER/workspace",
    "openclaw": "/home/YOUR_USER/.openclaw"
  }
}
```

这样 `/home/YOUR_USER/.ssh`、`/home/YOUR_USER/.config` 和其他无关目录仍在 AgentPort 权限之外。

## 验证

```bash
npm run test:workspaces
npm run privacy:check
```
