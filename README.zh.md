# dsh-noagent-schedule

**零 token 定时脚本调度。** 到点由 DSH 宿主直接起子进程跑脚本，不唤醒模型、不消耗 token。

这是 DSH 生态里一直缺的那一格。
之所以要自己写，是因为 现有的定时插件（官方 `dsh-schedule` 与社区实现）全是「到点往会话投消息 / 开新会话」，
产出物是**唤醒模型**，不是**执行脚本**；没有任何一个能跳过模型。

## 为什么放在宿主里，而不是 launchd

| | launchd | 本插件 |
|---|---|---|
| TCC（受保护目录） | ❌ `git` 等工具可能读不了外接卷 | ✅ 用宿主身份，按应用已获授权执行 |
| 依赖外部运行时 | 需要自己的 venv / 脚本目录 | 不依赖 |
| 改任务 | 改 plist + `bootout`/`bootstrap` | 改 JSON，10 秒内生效 |
| 7×24 不依赖 GUI | ✅ | ❌ 只在 DSH 进程存活时跑 |

结论：**需要 7×24、与 DSH 无关的看门狗继续用 launchd；需要宿主 TCC 身份、或与 DSH 状态相关的，
放这里。**

## 安装

### 从插件市场（发现页）

在 **插件 > 发现 > 管理索引源** 里添加：

```
https://raw.githubusercontent.com/monkey-sking/dsh-noagent-schedule/main/index.json
```

然后插件会出现在发现列表里，带中文说明和图标，点安装即可。（发现标签需要先启用实验性的 plugin-market 组合包。）

### 从本地 checkout

```
git clone https://github.com/monkey-sking/dsh-noagent-schedule.git
plugin_manager({ action: "install_bundle", target: "<cloned directory>" })
```

装完在 profile 里新增一行 `noagent-schedule`。配置文件默认：

- 任务清单：`~/.dsh/noagent/jobs.json`
- 状态/日志：`~/.dsh/noagent/state/`

## 任务清单格式

```json
{
  "jobs": [
    {
      "id": "git-push-check",
      "name": "Git push 检查",
      "enabled": true,
      "cron": "30 18 * * *",
      "timeZone": "Asia/Shanghai",
      "cwd": "/srv/app",
      "command": "git status --porcelain",
      "timeoutSeconds": 120
    },
    {
      "id": "heartbeat",
      "name": "心跳",
      "enabled": true,
      "everySeconds": 300,
      "command": "date"
    }
  ]
}
```

字段：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，也是日志目录名 |
| `cron` | 五字段 Vixie cron：`分 时 日 月 周`；支持 `*/n`、`a-b`、`a-b/n`、逗号、`sun..sat`、`jan..dec` |
| `everySeconds` | 固定间隔（≥30 秒），与 `cron` 二选一 |
| `timeZone` | IANA 时区，默认 `Asia/Shanghai` |
| `cwd` | 工作目录，默认 `$HOME` |
| `command` | 交给 `/bin/bash -lc` 执行；也可改用 `argv` 数组直接起进程 |
| `env` | 追加环境变量 |
| `timeoutSeconds` | 超时强杀，默认 300 |

### 事件型任务（`wakeOnChange`）

`wakeOnChange` 让脚本输出充当指纹：只有冒出新内容时才把这段输出投进指定会话
（`sessionId`），其余时间完全零 token。

配合 `onlyOnNew` 可用 `keyPattern` 指定「什么算新条目」：正则匹配到的片段就是这行的
身份，匹配不到则退回整行。例如探针每行是 `UNKNOWN | 姓名 | 公司 | 时间 | 最后一条消息`，
用 `"keyPattern": "^[A-Z_]+ \\| [^|]+ \\| [^|]+"` 就只按「状态+姓名+公司」判新：
同一会话换了最后一条消息（包括我方刚回复）不会重复唤醒，只有冒出新会话才唤醒。

每次唤醒都以一次性任务投递，投递完成后
由插件自动清理（唤醒前清上一条 + 每 30 秒清理已投递的旧行），不会在
「自动化任务」列表里堆积同名「已结束 · 仅一次」记录；重启后第一次 tick 会顺带
清掉升级前遗留的历史唤醒行。

## 运行产物

```
~/.dsh/noagent/state/
├── state.json              # 每个任务最近一次：时间、退出码、耗时
├── runs.jsonl              # 每次运行一行 JSON
└── runs/<id>/<时间戳>.log   # 单次运行的完整 stdout / stderr
```

排查一次失败只要看对应 `.log`，不需要翻宿主日志。

## 在 App 里使用界面

插件带客户端半（`client.js`），装好并重启宿主后：

- **设置页**：设置 → 「定时脚本」；**侧边栏面板**：侧边栏的时钟图标，点开占据中央面板，
  两边都是同一页。
- 页面按青龙面板的「定时任务」组织（0.4.0 起）：
  - **总览卡**：任务总数、启用中、今日运行、近 24h 失败；点「启用中 / 失败」等于切筛选。
  - **工具条**：搜索（名称 / ID / 命令）、状态筛选（全部 / 启用 / 停用 / 异常）、刷新。
  - **任务表**：一行一个任务 —— 状态灯 + 名称 + 命令摘要、计划、上次 / 下次运行、最近 8 次结果。
  - **计划说人话**：`30 18 * * *` 显示成「每天 18:30」，`*/15 * * * *` 是「每 15 分钟」，
    `0 9 * * 1-5` 是「周一、周二…09:00」；cron 原文在悬停时给出，解析不了就标红并显示原文。
  - **上次 / 下次相对时间**：「3 分钟前」「今天 18:30」「明天 08:40」「11 天后 09:15」。
  - **最近几次结果**：一排小竖条，绿=成功、红=失败，点任意一条看那一次的日志。
  - **日志抽屉**：从右侧滑出，显示该次运行的完整 stdout/stderr，Esc 或点遮罩关闭。
  - **展开行编辑**：点名称或 ▾ 展开，可改名称、cron / 固定间隔、超时、命令；
    启停开关、立即运行、删除（二次确认）也在这里。

界面文案走 Client locale（`client.js` 里的 zh/en 字典，`ctx.locale.register`）；
`locale/*.json` 是包级元数据（插件清单里的标题/描述），两处都提供中文与英文。
样式只用宿主主题 token（`--dsw-alias-*`、`--dsw-radius-*`），不硬编码颜色。

### 数据通道与操作

同一份操作实现只写一次（`index.js` 里的 `operations.status/run/log`），两个调用方共用：

| 调用方 | 入口 |
|---|---|
| App 界面 | `POST /api/noagent.rpc`，body `{ op: "status" \| "run" \| "log" \| "toggle" \| "update" \| "delete", id?, wait?, limitBytes?, at? }` |
| agent 工具 | `noagent_status` / `noagent_run` / `noagent_log` / `noagent_update` |

界面上的写操作（启停、改计划、删除）都走同一份 `operations.updateJob/deleteJob`：
只覆盖被点的字段，`jobs.json` 里插件不认识的字段（`env`、`wakeOnChange`、自定义键）
原样保留；写前留一份 `jobs.json.bak-<时间戳>-<动作>`（保留最近 10 份）；
写后用同一个 `normalizeJobs` 复核，加载不了就拒绝落盘。

Web 入口用 `ctx.connection.fetch.register` 注册精确 Fetch 路由：Connection 的 `/api`
前缀处理器先做 Host/Origin 围栏与签名 Cookie 鉴权（未鉴权 401、跨站 403），再把请求交给
这条路由，因此插件不自己实现鉴权。浏览器侧用相对路径 `api/noagent.rpc` 请求，
带 mount 前缀的部署同样可用（与内置 `dsh-session-log-export` 的写法一致）。

## 边界（明确不做）

- **不补跑**：DSH 没运行期间错过的时点不会补。
- **不需要模型**：插件不 import 任何 LLM 服务；任务失败也不会叫醒 agent。
- **不碰投递**：结果只落盘。要推到手机/飞书，由一个 agent 型任务或投递脚本读 `runs.jsonl` 转发。

## 配套仓库

[agent-cron-kit](https://github.com/monkey-sking/agent-cron-kit) 是这个调度器要跑的那批脚本：
stdout→飞书/Telegram 投递桥、git 自动推送与脏仓库巡检、日志/备份清理、网络与桌面 App 看门狗，
外加一份「哪些脚本能公开、哪些永远不能」的分级审核。上面说的「不碰投递」由它的 `lib/deliver.py` 补齐。

## 测试

```bash
node --test test/cron.test.js test/host.test.js test/client.test.js
#   cron.test.js    9 个：cron 解析 / 时区 / apply 执行写状态写日志
#   host.test.js    5 个：状态合并、日志读取、路由与工具共用同一份实现
#   client.test.js  4 个：ModuleLoader 协议、槽位注册、字典、组件树可渲染
```

覆盖：cron 解析（步长/区间/列表/月份周缩写/周日归一/dom-dow 或语义）、时区换算、
任务校验、以及一次 apply 的完整执行→状态→日志写入；另加状态合并、日志读取、
以及「路由与工具共用同一份操作实现」的用例。

