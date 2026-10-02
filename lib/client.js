/**
 * dsh-live-cost-meter —— 浏览器半（客户端 bundle）。
 *
 * 手工编写的惰性 CJS bundle，形态与官方 tsdown 产物一致：
 *   window.__ModuleLoader__.load({ id: <包名>, factory(require) { …; return exports } })
 * 只有 `react` 与 `react/jsx-runtime` 是从外壳模块表 seed 出来的，其余一切
 * 数据都经 `ctx.remote.costMeter.*`（Typert 网关 RPC）从本插件的宿主半取。
 *
 * 界面遵循 DSH 设计变量（--dsw-* / --dsh-*），不硬编码颜色，因此自动适配深浅色。
 */

window.__ModuleLoader__.load({
  id: 'dsh-live-cost-meter',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ── 平台 seed 解析（任一缺失都优雅降级为「隐形但无害」） ──────────────────
    let React = null
    try {
      React = require('react')
    } catch {
      React = null
    }
    if (React === null) {
      exports.apply = () => {}
      exports.inject = []
      return module.exports
    }
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    // ── 样式（插件自持，随 fiber 卸载回收） ──────────────────────────────────
    const CSS = `
.dcm-root{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);box-sizing:border-box}
.dcm-foot{display:flex;align-items:center;gap:6px;width:100%;height:30px;padding:0 8px;border-radius:8px;cursor:pointer;overflow:hidden;white-space:nowrap}
.dcm-foot:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcm-foot-rail{justify-content:center;padding:0}
.dcm-num{font-variant-numeric:tabular-nums}
.dcm-bal{color:var(--dsw-alias-label-primary);font-weight:600}
.dcm-tag{display:inline-flex;align-items:center;gap:3px;flex:none;height:18px;padding:0 6px;border-radius:5px;font-size:11px;font-weight:600}
.dcm-tag-peak{background:var(--dsw-alias-state-warn-tertiary,#fdf0e3);color:var(--dsw-alias-state-warn-primary,#b25e09)}
.dcm-tag-off{background:var(--dsw-alias-state-success-tertiary,#e8f5ee);color:var(--dsw-alias-state-success-primary,#12794a)}
.dcm-split{flex:none;color:var(--dsw-alias-label-dimmed);opacity:.6}
.dcm-count{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dcm-spacer{flex:1 1 auto;min-width:0}
.dcm-panel{margin:0 8px 8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px}
.dcm-row{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
.dcm-row-k{color:var(--dsw-alias-label-tertiary);flex:none}
.dcm-row-v{color:var(--dsw-alias-label-primary);font-weight:600;text-align:right}
.dcm-bar{height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;display:flex}
.dcm-bar-a{height:100%;background:var(--dsw-static-deepseek-500,#4d6bfe)}
.dcm-bar-b{height:100%;background:var(--dsw-static-amber-400,#f5a623)}
.dcm-head{display:flex;align-items:center;gap:8px}
.dcm-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dcm-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.dcm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dcm-card{padding:8px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}
.dcm-card-k{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dcm-card-v{color:var(--dsw-alias-label-primary);font-weight:600;font-size:14px;font-variant-numeric:tabular-nums}
.dcm-btn{height:26px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-tool-bar-fill,transparent);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.dcm-btn:hover{background:var(--dsw-alias-button-tool-bar-hover)}
.dcm-btn:disabled{opacity:.5;cursor:default}
.dcm-err{color:var(--dsw-alias-state-error-primary);font-size:11px}
.dcm-dock{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.dcm-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.dcm-table th,.dcm-table td{padding:3px 6px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dcm-table th:first-child,.dcm-table td:first-child{text-align:left}
.dcm-table th{color:var(--dsw-alias-label-tertiary);font-weight:500}
`
    let removeCss = null
    try {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-live-cost-meter'
      style.textContent = CSS
      document.head.appendChild(style)
      removeCss = () => style.remove()
    } catch {
      removeCss = null
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    /** 金额格式化：小于 0.01 元保留 4 位小数，避免「¥0.00」看不出花费。 */
    const money = (value) => {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (n === 0) return '¥0'
      if (Math.abs(n) < 0.01) return `¥${n.toFixed(4)}`
      if (Math.abs(n) < 1) return `¥${n.toFixed(3)}`
      return `¥${n.toFixed(2)}`
    }
    /** 余额始终按官方 2 位小数显示（官方金额字符串就是 2 位）。 */
    const balanceText = (value) => `¥${(typeof value === 'number' && Number.isFinite(value) ? value : 0).toFixed(2)}`
    const tierLabel = (tier) => (tier === 'peak' ? '高峰' : '平价')
    /** 把剩余分钟格式化为「138 小时 34 分」风格。 */
    const countdown = (minutes) => {
      const value = Number(minutes)
      if (!Number.isFinite(value)) return '—'
      const total = Math.max(0, Math.round(value))
      const hours = Math.floor(total / 60)
      const rest = total % 60
      if (hours <= 0) return `${rest} 分`
      if (rest === 0) return `${hours} 小时`
      return `${hours} 小时 ${rest} 分`
    }
    /**
     * 距下一次价格切换的文案。
     * 宿主在极端自定义节假日表下可能报告「切换时刻未知」，此时显示「—」。
     * @param {object} tier - tier 视图。
     * @param {number} now - 当前毫秒时间戳。
     * @returns {{ text: string, nextLabel: string }} 倒计时文案与目标档位文案。
     */
    const untilText = (tier, now) => {
      const nextLabel = tier.nextTier === 'peak' ? '进入高峰' : '转入平价'
      if (tier.transitionKnown === false) return { text: '—', nextLabel }
      return { text: `${countdown(Math.max(0, tier.untilMs - now) / 60000)}后${nextLabel}`, nextLabel }
    }
    const tokens = (value) => {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
      return String(n)
    }

    /**
     * zod 风格的最小 codec（只用于检查远端返回值形状，不做完整实现）。
     * @param {string} name - 类型符号。
     * @returns {object} strict codec。
     */
    const codec = (name) => ({
      mode: 'strict',
      typeSymbol: `dsh-live-cost-meter#${name}`,
      // 远端已由宿主侧 strict codec 校验过，这里只需放行。
      create: () => ({ parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) }),
    })

    /**
     * 客户端本地的 descriptor 清单（与宿主 `./typert` 的 TYPERT 一一对应）。
     *
     * 远端已经过宿主侧 strict codec 校验，因此这里的 codec 只做放行；
     * 每个 descriptor 必须自带完整的 `id / service / namespace / invocation`。
     * @param {string} method - 方法名。
     * @param {Array} parameters - 位置参数描述。
     * @param {string} resultType - 返回值类型符号。
     * @returns {object} descriptor。
     */
    const descriptor = (method, parameters, resultType) => ({
      id: `dsh-live-cost-meter#costMeter/${method}`,
      service: 'costMeter',
      namespace: 'costMeter',
      method,
      invocation: { kind: 'direct' },
      parameters,
      result: codec(resultType),
    })

    const DESCRIPTORS = {
      package: 'dsh-live-cost-meter',
      descriptors: [
        descriptor('getState', [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: codec('SessionIdArg'), acceptsUndefined: true }], 'CostState'),
        descriptor('refreshBalance', [], 'CostState'),
        descriptor('updateConfig', [{ name: 'patch', wire: 'patch', source: 'json', codec: codec('ConfigPatch') }], 'CostState'),
        descriptor('resetLedger', [], 'ActionResult'),
      ],
    }

    /**
     * 订阅式状态源：极小的 observable，配合 slot 的 `hooks` 注入面
     * 让渲染层拿到 `useCost(selector)`。
     * @param {object} initial - 初始快照。
     * @returns {object} 状态源。
     */
    const createStore = (initial) => {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: (next) => {
          if (next === snapshot) return
          snapshot = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              // 单个订阅者异常不影响其他订阅者。
            }
          }
        },
      }
    }

    const inject = ['slots', 'remote']

    /**
     * 客户端插件主体。
     * @param {object} ctx - 客户端 Cordis 根上下文。
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      const remote = ctx.get('remote')

      const store = createStore({ status: 'loading', error: null, state: null })
      const patch = (next) => store.set({ ...store.getSnapshot(), ...next })

      // 客户端本地也需要「档位倒计时」每秒刷新：宿主快照里的 untilMs 是绝对时刻。
      const tickStore = createStore({ now: Date.now() })

      /** 远端命名空间（挂载后可用）。 */
      let namespace = null

      /**
       * 取 Typert 远端命名空间。首次调用时把本包的 descriptor 清单挂上去，
       * `$mount` 重复调用是幂等的，因此多标签页/重连都安全。
       */
      const ensureNamespace = async () => {
        if (namespace !== null) return namespace
        if (remote !== undefined && typeof remote.$mount === 'function') {
          try {
            const dispose = await remote.$mount(DESCRIPTORS)
            // 命名空间的拆除挂在插件 fiber 上；这里只需保证不重复挂载。
            ctx.effect(() => () => {
              try {
                dispose()
              } catch {
                // 宿主已拆除时忽略。
              }
            }, 'cost-meter: remote contribution')
          } catch (error) {
            patch({ status: 'error', error: `远端挂载失败：${String(error && error.message ? error.message : error)}` })
            return null
          }
        }
        const found = ctx.get('remote.costMeter')
        if (found === undefined) {
          // 宿主 half 可能尚未把命名空间挂上：保留 loading 让轮询重试，同时记下
          // 实际可见的 remote 命名空间，便于诊断（不刷控制台）。
          patch({ status: 'loading', error: '宿主尚未提供 costMeter 命名空间' })
          return null
        }
        namespace = found
        return namespace
      }

      /**
       * 调用远端方法并解开 `{ok, value}` 包装。
       * @param {string} method - 方法名。
       * @param {Array} args - 位置参数。
       * @returns {Promise<object>} 结果值。
       */
      const call = async (method, args = []) => {
        const api = await ensureNamespace()
        if (api === null) throw new Error('宿主未提供 costMeter 命名空间')
        const raw = await api[method](...args)
        if (raw === null || typeof raw !== 'object') throw new Error(`调用 ${method} 返回了非对象结果`)
        if (raw.ok !== true) throw new Error(raw?.error?.message ?? `调用 ${method} 失败`)
        return raw.value
      }

      /** 当前会话 id（由 slot 渲染时上报）。 */
      let activeSessionId = null
      const setSession = (sessionId) => {
        if (typeof sessionId === 'string' && sessionId.length > 0) activeSessionId = sessionId
      }

      /** 拉取一次宿主快照。 */
      const refresh = async () => {
        try {
          const value = await call('getState', [activeSessionId])
          patch({ status: 'ready', error: null, state: value })
        } catch (error) {
          const message = String(error && error.message ? error.message : error)
          // 首个快照可能在宿主 half 尚未就绪时到达：保留 loading 状态让轮询重试，
          // 只有已经成功过一次之后才降级为错误态，避免启动竞争导致面板永久卡住。
          const wasReady = store.getSnapshot().state !== null
          patch(wasReady ? { error: message } : { status: 'loading', error: message })
        }
      }

      /** 强制刷新官方余额。 */
      const refreshBalance = async () => {
        try {
          const value = await call('refreshBalance')
          patch({ status: 'ready', error: null, state: value })
        } catch (error) {
          patch({ status: 'error', error: String(error && error.message ? error.message : error) })
        }
      }

      // 初始拉取 + 30 秒轮询（页面隐藏时暂停，避免无谓流量）。
      void refresh()
      ctx.effect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          void refresh()
        }, 30_000)
        return () => clearInterval(timer)
      }, 'cost-meter: state poll')

      // 每秒推进本地时钟，驱动倒计时重绘。
      ctx.effect(() => {
        const timer = setInterval(() => tickStore.set({ now: Date.now() }), 1_000)
        return () => clearInterval(timer)
      }, 'cost-meter: clock')

      // 连接重置后立刻补一次，避免显示陈旧余额。
      ctx.on('connection/reset', () => {
        void refresh()
      })

      // ── 组件 ──────────────────────────────────────────────────────────────
      /**
       * 订阅注入面提供的 store。
       *
       * 槽位的 `inject()` 返回 `{ hooks: { cost: <store> } }` 时，渲染层会把它绑定成
       * `useCost(selector)`（store 必须是 `{ getSnapshot, subscribe }` 形状，而不是
       * 自定义 hook）。这里做一次防御性回退，任何异常都不至于让组件崩掉。
       * @param {Function | undefined} hook - 注入的 hook。
       * @param {object} store - 回退用的 store。
       * @param {Function} [selector] - 选择器。
       * @returns {object} 选中的快照。
       */
      const useSource = (hook, store, selector) => {
        const fallback = selector ?? ((value) => value)
        if (typeof hook !== 'function') return fallback(store.getSnapshot())
        try {
          return hook(fallback)
        } catch {
          return fallback(store.getSnapshot())
        }
      }

      /** 侧边栏余额行：余额 + 档位徽标 + 距切换倒计时。 */
      const SidebarRow = (props) => {
        const snapshot = useSource(props.useCost, store)
        const tick = useSource(props.useClock, tickStore)
        const wide = props.wide !== false
        useEffect(() => {
          setSession(props.sessionId)
        }, [props.sessionId])
        if (snapshot.state === null) {
          return h('div', { className: 'dcm-root dcm-foot' + (wide ? '' : ' dcm-foot-rail') },
            h('span', { className: 'dcm-bal' }, snapshot.status === 'error' ? '费用面板不可用' : '余额 …'))
        }
        const state = snapshot.state
        const tier = state.tier
        const until = untilText(tier, tick.now)
        const nextLabel = until.nextLabel
        const balanceValue = state.balance === null ? null : state.balance.total
        const balanceStale = state.balance !== null && state.balance.stale === true
        const balanceAge = state.balance !== null && Number.isFinite(state.balance.ageMs)
          ? Math.round(state.balance.ageMs / 1000)
          : null
        const balanceTitle = state.balance === null
          ? '余额未知'
          : `总余额 ${balanceText(balanceValue)}（赠金 ${balanceText(state.balance.granted)} + 充值 ${balanceText(state.balance.toppedUp)}）`
            + (balanceAge === null ? '' : `\n读数取自 ${balanceAge} 秒前`)
        if (!wide) {
          return h('div', {
            className: 'dcm-root dcm-foot dcm-foot-rail',
            title: `${balanceTitle} · ${tierLabel(tier.tier)} · ${until.text}`,
            onClick: () => { void refreshBalance() },
          }, h('span', { className: 'dcm-bal dcm-num' }, balanceValue === null ? '—' : balanceText(balanceValue)))
        }
        return h('div', {
          className: 'dcm-root dcm-foot',
          title: [
            balanceTitle,
            balanceStale ? '⚠ 读数已陈旧：显示值由本地账本外推，可能已偏离官方余额（点击重试刷新）' : '',
            state.balanceAvailable === false ? '⚠ 官方返回 is_available=false：账户当前不可调用，余额可能仍大于 0' : '',
            state.unobservedSpend > 0.01 ? `⚠ 检测到本机未观察到的花费 ${money(state.unobservedSpend)}（同一个 API Key 可能在别处使用）` : '',
            `当前${tierLabel(tier.tier)}${tier.reason === 'holiday' ? '（法定节假日全天谷价）' : tier.reason === 'weekend' ? '（周末全天谷价）' : ''}`,
            tier.tier === 'peak' ? '高峰价为平价的 2 倍' : '平价时段，高峰的 5 折',
            `今日 ${money(state.todayCost)}`,
            '点击刷新余额',
          ].filter(Boolean).join('\n'),
          onClick: () => { void refreshBalance() },
        },
          h('span', { className: 'dcm-bal dcm-num' }, balanceValue === null ? '—' : balanceText(balanceValue)),
          balanceStale ? h('span', { className: 'dcm-tag dcm-tag-peak', title: '读数陈旧，显示值为本地外推' }, '≈') : null,
          state.balanceAvailable === false ? h('span', { className: 'dcm-tag dcm-tag-peak' }, '不可用') : null,
          h('span', { className: 'dcm-tag ' + (tier.tier === 'peak' ? 'dcm-tag-peak' : 'dcm-tag-off') }, tierLabel(tier.tier)),
          h('span', { className: 'dcm-split' }, '·'),
          h('span', { className: 'dcm-num' }, money(state.todayCost)),
          h('span', { className: 'dcm-spacer' }),
          h('span', { className: 'dcm-count dcm-num' }, until.text),
        )
      }

      /** 输入框下方：本会话最近一轮的花费与 token。 */
      const TurnDock = (props) => {
        const snapshot = useSource(props.useCost, store)
        const state = snapshot.state
        // 会话 id 在 effect 里登记（渲染期不产生副作用）；随后的 30 秒轮询会带上它。
        useEffect(() => {
          setSession(props.sessionId)
        }, [props.sessionId])
        // 优先用宿主推送的逐轮明细；缺失时退回会话累计。
        const session = state?.session ?? null
        const last = session?.turns != null && session.turns.length > 0 ? session.turns[session.turns.length - 1] : null
        const cost = last !== null ? last.cost : (session?.lastTurnCost ?? 0)
        const calls = last !== null ? last.calls : session?.calls ?? 0
        const buckets = last !== null ? last.buckets : session?.buckets ?? null
        const title = [
          `本轮（第 ${last !== null ? last.turn + 1 : '—'} 轮）：${calls} 次调用 · ${money(cost)}`,
          buckets === null ? '' : `未命中输入 ${tokens(buckets.uncachedInputTokens)} · 缓存命中 ${tokens(buckets.cacheReadTokens)} · 输出 ${tokens(buckets.outputTokens)}`,
          `本会话累计 ${money(session?.cost ?? 0)}（${session?.calls ?? 0} 次调用）`,
          last !== null && last.tiers.length > 1 ? '本轮跨越了峰谷时段，金额已分别计入' : '',
        ].filter(Boolean).join('\n')
        return h('div', { className: 'dcm-root dcm-dock', title },
          h('span', null, '本轮'),
          h('span', { className: 'dcm-bal dcm-num' }, money(cost)),
          h('span', { className: 'dcm-split' }, '·'),
          h('span', { className: 'dcm-num' }, `本会话 ${money(session?.cost ?? 0)}`),
        )
      }

      /** 设置页：峰谷时段、余额、价格表与配置。 */
      const SettingsSection = (props) => {
        const snapshot = useSource(props.useCost, store)
        const tick = useSource(props.useClock, tickStore)
        const [busy, setBusy] = useState(false)
        const [holidayText, setHolidayText] = useState(null)
        const mounted = useRef(false)
        useEffect(() => {
          mounted.current = true
          return () => { mounted.current = false }
        }, [])
        if (snapshot.state === null) {
          // 首次快照尚未到达：把宿主/RPC 的原因显示出来，并提供重试，
          // 而不是永远停在「正在读取费用数据…」。
          const hint = snapshot.error ?? '正在读取费用数据…'
          return h('div', { className: 'dcm-root dcm-panel' },
            h('div', { className: 'dcm-head' },
              h('span', { className: 'dcm-title' }, '费用与余额'),
              h('span', { className: 'dcm-spacer' }),
              h('button', {
                className: 'dcm-btn',
                disabled: busy,
                onClick: async () => {
                  setBusy(true)
                  await refresh()
                  if (mounted.current) setBusy(false)
                },
              }, busy ? '读取中…' : '重试'),
            ),
            h('div', { className: snapshot.status === 'error' ? 'dcm-err' : 'dcm-note' }, hint),
          )
        }
        const state = snapshot.state
        const tier = state.tier
        const until = untilText(tier, tick.now)
        const remaining = Math.max(0, tier.untilMs - tick.now) / 60000
        const balance = state.balance
        const usedRatio = balance === null || balance.total + balance.estSpendSince <= 0
          ? 0
          : Math.min(1, balance.estSpendSince / (balance.total + balance.estSpendSince))
        const editableHolidays = holidayText === null ? (state.config.holidays ?? []).join('\n') : holidayText
        const saveHolidays = async () => {
          setBusy(true)
          try {
            const holidays = editableHolidays.split(/[\s,;，；]+/).map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
            const value = await call('updateConfig', [{ holidays }])
            patch({ status: 'ready', error: null, state: value })
            setHolidayText(null)
          } catch (error) {
            patch({ error: String(error && error.message ? error.message : error) })
          } finally {
            if (mounted.current) setBusy(false)
          }
        }
        return h('div', { className: 'dcm-root dcm-panel' },
          h('div', { className: 'dcm-head' },
            h('span', { className: 'dcm-title' }, '费用与余额'),
            h('span', { className: 'dcm-tag ' + (tier.tier === 'peak' ? 'dcm-tag-peak' : 'dcm-tag-off') }, tierLabel(tier.tier)),
            h('span', { className: 'dcm-count' }, until.text),
            h('span', { className: 'dcm-spacer' }),
            h('button', {
              className: 'dcm-btn',
              disabled: busy,
              onClick: async () => {
                setBusy(true)
                await refreshBalance()
                if (mounted.current) setBusy(false)
              },
            }, busy ? '刷新中…' : '刷新余额'),
          ),
          h('div', { className: 'dcm-grid' },
            h('div', { className: 'dcm-card' },
              h('div', { className: 'dcm-card-k' }, '官方余额'),
              h('div', { className: 'dcm-card-v' }, balance === null ? '未知' : balanceText(balance.total)),
              balance === null ? null : h('div', { className: 'dcm-note' }, `赠金 ${balanceText(balance.granted)} · 充值 ${balanceText(balance.toppedUp)}${balance.estSpendSince > 0 ? ` · 读数后已用 ${money(balance.estSpendSince)}` : ''}`),
            ),
            h('div', { className: 'dcm-card' },
              h('div', { className: 'dcm-card-k' }, '今日花费（北京日期）'),
              h('div', { className: 'dcm-card-v' }, money(state.todayCost)),
              h('div', { className: 'dcm-note' }, `${state.today} · 自插件启动累计 ${money(state.processCost)}`),
            ),
          ),
          balance !== null && usedRatio > 0
            ? h('div', { className: 'dcm-bar', title: `读数后已用 ${money(balance.estSpendSince)}` },
              h('div', { className: 'dcm-bar-b', style: { width: `${Math.max(1, Math.min(100, usedRatio * 100))}%` } }))
            : null,
          h('div', { className: 'dcm-row' },
            h('span', { className: 'dcm-row-k' }, '峰谷规则'),
            h('span', { className: 'dcm-row-v' }, '周一至周五 09:00–12:00、14:00–18:00 高峰；周末与法定节假日全天平价'),
          ),
          h('div', { className: 'dcm-row' },
            h('span', { className: 'dcm-row-k' }, '当前时段'),
            h('span', { className: 'dcm-row-v' }, `${tierLabel(tier.tier)}${tier.reason === 'holiday' ? ' · 法定节假日' : tier.reason === 'weekend' ? ' · 周末' : ''} · ${until.text}`),
          ),
          h('div', { className: 'dcm-row' },
            h('span', { className: 'dcm-row-k' }, '余额读数'),
            h('span', { className: 'dcm-row-v' }, balance === null
              ? '尚未取到'
              : `${new Date(balance.at).toLocaleTimeString()}`
                + (Number.isFinite(balance.ageMs) ? `（${Math.round(balance.ageMs / 1000)} 秒前）` : '')
                + (balance.stale ? ' · 陈旧，显示值为本地外推' : '')),
          ),
          h('div', { className: 'dcm-row' },
            h('span', { className: 'dcm-row-k' }, '对账差额'),
            h('span', { className: 'dcm-row-v' }, state.unobservedSpend > 0.01
              ? `${money(state.unobservedSpend)} 本机未观察到`
              : '无（本地账本与官方下降一致）'),
          ),
          state.reconcile !== null && state.reconcile !== undefined
            ? h('div', { className: 'dcm-note' }, `上次对账：官方下降 ${money(state.reconcile.observedDrop)}，本地记录 ${money(state.reconcile.ledgerDelta)}，差额 ${money(state.reconcile.drift)}`)
            : null,
          state.unobservedSpend > 0.01
            ? h('div', { className: 'dcm-note' }, '差额来自本进程看不到的调用（例如同一个 API Key 在 CLI、网页版或另一台机器上使用）。这部分花费会让显示余额高于官方真值，直到下一次读数把锚点重置。')
            : null,
          state.balanceError !== null ? h('div', { className: 'dcm-err' }, `余额查询：${state.balanceError}`) : null,
          snapshot.error !== null ? h('div', { className: 'dcm-err' }, snapshot.error) : null,
          h('div', { className: 'dcm-title', style: { marginTop: '4px' } }, '官方价格（元 / 百万 tokens）'),
          h('table', { className: 'dcm-table' },
            h('thead', null, h('tr', null,
              h('th', null, '模型'), h('th', null, '档位'),
              h('th', null, '缓存命中'), h('th', null, '缓存未命中'), h('th', null, '输出'),
            )),
            h('tbody', null, ...state.prices.flatMap((row) => [
              h('tr', { key: `${row.model}-peak` }, h('td', null, row.model), h('td', null, '高峰'),
                h('td', null, row.peak.cacheHit), h('td', null, row.peak.cacheMiss), h('td', null, row.peak.output)),
              h('tr', { key: `${row.model}-off` }, h('td', null, ''), h('td', null, '平价'),
                h('td', null, row.offPeak.cacheHit), h('td', null, row.offPeak.cacheMiss), h('td', null, row.offPeak.output)),
            ])),
          ),
          h('div', { className: 'dcm-note' }, '计价口径：DSH 的 DeepSeek 适配器走 Anthropic Messages 协议，input_tokens 只统计未命中前缀，cache_read_input_tokens 是另一桶（二者互不重叠），因此各桶按各自单价直接计价；DSH 同时合成 totalTokens = 输入 + 缓存读 + 缓存写 + 输出，插件据此自动判别口径，遇到「输入已含缓存」的提供方时改做减法，缓存前缀绝不重复计费。reasoning token 属输出子集，不另行加价。'),
          h('div', { className: 'dcm-title', style: { marginTop: '4px' } }, '追加法定节假日'),
          h('div', { className: 'dcm-note' }, '每行一个北京日期（YYYY-MM-DD）。周末已自动全天平价，这里只需补周一至周五的节假日。'),
          h('textarea', {
            className: 'dcm-btn',
            style: { width: '100%', height: '72px', padding: '6px', fontFamily: 'var(--ds-font-family-code,monospace)', lineHeight: '18px' },
            value: editableHolidays,
            spellCheck: false,
            onChange: (event) => setHolidayText(event.target.value),
          }),
          h('div', { className: 'dcm-row' },
            h('span', { className: 'dcm-note' }, `${state.config.apiKeyEnv} · ${state.config.baseURL}`),
            h('button', { className: 'dcm-btn', disabled: busy, onClick: saveHolidays }, busy ? '保存中…' : '保存节假日'),
          ),
        )
      }

      // ── 注册到槽位 ────────────────────────────────────────────────────────
      /** 注入面：把状态源投影成渲染层可用的 `useCost(selector)`。 */
      const injectFace = () => ({ hooks: { cost: store, clock: tickStore }, api: { refresh, refreshBalance } })

      const disposers = []
      const register = (key, spec, Component) => {
        const dispose = slots.inject(key, () => {
          const disposeEntry = slots.register(spec, Component)
          return () => {
            try {
              disposeEntry()
            } catch {
              // 槽位已拆除时忽略。
            }
          }
        })
        disposers.push(dispose)
      }

      register('sidebar.footer.action', {
        name: 'sidebar.footer.action',
        id: 'cost-meter-balance',
        order: 0,
        inject: injectFace,
      }, SidebarRow)

      register('conversation.composer.dock', {
        name: 'conversation.composer.dock',
        id: 'cost-meter-turn',
        order: 6,
        inject: injectFace,
      }, TurnDock)

      register('settings.section', {
        name: 'settings.section',
        id: 'cost-meter',
        order: 30,
        label: '费用与余额',
        inject: injectFace,
      }, SettingsSection)

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 卸载期间槽位可能已先拆除。
          }
        }
        if (removeCss !== null) removeCss()
      }, 'cost-meter: client teardown')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
