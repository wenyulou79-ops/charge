# dsh-live-cost-meter

DeepSeek Harness 的**实时费用与余额**插件：精确显示官方 API 余额、每轮/每次对话的花费，并按官方**峰谷分时定价**显示当前是高峰还是平价、还有多久切换。

面向 **DeepSeek Harness 桌面版**（Electron），也适用于任何 web 载体 profile。

---

## 它显示什么

**侧边栏底部（余额行）**

```
¥12.58   平价   ·   ¥0                        137 小时 54 分后进入高峰
  ↑        ↑      ↑                                  ↑
官方余额  当前档位  今日花费                    距下一次价格切换的倒计时
```

- 余额 = 官方开放平台总额（赠金 + 充值），**每 60 秒自动刷新**，点击整行可立即刷新。
- 悬停可看赠金/充值拆分、今日花费、以及「高峰价是平价的 2 倍」提示。
- 侧边栏收起时自动降级为只显示余额。

**输入框下方（本轮费用）**

```
本轮 ¥0.0001 · 本会话 ¥0.0023
```

悬停可看本轮未命中输入 / 缓存命中 / 输出 token 明细，以及本会话累计。

**设置 → 费用与余额**

官方余额与拆分、今日花费、峰谷规则原文、当前时段与倒计时、余额读数时间、完整官方价格表、以及可编辑的法定节假日表。

---

## 计价口径（为什么数字可信）

全部金额按官方文档口径计算，并已对照官方 API 与本机 **2,878 条真实用量样本**实测。

| 项目 | 口径 |
| --- | --- |
| 缓存命中 | DSH 的 DeepSeek 适配器走 **Anthropic Messages** 协议（`https://api.deepseek.com/anthropic`）：`input_tokens` 只统计**未命中**前缀，`cache_read_input_tokens` 是**独立的另一桶**。适配器据此合成 `totalTokens = 输入 + 缓存读 + 缓存写 + 输出`，实测 **2878/2878** 条样本满足该恒等式。因此三个桶**各自按各自单价直接计价，绝不相减**（相减会把 98% 的 token 漏计）。 |
| 口径自动判别 | 若某个提供方改用 OpenAI 风格（`prompt_tokens` 已含缓存命中），`totalTokens` 会小于各桶之和；插件据此自动改为「输入 − 缓存命中」，缓存前缀仍然只计费一次。因此同一份代码在两种约定下都正确。 |
| reasoning token | 属于 output 的子集，按输出计价，**不另行加价** |
| cache write | 官方无对应价目，计 **0** |
| 档位判定 | 按**请求发起时刻**换算北京时间判定，而非完成时刻；跨峰谷的长流式请求因此不会整单错档 |
| 档位边界 | 09:00 / 14:00 起为高峰，12:00 / 18:00 起为平价（半开区间） |

价格表（元 / 百万 tokens，官方 [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)）：

| 模型 | 缓存命中 峰/谷 | 缓存未命中 峰/谷 | 输出 峰/谷 |
| --- | --- | --- | --- |
| `deepseek-flash` | 0.04 / 0.02 | 2 / 1 | 8 / 4 |
| `deepseek-v4-pro` | 0.30 / 0.15 | 9 / 4.5 | 27 / 13.5 |

**峰谷规则**：北京时间周一至周五（不含中国法定节假日）`09:00–12:00`、`14:00–18:00` 为高峰；其余时段——包括周末与中国法定节假日全天——均为平价。平价价 = 高峰价 ÷ 2。

旧模型名（`deepseek-v4-flash*`、`deepseek-chat`、`deepseek-reasoner`）按官方说明归到 Flash 价；Anthropic 兼容端点的 `claude-opus*` 归到 V4 Pro 价。无法识别的模型名回退 Flash 价（宁可高估，不漏计）。

> **一个反直觉但重要的细节**：真实流量里 `cacheReadTokens` **大于** `inputTokens` 是常态（本机 2818/2878 条如此）。这正是互斥桶的正常形态，绝不能据此认为「输入已含缓存」。

---

## 余额为什么「精准」

官方 `GET /user/balance` 是权威值，但有两个现实问题：查询有延迟，且金额只有 2 位小数。如果简单地用「上次官方值 − 此后累计费用」无限外推，舍入误差会**逐次累积**。

本插件改用**锚点重置**：

```
展示余额 = 最近一次官方读数 − (当前本地累计费用 − 该次读数时的本地累计费用)
```

每次刷新成功都把锚点重置为最新官方值，因此误差**永不累积**，只会回到官方真值；两次刷新之间用本地逐笔账本平滑外推。默认每 **30 秒**重新读数一次，所以偏差窗口最长只有约 30 秒的本地外推量。

### 三条保证读数不会「冻结」的机制

余额显示最容易出的故障不是精度，而是**读数悄悄停止更新**——界面还在显示一个由旧锚点推算的数字，看起来却像实时的。本插件对这条路径做了三重防护：

| 机制 | 作用 |
| --- | --- |
| **查询超时**（默认 12 秒） | 没有超时的话，一次网络悬挂会让 single-flight 永久占位，之后每次自动刷新都短路返回那个永不落地的 promise，余额就此冻结。超时保证请求一定落定。 |
| **占位兜底**（30 秒） | 万一底层因故没有按超时结束，超过 30 秒就放弃旧占位、允许下一次重试，绝不永久卡死。 |
| **机会式刷新** | 客户端每 30 秒轮询状态时顺带检查读数新鲜度，过期就补一次。这条路径**独立于定时器**，因此即使 `setInterval` 因事件循环退避或 fiber 重载失效，读数也不会长期不更新。 |

并且**陈旧是可见的**：读数超过 3 个刷新间隔未更新（或最近一次查询失败）时，侧边栏余额旁会出现 `≈` 标记，设置页显示「陈旧，显示值为本地外推」与读数年龄。

### 对账差额：差距的诚实解释

官方余额的下降量与本机账本的记录量未必相等——同一个 API Key 在别处（CLI、网页版、另一台机器）使用时，这部分花费本机**看不到**，显示值就会偏高。

插件为此做**显式对账**：每次重新读数时比较「官方下降了多少」与「本地同期记录了多少」，差额累计后在设置页显示为「对账差额」。这样差距有明确来源，而不是靠调参把数字凑上去。

> 注：官方余额只有 2 位小数，单次差值的量化噪声约 ±0.005 元；低于 0.01 元的正差额不累计，避免噪声堆积成假信号。

---

## 安装

插件是一个标准 DSH **组合包**（bundle）。三种装法，任选其一。

### 从 GitHub 安装（推荐，便于更新）

```powershell
dsh plugin --profile desktop add github:wenyulou79-ops/charge
```

建议锁 commit 以便复现（把 `#<sha>` 追在地址后面，`sha` 取自仓库的提交记录）：

```powershell
dsh plugin --profile desktop add github:wenyulou79-ops/charge#<commit sha>
```

不锁的话每次安装都会拉到最新 `main`，后续推送会改变你机器上实际运行的代码。

> 本插件是**纯 JavaScript、没有构建步骤**，所以 git 安装能直接用（TypeScript 插件会拿到没有 `lib/` 的源码而加载失败）。
> 它也没有 `build`/`prepare` 脚本，因此**不需要**在 profile 的 `pnpm-workspace.yaml` 里配置 `allowBuilds` 授权。

### 从 tarball 安装（离线可用）

从 Releases 下载 `dsh-live-cost-meter-<版本>.tgz`，然后：

```powershell
dsh plugin --profile desktop add "D:\下载目录\dsh-live-cost-meter-1.1.0.tgz"
```

### 本地目录安装

```powershell
dsh plugin --profile desktop add "D:\path\to\dsh-live-cost-meter"
```

### 安装后

**重启 DeepSeek Harness** 生效。卸载：

```powershell
dsh plugin --profile desktop remove dsh-live-cost-meter
```

> 桌面版的 profile 若由 Electron 独占管理、`dsh plugin` 被拒绝，可手动装：把包放进
> `$DSH_HOME\profiles\desktop\node_modules\`（推荐用链接而非复制），并把包名加进该 profile
> `package.json` 的 `dsh.profile.bundles` 与 `dependencies`（写成 `link:<绝对路径>`）。
>
> 本插件需要 `zod`。若目标 profile 里没有，pnpm 会自动装进该 profile。

---

## 配置（可选）

在 profile 的组合树里为 `cost-meter` 行加 `config:` 即可，全部字段可选：

```yaml
- id: cost-meter
  name: dsh-live-cost-meter
  config:
    # 追加/覆盖法定节假日（北京日期）。周末本来就全天平价，这里只需补周一至周五的节假日。
    holidays: ['2027-01-01', '2027-02-15']
    # 官方余额自动刷新间隔（毫秒，最小 5000，默认 30000）
    # 这个值直接决定显示值与官方真值能差多远：锚点越旧，外推偏差窗口越长。
    balanceRefreshMs: 30000
    # 余额端点缓存窗口（毫秒，最小 5000，默认 10000；会被钳到不超过刷新间隔的一半）
    balanceCacheMs: 10000
    # 单次余额查询超时（毫秒，最小 5000，默认 12000）
    # 没有超时会导致一次网络悬挂把自动刷新永久卡死。
    balanceTimeoutMs: 12000
    # 是否把本地账本落盘（默认 true，写到 $DSH_HOME/storages/dsh-live-cost-meter/ledger.json）
    persistLedger: true
    # 显示币种
    currency: CNY
    # 余额查询使用的凭据名：先查 DSH 凭据库，再回退同名环境变量
    apiKeyEnv: DEEPSEEK_API_KEY
    # 余额端点 baseURL（应保持官方域名）
    baseURL: https://api.deepseek.com
```

法定节假日也可以在**设置 → 费用与余额**里直接编辑保存，无需改配置文件。

---

## 隐私与网络

余额查询**只**请求 `{baseURL}/user/balance`（默认官方 `https://api.deepseek.com`），复用与模型请求同一把 API Key：优先从 DSH 凭据库解析，其次读同名环境变量。API Key **只会**发往配置的 baseURL，除此之外插件不发起任何网络请求，账本只写在本地。

---

## 架构

```
dsh-live-cost-meter/
├── package.json          # dsh.bundle 补丁声明 + dsh.client 浏览器声明
├── cordis.patch.yml      # 组合包补丁：向 profile 插入一条 cost-meter 行
├── lib/
│   ├── pricing.js        # 峰谷定价引擎（纯函数）：档位判定、倒计时、模型名归一、金额
│   ├── state.js          # 配置合并、本地账本、官方余额响应解析与「锚点 + 外推」余额模型
│   ├── projection.js     # costUsage 会话投影：在请求发起时刻逐轮计价
│   ├── typert.host.js    # ./typert：Host 面 Typert 清单（客户端 remote.costMeter.* 的契约）
│   ├── config.js         # 插件配置 schema
│   ├── index.js          # 宿主插件：llm/stream 计费包裹、余额轮询、costMeter 服务
│   └── client.js         # 浏览器单身 bundle：侧边栏余额行 / 输入框dock / 设置页
└── test/
    ├── _env.mjs                # 环境解析：不写死任何绝对路径，缺依赖时优雅跳过
    ├── verify.mjs              # 纯函数自检（定价、档位、模型名、余额解析）41 项
    ├── balance-resilience.mjs  # 查询超时 / 锚点外推 / 陈旧判定 / 对账 12 项
    ├── balance-tracking.mjs    # 端到端：官方余额下降时显示值必须跟随、悬挂后可恢复 7 项
    ├── verifier-*.mjs          # 对抗性测试：money / tier / projection / host / client / balance / reallog
    ├── projection.mjs          # 经真实投影注册表驱动 costUsage 单元 9 项
    ├── convention-lock.mjs     # 用真实会话日志锁定「桶互斥」口径，防止回归
    ├── integration.mjs         # 真实模型调用 → 账本落账端到端
    └── check-balance.mjs       # 真实官方余额查询（只输出数值，不输出密钥）
```

其中 `verifier-*` 是刻意写成**对抗性**的：它们假设实现有 bug 去找反例，
覆盖了金额边界、峰谷每一分钟、脏余额响应、投影折叠契约、宿主生命周期与客户端 bundle 契约。

数据通道：

- **逐笔金额**：宿主在 `llm/stream` 瀑布上包裹一次调用，以**请求发起时刻**判档后把 token 与金额写入本地账本；
- **逐轮明细**：宿主注册 `costUsage` 会话投影，客户端经槽位的 `useProjection` 读取；
- **余额与配置**：宿主 `costMeter` 服务经 Typert 网关暴露为 `remote.costMeter.*`，客户端轮询读取（页面隐藏时暂停，连接重置后立即补一次）。

---

## 开发与验证

只要一个 Node.js（>= 20）即可跑纯函数测试：

```bash
node --check lib/index.js            # 语法
node test/verify.mjs                 # 41 项：定价 / 档位 / 模型名 / 余额解析
node test/balance-resilience.mjs     # 12 项：查询超时 / 锚点 / 陈旧 / 对账
node test/balance-tracking.mjs       # 7 项：端到端余额跟随与悬挂恢复
```

需要真实 DSH 运行时或你账户数据的测试会自动跳过，需要时用环境变量打开：

```bash
# 真实投影注册表 / 真实模型调用：指向 DSH 包所在的 node_modules
export DSH_NODE_MODULES=/path/to/node_modules      # Windows: $env:DSH_NODE_MODULES="..."
node test/projection.mjs             # 9 项：经真实投影注册表驱动逐轮计价
node test/integration.mjs            # 1 次真实模型调用，检查账本落账
node test/convention-lock.mjs        # 用本机真实会话日志锁定互斥桶口径
node test/check-balance.mjs          # 真实官方余额查询（只输出数值，不输出密钥）
```

`convention-lock` 与 `check-balance` 分别需要 `$DSH_HOME/sessions` 下的会话日志和一把真实 API Key；
缺少时它们打印提示并跳过，不会失败。

> **回归护栏**
>
> - `test/convention-lock.mjs` 直接读 `$DSH_HOME/sessions` 下 zstd 多帧拼接的真实日志，断言
>   `totalTokens === inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` 且
>   「计费 token 数 == 上报 token 数」。任何再次引入「输入含缓存」假设（会把 98% 的 token 漏计）的改动都会被它拦住。
> - `test/balance-tracking.mjs` 用假 Cordis 上下文驱动真实 `apply()`，stub fetch 扮演官方端点，
>   断言「官方余额下降时显示值必须跟着下降」以及「一次悬挂请求之后刷新仍能恢复」。
>   任何让余额读数重新冻结的改动都会被它拦住。

---

## 已知限制

- **账本自插件加载起累计**：本地账本记录的是本次进程观察到的调用；重启后「自插件启动累计」重新开始，但**余额始终来自官方读数**，因此重启不会影响余额准确性。
- **「今日花费」同样自加载起算**：要精确统计跨重启的当日总额需要回放历史会话日志；本插件不做重度日志回放，以免影响启动与性能。
- **同一个 API Key 在别处使用会让显示值偏高**：本进程看不到别处的调用。插件会把这类差额算出来显示为「对账差额」，但它无法凭空知道那部分花费，只能在下一次官方读数时被锚点重置吸收。
- **官方余额只有 2 位小数**：锚点本身带有约 ±0.005 元的量化误差，因此显示值与官方值的正常残差在 0.01 元量级，不可能是 0。
- **计费与官方结算可能存在极小差异**：官方对单次请求的舍入规则未公开，且 KV 缓存命中为尽力而为，因此界面金额是**逐 token 精确计算**的结果，但官方账单可能在此基础上做服务端舍入/聚合；**余额始终是官方真值**。
- **法定节假日表需随国务院公告更新**：默认表预置 2026 年，之后的年份请在设置页或配置里补 `holidays`（周末无需填写）。
- 12:00 / 18:00 的边界归属官方文档未明示，本插件采用半开区间；影响上限只有一瞬间的 token。
