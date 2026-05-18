# 光标定位 Bug 修复清单

本文档汇总本插件「源码模式 ⇄ 富文本」双向光标映射的已知坑位和已应用的修复。新增功能、重构 `src/cursor.ts` 或 `src/index.ts` 的退出/恢复流程前，请先过一遍这份清单，避免回退。

按出现概率从高到低排列。每条包含**症状 → 根因 → 修复 → 触发条件 → 后续注意**。

---

## 1. 进入源码模式时光标定位不准

### 1.1 点击状态栏按钮时 selection 被按钮抢走

- **症状**：用双击 `Ctrl` 进入源码模式定位准确，但点状态栏按钮进入时定位漂移或落到完全无关的位置。
- **根因**：`<button>` 是可聚焦元素，浏览器在 `pointerdown` 阶段就把焦点切到按钮，`window.getSelection().focusNode` 不再属于 protyle，`captureProtyleCursorHint` 第一道 `protyle.contains(focusNode)` 检查就 fail → 退化到 `getCachedRenderedCursorHint` 拿陈旧 hint。
- **修复**：
  - `src/index.ts:createStatusButton / createFullscreenEditor exitButton` 的 `pointerdown` 和 `mousedown` 第一行 `event.preventDefault()`，阻止焦点切换。
  - 按钮加 `tabIndex = -1`，避免键盘 Tab 走焦。
  - `src/style.css` 状态栏/退出按钮加 `user-select: none`。
- **触发条件**：状态栏按钮入口；不影响双击 `Ctrl` 键盘入口。
- **后续注意**：新加任何会触发模式切换的 UI 元素都要走同样的 preventDefault 处理。

### 1.2 `pendingCursorHint` 没有过期

- **症状**：点了一次按钮没进入（取消、错误恢复等），下一次再点时复用了"上上次"的 hint。
- **根因**：`pendingCursorHint` 只在 `enterSourceMode` 的 finally 里清，异常路径或 click 未触发时长期残留。
- **修复**：`src/index.ts:getCursorHintForEnter` 检查 `Date.now() - pendingCursorHint.updatedAt <= PENDING_CURSOR_HINT_MAX_AGE` (1500 ms)，超时丢弃。
- **后续注意**：所有"先抓后用"的 hint 都要带时间戳 + maxAge 检查。

### 1.3 `lastRenderedCursorHint` cache 永不过期

- **症状**：长时间未活跃的 doc 切回来后，进入源码模式落到一个无关位置。
- **根因**：当 live selection 抓不到时退化到 `lastRenderedCursorHint`，这个字段没有 TTL。
- **修复**：`src/index.ts:getCachedRenderedCursorHint` 增加 `RENDERED_CURSOR_HINT_CACHE_MAX_AGE` (10 s) 检查。
- **后续注意**：任何"长期保留状态"的字段都要明确 TTL。

### 1.4 `documentEdge="end"` 落到 markdown 文件最末

- **症状**：光标在最后一个块的末尾时，进入源码模式后落到 CodeMirror 文档最末（最后一个 `\n` 之后），视觉上像是"跳出文档"。
- **根因**：`resolveMarkdownDocumentEdgePosition` 在 `end` 时直接 `return markdown.length`，越过了尾随空白。
- **修复**：`src/cursor.ts:resolveMarkdownDocumentEdgePosition` 改用 `getMarkdownSignificantContentEnd`；`start` 同步跳过 leading whitespace。
- **后续注意**：新增"文档边界"语义时，务必区分"字符末尾"和"有效内容末尾"。

### 1.5 viewportY 在嵌套块上失效

- **症状**：在代码块、表格等容器内进入源码模式后页面滚到块顶而非光标行。
- **根因**：`Range.getClientRects()` 对某些跨节点 range 返回 0,0 的 rect，被 `hasUsableRect` 过滤掉后 fallback 到块顶元素的 rect。
- **修复**：`src/cursor.ts:getSelectionViewportY` 多级 fallback：
  1. 原始 range
  2. collapsed range（在 focus 端折叠后再取 rect）
  3. focus node 父元素 boundingRect
  4. 块顶 fallback（已有）
- **后续注意**：所有依赖 range geometry 的代码都要预设"rect 不可用"分支。

---

## 2. 退出源码模式时光标丢失

### 2.1 reload 是异步的，fixed delays 重试上限不够

- **症状**：长文档（>2 s）或 CPU 节流场景下退出后光标完全不放回 DOM。
- **根因**：旧版用 `delays=[180,360,700,1200,2000]` 重试，5 次 ≈ 2 s 上限，长文档 SiYuan reload 超过 2 s 就直接放弃。
- **修复**：`src/index.ts:restoreRenderedCursor` 改用 `MutationObserver`：
  - 监听 protyle 子树 childList
  - mutation 触发后 `RELOAD_RESTORE_DEBOUNCE_MS` (80 ms) debounce 再 tryRestore
  - `RELOAD_RESTORE_TIMEOUT_MS` (6 s) 上限兜底
- **后续注意**：不要重新引入 fixed-delay 重试。任何"等异步重建完成"的逻辑都用 observer + timeout 兜底。

### 2.2 observer 钉在 `.protyle-wysiwyg` 上看不到整棵替换

- **症状**：reload 完成但 observer 一直不触发，最后只靠 6 s timeout 一次性 restore，体验滞后。
- **根因**：SiYuan reload 会整体替换 `.protyle-wysiwyg` 节点，挂在旧 wysiwyg 上的 observer 接收不到父级 swap 事件。
- **修复**：`src/index.ts:findReloadObserverTarget` 改成观察 `.protyle` 容器本身（subtree childList）。
- **后续注意**：observer 永远挂在**比观察对象更稳定的祖先**上，subtree:true。

### 2.3 立即 `tryRestore` 在旧 DOM 上假成功

- **症状**：退出后短时间内光标看起来在原位，过一会儿（重建完成时）又跳走。
- **根因**：早期实现里 `restoreRenderedCursor(afterReload=true)` 先立即 `tryRestore()` 一次，由于 A4 在 cleanup 前已经在旧 DOM 上预设过 caret，这次"假成功" → `finish(true)` 退出，后续 observer 没机会接管，真重建完成时 caret 被覆盖。
- **修复**：`src/index.ts:restoreRenderedCursor` 去掉 afterReload=true 路径的立即 tryRestore，改为：
  - 先挂 observer
  - 设一个 `RELOAD_RESTORE_GRACE_MS` (240 ms) grace timer：240 ms 内若无 mutation 才尝试 restore（兜底 "reload 没真重建"的场景）
  - 任何 mutation 触发都会清掉 grace
- **后续注意**：所有"等待异步事件"的入口都要先挂监听器再发起触发，避免事件先于挂载发生。

### 2.4 cleanup 早于 reload，wysiwyg 抢焦覆盖 caret

- **症状**：reload 完成后光标短暂出现又立刻被 wysiwyg 自身 selection 覆盖。
- **根因**：cleanup 拆全屏后浏览器焦点飘到 body，SiYuan wysiwyg 重新挂载时会自设一个默认 selection 覆盖我们后设的 caret。
- **修复**：
  - `src/index.ts:exitSourceMode` 在 cleanup 之前先 `tryRestoreRenderedCursor` 一次，给重建一个 selection 起点。
  - `src/cursor.ts:setCaretAtPosition` 增加 `scheduleCaretReinforcement`：
    - rAF 重设一次
    - 注册 `CARET_DEFENSE_WINDOW_MS` (160 ms) 一次性 `selectionchange` 守卫，期间若发现 selection 漂出当前 root 就再设一次，超时自行 detach
- **后续注意**：不要引入持久 `selectionchange` listener，会和思源自身交互打架。守卫窗口要短（≤200 ms）。

---

## 3. 块粒度 / 候选下标对齐

### 3.1 `getApproximateBlockIndex` 在 blockCount 不一致时偏移

- **症状**：某段之后所有光标定位都偏到上一段。
- **根因**：normalize 后的 markdown block 数 和 DOM block 数不一致（详见 3.3），公式 `blockIndex/(srcCount-1) * (dstCount-1)` 在中后段会偏 1。
- **修复**：在 3.3 中根治；同时 `getApproximate*BlockCandidate` 在 hint 有 blockType 时优先在同类型块里选最接近的（见 3.2）。
- **后续注意**：blockIndex/blockCount 必须两端语义一致。改任何一端的 block 收集逻辑都要确认另一端是否对齐。

### 3.2 approximate 不看 blockType，落到错类型块

- **症状**：表格内进入/退出源码模式后光标落到表格之外。
- **根因**：`getApproximateRenderedBlockCandidate` / `getApproximateIndexedBlockCandidate` 旧实现只按 approximateIndex 取下标，不看 blockType。当用户在 NodeTable 内且 exact/text 候选都没命中时，approximate 选到非 table 元素，`findRenderedTableCellPosition` 找不到 tr → 落到表格外。
- **修复**：`src/cursor.ts:getApproximateIndexedBlockCandidate / getApproximateRenderedBlockCandidate` 在 hint.blockType 存在时**先在同类型块中**选离 approximateIndex 最近的；没同类型才回落到 blocks[approximateIndex]。
- **后续注意**：所有"近似挑选块"的函数都应优先尊重 blockType。

### 3.3 normalize 移除 zero-width 字符导致空段消失

- **症状**：文档末尾有一个只含 `U+200D`(zwj) 之类的段落时，该段之后所有光标都偏 1 块。
- **根因**：`normalizeMarkdownForSave` 剥掉 zero-width 字符（`​-‍`, `﻿`），让该段在 markdown 中变成空行，`getMarkdownBlocks` 就少数 1 块；DOM 端仍然渲染该段（zwj 段落是合法占位段），导致 blockCount 不一致。
- **修复**：`src/cursor.ts:getRenderedBlocks` 在过滤时调用 `isEffectivelyEmptyRenderedBlock`，剔除"只含 zero-width / 空白"的 NodeParagraph，让 DOM 端块数和 normalize 后的 markdown 一致。
- **判定逻辑**（限制在 NodeParagraph，避免误删空代码块/表格）：
  ```
  isEffectivelyEmptyRenderedBlock:
    - 仅对 data-type="NodeParagraph"
    - block 内无嵌套 [data-node-id] 子块
    - contenteditable=true 子树 textContent 在 strip 后为空（strip 同 normalizeMarkdownForSave 规则）
  ```
- **后续注意**：
  - `normalizeMarkdownForSave` 的字符集（zero-width 范围 + NBSP + BOM）和 `isEffectivelyEmptyRenderedBlock` 的 strip 字符集必须保持同步。
  - 其他可能被 normalize 误剥的字符（如果将来加入到 normalize 规则）也要同步处理。

### 3.4 occurrenceIndex 在 markdown/text 候选集合上下标错位

- **症状**：长文档中重复段落（多个相同标题、多个空段落）的定位漂移。
- **根因**：`getPreviousSimilarRenderedBlockCounts` 在比对超过 `MAX_MARKDOWN_BLOCK_COMPARISONS` (80) 或 Lute 不可用时进入 `skippedExactComparison` 退化，`markdownCount` 被替换成 `textCount`。但下游 `findExactBlockCandidate` 仍然把 `cursorHint.occurrenceIndex` 当成 markdown 精确候选集的下标 → 错位。
- **修复**：
  - hint 新增 `occurrenceMode: "markdown" | "text"` 字段（`src/cursor.ts:ProtyleCursorHint`）。
  - `getPreviousSimilarRenderedBlockCounts` 返回 `exactConfident` 标志，capture 端填 mode。
  - `findExactBlockCandidate` / `findRenderedBlockCandidate` 用 `getExactOccurrenceIndex(hint)`：mode === "text" 时返回 `textOccurrenceIndex`，否则返回 `occurrenceIndex`。
- **后续注意**：occurrence 计数和候选集合**必须**逻辑对齐。任何引入新候选集合（如按 hash 比对）的改动都要同步 mode 字段。

---

## 4. DOM 端 visible text 包含装饰元素

### 4.1 代码块行号被算入 visible text，反复进出向前漂移

- **症状**：光标定在代码块内某字符前，反复进/退源码模式，光标每次向前 N 个字符。
- **根因**：`iterateTextNodes` 旧实现只排除 `.protyle-attr, .protyle-action, script, style`。SiYuan 代码块的行号容器 `.protyle-linenumber` 是真实文本节点（`1\n2\n3\n...`），被算入 DOM 端 visible text → DOM 端 `textOffset` 比 markdown 端多 N。每次 capture→resolve 把光标向后推 N，但 markdown→DOM resolve 又向前 N，往返累积。
- **修复**：`src/cursor.ts:iterateTextNodes`：
  - 排除 selector 扩充到 `.protyle-linenumber, .protyle-cursor, .protyle-icons, .hljs-ln-numbers, .protyle-breadcrumb` 等装饰元素。
  - 新增 `isInsideNonEditableSubtree`：沿父链向上找 `contenteditable` 属性，遇 false 即排除、遇 true 即接受、走到 root 即接受。这样思源所有 `contenteditable="false"` 装饰元素自动剔除。
- **后续注意**：
  - SiYuan 版本升级后如果新增了 `contenteditable="false"` 的装饰元素，自动被剔除，无需追加 selector。
  - 但新加**确实需要计入**的 contenteditable=false 子树（如某些特殊渲染块的可见内容），需要明确放行。
  - 不要破坏"通过 `contenteditable` 判定"的语义。

---

## 5. Lute 依赖

### 5.1 Lute 不可用时 exact 整条链失效

- **症状**：在某些早期 onload / publish 模式下，重复段落定位完全走 approximate。
- **根因**：`getRenderedExactCandidates` 旧实现在 `createLute()` 为 null 时直接返回 `[]`，整条 exact 路径短路。
- **修复**：`src/cursor.ts:getRenderedExactCandidates` 增加 `allowTextFallback` 参数；callsite (`findRenderedBlockCandidate`) 区分：
  - textCandidates 非空时 → `allowTextFallback=true`，Lute 缺失时退化为 text 候选
  - textCandidates 空、用 nearby 时 → `allowTextFallback=false`，Lute 缺失返回 `[]`（避免把无关同类型块当 exact）
- **后续注意**：所有依赖 Lute 的代码路径都要有"无 Lute"的合理 fallback，且 fallback 行为不能错位（如把 nearby 当 exact 这样的语义混淆）。

---

## 6. 不变量速查

实现新功能前确认这些不变量：

1. **块粒度对齐**：`getRenderedBlocks` 数量 == `getMarkdownBlocks(normalizeMarkdownForSave(markdown))` 数量（在不出现极少见嵌套场景时）。
2. **textOffset 含义对齐**：两端的 `textOffset` 都是"光标前的**可见**字符数"，且：
   - 代码块用 `Array.from(text).length`（codepoint 数）
   - 其他块用 `getVisibleTextLength`（合并连续空格 + 跳过装饰字符）
3. **`occurrenceIndex` 语义**：表示"当前块前面有几个完全相同的块"。模式由 `occurrenceMode` 区分，下游必须根据 mode 用 `occurrenceIndex` 或 `textOccurrenceIndex`。
4. **normalize 字符集同步**：`normalizeMarkdownForSave` 剥的字符集和 `isEffectivelyEmptyRenderedBlock` 的 strip 字符集**必须**一致。
5. **operation generation**：所有异步回调（observer、setTimeout、Promise）退出前都要比对 `this.operationGeneration`，旧 generation 的回调必须放弃后续动作。
6. **observer target 选择**：永远挂在比观察目标更稳定的祖先节点上，subtree:true。
7. **caret 设置后的防御窗口**：≤200 ms 内的 `selectionchange` 守卫足以挡住 wysiwyg 抢焦，时间再长会和正常用户交互打架。

---

## 7. 已知容易踩的坑

写新代码 / 调 bug 时优先检查这些点：

- **按钮抢焦**：所有可聚焦元素加 `pointerdown event.preventDefault()` + `tabIndex=-1`。
- **fixed-delay 重试**：禁止；用 MutationObserver + timeout。
- **`getRenderedBlocks` 的 selector**：只取 `.protyle-wysiwyg > [data-node-id]` 直接子节点，嵌套块不算顶层（这是约定，不要改）。
- **Lute 可用性**：`createLute()` 任何时候都可能返回 null，每个调用点都要处理。
- **SiYuan 自定义渲染**：思源的 wysiwyg 在重挂载时会自设 selection；任何 caret 设置都要带 RAF + selectionchange 守卫。
- **零宽字符**：`normalizeMarkdownForSave` 会剥掉，正则要写完整 `[​-‍﻿]`。
- **markdown 文档边界**：`markdown.length` ≠ "有效内容末尾"，前者含尾随 `\n`/空白。

---

## 历史变更记录

| 版本 | 主要修复 | 提交 |
|---|---|---|
| - | A1-A4 / B1-B5 / C1 / D 首轮系统优化 | 待提交 |
| - | P1-P3 ChatGPT 评审修正 | 待提交 |
| - | 表格 approximate / 代码块行号 / zwj 段块数对齐 | 待提交 |
