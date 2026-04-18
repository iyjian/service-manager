# UI 重构方案 v2（已实施）

风格目标：Vercel / Railway / K8s Dashboard 的共性 —
**中性灰 + 1px 描边 + 无卡片阴影 + 紧凑密度 + 克制的单一强调色（Vercel 黑）**。

决策基线：
- 强调色 = **Vercel 黑** `#0a0a0a`
- 基础字号 = **13px**
- 圆角 = **4 / 6 / 8**

实施范围：`src/renderer/styles.css`（`index.html` 未改动）。

每条按 **设计要求 / 现状** 记录。

---

## 1. Token 系统重写

### 设计要求
抛弃 `--color-primary-*`（cyan）和 `--color-text-*` / `--color-border-default` 等带 bootstrap 味道的命名。建立中性灰阶 + 单一强调色 + 功能色的 3 层结构，旧名保留为 alias 不破坏现有 class 使用。

### 现状
`:root` 被重写为四组：
- **Surface**：`--color-bg-page: #fafafa` / `--color-bg-surface: #fff` / `--color-bg-subtle / --color-bg-hover: #f4f4f5`
- **Border**：`--color-border: #e4e4e7` / `--color-border-strong: #d4d4d8` / `--color-border-subtle: #f4f4f5`
- **Foreground**：`--color-fg-primary: #09090b` (标题/强文本) → `--color-fg-secondary: #3f3f46` → `--color-fg-tertiary: #71717a` → `--color-fg-quaternary: #a1a1aa`
- **Accent**：`--color-accent: #0a0a0a`（黑）/ `--color-accent-hover: #262626` / `--color-focus: #0070f3`（焦点用的小范围蓝）

旧 token（`--color-primary-500 / --color-text-primary / --color-border-default / --radius-md / --shadow-sm` 等）保留为 alias 映射到新 token。`--color-shadow-soft` 移除，`--shadow-sm` 设为 `none`，新增 `--shadow-pop`（仅 dialog 用）。

字号提梯度：`--font-size-sm` 从 14 → **13**（新 base），新增 `--font-size-xl: 20px`。移除 v1 临时的 `--font-size-3xl / --font-size-stat`。

圆角：`--radius-sm: 4 / --radius: 6 / --radius-lg: 8`（替代旧的 `xs/sm/md` 三档相同的值）。

---

## 2. 按钮系统重写

### 设计要求
原来的"白底 + cyan 描边 + cyan 字"二级按钮风格太 bootstrap。改为四种语义清晰的变体：**black primary / outline secondary / ghost / danger-outline**。尺寸收敛到 32（regular）、28（small）、24（图标）。

### 现状
```
.btn-primary   — 黑底 #0a0a0a + 白字（hover #262626）
.btn-secondary — 白底 + 1px 深灰边 + 黑字（hover 浅灰底）
.btn-ghost     — 透明底 + 灰字（hover 浅灰底，新增）
.btn-danger    — 透明底 + 红字 + 灰边（hover 红底白字，从"红底白字常态"改为"hover 才红底"）
```
规格：
- 高 **32**，padding `0 var(--space-3)`，radius `--radius-sm`（4px）
- `.btn-sm` 高 **28**，padding `0 var(--space-2)`，font xs
- 去掉 `transform: scale(0.98)` 的 active 弹性效果（过于 web app 感）
- `:focus-visible` 统一 `box-shadow: 0 0 0 2px var(--color-focus-ring)`（2px 焦点环，替代旧的 3px）
- `.icon-btn` 改为 **24×24 ghost**（原 28×28 带边框），hover 才出浅灰底
- `.host-toggle-btn` 改为 **20×20 ghost**（原 28×28），视觉上不抢表格数据

---

## 3. 卡片与表格扁平化

### 设计要求
- `.card` 去掉 box-shadow，1px border 定义区块
- Hosts 表去掉"蓝色渐变 group-row"、"彩色 section 标签"、"淡色行底"的多重装饰
- 表格头改成 Vercel/Linear 式 **uppercase + 字间距 + tertiary 色**
- 行 hover 用 `--color-bg-hover`（极浅灰），不再用 `#f8fafc` 偏蓝底色

### 现状
- `.card`：仅 `background + border + radius + padding`，无 shadow
- `.dialog-panel`：保留 `--shadow-pop`（8px 黑软阴影，仅此一处用阴影）
- 表头：`th / .host-rules-head th` 字号降到 `--font-size-2xs`，`text-transform: uppercase; letter-spacing: 0.06em; color: tertiary`
- `td`：base 字号 `--font-size-sm`(13)，border 改为 `--color-border-subtle`，更淡
- `.data-row:hover td` → `--color-bg-hover`
- `.group-row td`：彻底去除背景色，改为 `border-top + border-bottom` 两条细线定义分组头（上下包夹）
- `.group-title`：从 13 semibold → **14 semibold + letter-spacing: -0.01em**（K8s 资源列表风）
- `.group-desc`：改用 `var(--font-family-mono)` 显示 host 技术描述
- `.group-metrics`：取消 chip 样式（原 4px padding + 1px border + 白底），改成纯文字 `color: tertiary, font-xs`，仅用 gap 分隔 — 与 Vercel dashboard 一致
- `.host-section-label-tunnel/-service`：**取消色底 + 色边 + 色字**（原蓝/黄两套），统一为 `color: tertiary, uppercase, letter-spacing 0.08em`，只靠文字区分。`.host-section-row th` 也去掉 uppercase 样式避免重复
- `.data-row-tunnel / -service / .section-empty-row-*`：统一 `background: transparent`，完全融入白底
- `.section-empty-row-*`：空行改为 `italic + tertiary 色`，更像 K8s dashboard 的 "No resources"
- `.status-dot` 从 5px → **6px**，与 overview 卡一致
- `.status-indicator`：字号从 xs → sm，字重由 medium → regular（状态色本身已有语义，不需要加粗）
- `.status-tooltip-floating`：改为**反转色**（黑底白字），更像 Vercel 的 tooltip

---

## 4. Overview 卡

### 设计要求
label 是 uppercase + tracking 的小标签；value 是大数字，tabular-nums。

### 现状
- `.overview-label`：`uppercase + letter-spacing 0.06em + font-size 2xs + medium + tertiary` — K8s dashboard 的 "STATISTIC" 小标题风
- `.overview-value`：从 20 semibold + **`tabular-nums` + `letter-spacing: -0.01em`**
- `.overview-sub-stats`：`tabular-nums`，颜色从旧的"绿/灰/红全涂在字上"改为**字用 secondary，只有 dot 用状态色**（K8s 风）
- `.overview-sub-dot` 从 5×5 → **6×6**
- padding 从 `space-2 space-3` → `space-3 space-4`，呼吸更好
- `.quick-actions` 保持 v1 的 `dashed border-top` 分隔
- `.checkbox`：`accent-color` 从 cyan → 黑

---

## 5. Dialog / Subcard

### 设计要求
Dialog 用唯一的 pop shadow；subcard 回到"白底 + 1px 边"，靠 title 的 uppercase tracking 小号样式来区分层级（Vercel/Linear 风，而非 bootstrap 的"凹凸凹"）。

### 现状
- `.dialog-panel`：`box-shadow` 从旧的 `0 18px 48px rgba(15,23,42,0.22)` 改为 `var(--shadow-pop)`（更轻），backdrop 改为中性黑 `rgba(9,9,11,0.45)`
- `.subcard`：保留 v1 的 `--color-bg-subtle` 底色，与 dialog panel 形成轻微层级差
- `.subcard-title`：**uppercase + letter-spacing 0.06em + font-2xs + semibold + tertiary** — 替代原 "14px medium" 的普通小标题
- `.forward-row`：subcard 内的行卡用 `--color-bg-surface` + 1px border，radius 降到 `--radius-sm`（4px，更紧），与 subcard 形成清晰的凹-凸节奏
- `.icon-btn`：dialog 头的关闭按钮改成 24×24 ghost（前面已提）

---

## 6. Input 微调

### 设计要求
焦点环用新焦点色（#0070f3），不再用 cyan halo；hover 态给 border 一点反馈。

### 现状
- `.input`：padding 从 `0 var(--space-2)` 改为 `0 var(--space-3)`，与 button padding 对齐
- `.input:hover`：border 色从默认变为 `--color-fg-quaternary`（更深灰），提示可交互
- `.input:focus`：`border: var(--color-focus)` + `box-shadow: 0 0 0 2px var(--color-focus-ring)`（2px 蓝环，原 3px）
- 新增 `.input::placeholder { color: var(--color-fg-quaternary); }`
- `.terminal-log`：`font-family` 改用 `--font-family-mono` token，边/底色从 `#0f172a/#020617` → 中性 `#0a0a0a/#09090b`（与新 accent 同色系）

---

## 7. 链接与指示器

### 设计要求
链接不再是 cyan 下划线；端口号等技术标识符用 mono 字体显现"开发者工具"质感。

### 现状
- `.forward-link`：颜色从 `--color-primary-600`（cyan）→ `--color-fg-primary`（近黑），下划线 `decoration-color: --color-border-strong` 降灰，`text-underline-offset: 2px`，hover 时变 `--color-focus`（蓝）— Vercel 的链接样式
- `.forward-link`：加 `font-family: mono`，让 `host:port` 等链接文本进入开发者工具质感
- `.forward-indicator`：尺寸 16 → 14，radius `--radius-xs` → `--radius-sm`（都是 4，本质相同）
- `.group-desc`：同样用 mono，显示 host 技术描述
- `.overview-value / .overview-sub-stats / table`：全部加 `font-variant-numeric: tabular-nums`，数字对齐

---

## 8. 不在本轮范围

- `index.html` 结构**完全未改**（零增删元素）
- `.forward-name / .forward-local-* / .forward-remote-*` 的 `156/180/190px` 固定宽度保留
- `.terminal-log` 的 ANSI 颜色码（`.ansi-fg-*`）未改，保持终端兼容
- 字体文件仍用 `STM UI`，未替换为 Geist/Inter（如需替换可以作为下一步）

---

## 技术细节备忘

- 旧 class（`btn-primary / card / subcard / host-section-label-tunnel` 等）**全部保留**，仅样式替换 — HTML 不需要改
- 所有颜色/字号/圆角写死值已替换为 token（除极少数特殊值：`1px`、`5px/6px/14px` dot/checkbox、`108px` command input min-height、terminal-log 色盘）
- 焦点环从 cyan halo 改为蓝色 2px ring，全站统一
