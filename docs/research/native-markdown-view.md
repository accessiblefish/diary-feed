# Obsidian 1.15.1 原生 MarkdownView 独立挂载研究报告

> 目标：评估在 DiaryFeedView（自定义 ItemView）内嵌原生 MarkdownView / Live Preview 编辑表面的可行性，
> 替代现状的自研 CodeMirror 封装（`src/editor.ts`），并解释旧方案
> （`new MarkdownView(this.view.leaf)` + `view.addChild(preview)` + `preview.setViewData(body,true)` +
> `preview.setState({mode:"source",source:false},{history:false})`）产生连续跳转、重复导航/视图 chrome 的机制。
>
> 研究日期：2026-11-18。运行时样本：`/Applications/Obsidian.app`（版本 1.15.1，Info.plist 已核对），
> 主 bundle 为 `Contents/Resources/obsidian.asar`（24 MB，经 `asar extract` 解出 `app.js`，3.2 MB，webpack 压缩产物）。
> 类型样本：`plugins/diary-feed/node_modules/obsidian/obsidian.d.ts`（obsidian npm 包 1.14.4）与
> GitHub `obsidianmd/obsidian-api` master 版 d.ts（11545 行，已下载核对）。
>
> **事实分级标记**：【公开】= 官方 d.ts / 官方文档声明；【运行时】= 1.15.1 app.js 反混淆阅读（私有，随时可变）；
> 【推测】= 基于前两类证据的推断，未经实机验证。文中所有 app.js 偏移量均指 1.15.1 `obsidian.asar` 内 `app.js` 的字节偏移。

---

## 0. 核心结论（TL;DR）

1. **旧方案的病根是"共享 leaf"**：`View` 构造器会把新视图容器插进传入 leaf 的 DOM（【运行时】app.js `es` 类，偏移 ~1144867），
   `ItemView`/`MarkdownView` 的 header、inline-title、properties、模式按钮因此叠加在日记流 leaf 里 → 重复 chrome；
   该 leaf 已挂在工作区上，叶子上的 `pointerdown/focusin` 监听会 `setActiveLeaf`、编辑器内链接点击会
   `workspace.openLinkText(...)` 默认复用当前 active leaf → feed 被替换 → 表现为"连续跳转/重复导航"。
2. **可以创建真正 detached 的 WorkspaceLeaf**（【运行时】`new (leaf.constructor)(app)`，即内部类 `Lt`）：
   无 parent、不进 rootSplit/floatingSplit，`Workspace.setActiveLeaf` 的 `isAttached` 守卫（app.js ~2544083）使其
   永远无法成为 activeLeaf、不会写 history、不会创建 tab chrome；叶子自带的 `focusin/pointerdown → setActiveLeaf`
   监听对 detached leaf 是空操作。**这是本研究最关键的正面发现**。
3. 在该 detached leaf 上 `new MarkdownView(leaf)` + `leaf.open(view)`（`leaf.open` 是【公开】API）即可得到一个
   "寄生"在日记流行内的、功能完整的原生 Live Preview 表面。
4. **自动保存整文件的问题可以在公开 API 面内解决**：`TextFileView.requestSave`/`save()`/`getViewData()`/`setViewData()`
   均为【公开】成员，子类覆盖后把保存路由回 DiaryEntryController 的 baseline 冲突控制（`vault.process`）即可，
   原生 `vault.modify` 整文件写盘路径可以被完全短路。
5. 副作用不可清零：内嵌编辑器的每次键入都会全局广播 `editor-change`/`editor-selection-change`（【运行时】rw.onUpdate，
   app.js ~2260271），focus 会设置 `workspace.activeEditor`（app.js ~2244200 一带的 domEventHandlers）。
   这些对其它插件可见，无法屏蔽。
6. **风险无法完全消除**：内部构造器无类型保证、全局编辑器事件、每个实例都是完整 CodeMirror（内存）、
   body/frontmatter 分离意味着 properties 编辑器不可用。建议先按 §7 原型验证，命中 §7.4 停止条件即回退自研 CM6。

推荐方案排序：

| 方案 | 原生程度 | 导航/历史污染 | 保存可控性 |  verdict |
|---|---|---|---|---|
| A. detached leaf + MarkdownView 子类（§6） | 高（Live Preview、fold、search、suggest） | 无（isAttached 守卫） | 完全可控（覆盖 save 链） | **推荐原型验证** |
| B. 官方真实 tab：`workspace.getLeaf("tab").setViewState({type:"markdown",...})` | 最高 | 有（真实 tab、写 history） | 可控但脱离 feed 内嵌场景 | 备选（放弃"内嵌"诉求时） |
| C. 单独用 `MarkdownEditView` | — | — | — | **不可行**：d.ts 声明公开（【公开】obsidian.d.ts:5771），但 1.15.1 运行时导出名表中**不存在** `MarkdownEditView`（【运行时】app.js 导出表 ~2414707 全量核对，全文 0 处出现） |
| D. 共享 feed leaf 的旧做法 | — | 严重 | 差 | 否决（§2 已证伪） |
| E. 现状自研 CM6（`src/editor.ts`） | 低 | 无 | 完全可控 | 兜底 |

---

## 1. 信息来源与可信度

| 来源 | 位置 | 用途 |
|---|---|---|
| 官方 API 文档 | https://docs.obsidian.md/Reference/TypeScript+API（如 [MarkdownEditView](https://docs.obsidian.md/Reference/TypeScript+API/MarkdownEditView)、[View](https://docs.obsidian.md/Reference/TypeScript+API/View)） | 公开面核对（站点为 JS 渲染，正文以 d.ts 为准） |
| 本地 d.ts | `plugins/diary-feed/node_modules/obsidian/obsidian.d.ts`（npm obsidian@1.14.4） | 公开 API 边界（行号引用见下文） |
| 上游 d.ts | github.com/obsidianmd/obsidian-api master（2026-11-18 拉取，11545 行） | 交叉核对 1.14.4 d.ts 是否落后 |
| 运行时源码 | `/Applications/Obsidian.app/Contents/Resources/obsidian.asar → app.js`（3.2 MB，版本 1.15.1） | 私有行为唯一权威（类名经导出表 `MarkdownView:()=>lt` 等反查，偏移量引用见下文） |

注意：npm obsidian 包 1.14.4 的 d.ts 与 1.15.1 运行时之间存在版本差。本报告所有"私有行为"结论均以 1.15.1 运行时为准；
d.ts 仅用于判定"公开/非公开"。两处版本差已在文中显式标注（`MarkdownEditView` 导出问题、无其它影响结论的差异）。

## 2. 旧方案症状机制还原（共享 leaf 的罪状清单）

以下每条均给出 1.15.1 app.js 中的直接证据；旧代码已不存在于仓库，"症状链路"的组装部分标注【推测】。

### 2.1 重复视图 chrome 的来源 —— View 构造器污染 leaf DOM【运行时，确证】

`View`（导出表 `View:()=>es`，类体 app.js 偏移 ~1144867）构造器：

```js
var es=class extends Se{
  constructor(e){            // e = WorkspaceLeaf
    this.app=e.app, this.leaf=e,
    this.containerEl=e.containerEl.createDiv("workspace-leaf-content"),  // ← 插进 leaf 容器
    this.containerEl.setAttribute("data-type",this.getViewType())
  }
  async open(e){ e.appendChild(this.containerEl); ... }
```

`ItemView`（`ItemView:()=>Nt`，~1146536）继续创建 `view-header` + `view-content`；
`MarkdownView`（`MarkdownView:()=>lt`，~2668431）构造器再追加 inline-title、metadataEditor（PropertiesEditor）、
backlinks 容器、模式切换按钮。因此 `new MarkdownView(this.view.leaf)` 的瞬时效果就是：
**feed leaf 的 DOM 里多出整整一套原生笔记 chrome，且与日记流自身内容并列显示**。
若每次点击都重复执行而未卸载旧实例，chrome 会层层叠加——这就是"重复视图 chrome"。

### 2.2 跳转/重复导航的来源【运行时机制 + 推测组装】

三个已确证的机制，叠加后足以解释"点击日记发生连续跳转"：

1. **叶子级激活监听**。`WorkspaceLeaf`（`WorkspaceLeaf:()=>Lt`，~1389354）构造器：
   ```js
   r.addEventListener("focusin", ()=>{ this.app.workspace.setActiveLeaf(this) });
   r.addEventListener("pointerdown", ()=>{ this.app.workspace.setActiveLeaf(this) }, {capture:!0});
   ```
   feed leaf 是已挂载 leaf，`isAttached` 通过，`setActiveLeaf` 生效（app.js ~2542222）：
   切换 `mod-active`、触发 `requestActiveLeafEvents()` → 全局广播 `active-leaf-change`、`file-open`（~2543468）。
   任何监听这两个事件的插件/核心逻辑（如文件树自动定位、最近文件追踪 `recentFileTracker`）都会被反复点燃。
2. **内嵌表面里的链接点击劫持 leaf**。链接代理 `Dv`（app.js ~1817424）：
   ```js
   onInternalLinkClick(t,e,i){ t.preventDefault();
     this.info.app.workspace.openLinkText(i, this.info.path, X.isModEvent(t)) }
   ```
   `Workspace.openLinkText` → `getLeaf(r).openLinkText(...)`（~2542158）；无修饰键时 `getLeaf(undefined)` →
   `getUnpinnedLeaf()`（~2540644）→ **复用当前 activeLeaf（此时就是 feed leaf）** → 链接目标笔记在 feed leaf 中打开、
   日记流被替换。这正是"点击即跳走"的直接通道。若旧实现把真实 file 放进了视图（`this.file`），
   Live Preview 中 `MarkdownView.triggerClickableToken`（~2683000）同样直达 `openLinkText`。
3. **拖放劫持**。leaf 的 `handleDrop`（~1399500 一带）：`return r||(this.workspace.setActiveLeaf(this), ... this.openFile(i.file))`。
   往内嵌区拖文件 = 激活 feed leaf 并替换其视图。

### 2.3 历史与状态污染【运行时，确证】

- `FileView`（`FileView:()=>kn`，~1355652）`navigation=true`；`recordHistory`（leaf，~1401200）只对
  `navigation` 视图生效并 `history.pushState`（上限 20 条，`History` 类 `Q9` ~1387000）。
  任何走到 `leaf.setViewState` 的路径（包括 MarkdownView 自带的模式切换按钮 `onSwitchView` → `this.leaf.setViewState`，~2677500）
  都可能把状态写进 feed leaf 的历史栈，并强制 `workspace.onLayoutChange()` + `requestSaveLayout()` 落盘布局。
- `FileView.setState`（~1358480）：文件真实变化时**无条件** `i.layout=!0, i.history=!0`（无视调用方传入的 `{history:false}`），
  并挂 `i.done=()=>this.syncState()` 做组内 leaf 同步。旧调用直接打裸 `view.setState`，绕过了 leaf 的 history 去重逻辑。
- `TextFileView`（`TextFileView:()=>Ia`，~2441889）`onload()` 注册 `vault.on("modify")` → 文件一变就
  `loadFileInternal` 三向合并重载——**在 feed 里编辑到一半，外部同步/插件一改文件，内嵌内容就被整文件内容顶掉**
  （分离正文/frontmatter 的模型直接崩）。旧代码 `view.addChild(preview)` 之所以让这一切生效，
  是因为 `Component.addChild` 在父组件已加载时会立即 `child.load()`（`Se`，~797432）→ `MarkdownView.onload`
  注册 `quick-preview/resize/css-change/config-changed`、经 `TextFileView.onload` 注册 `vault modify`（~2668431、~2441889）。

### 2.4 小结

旧方案把"原生视图"绑在了**真实工作区 leaf** 上：DOM 注入（chrome 叠加）+ 激活监听（activeLeaf/file-open 风暴）+
链接/拖放默认目标（feed 被替换）+ history/layout 写盘，四个通道互相放大，形成"连续跳转、重复导航"的观感。
**问题不在 MarkdownView 本身，而在共享 leaf。**

---

## 3. 生命周期与关键调用事实清单

### 3.1 构造链（全部【运行时】+ 构造器公开性【公开】）

`MarkdownView(leaf)` 公开构造（d.ts ~6170）。构造时依次执行：

| 层 | 类（导出符号） | app.js 偏移 | 构造期副作用 |
|---|---|---|---|
| Component | `Se` | ~797432 | 基类，`addChild` 仅当父已 `load()` 才级联加载 |
| View | `es` | ~1144867 | `containerEl` 插进 `leaf.containerEl`（§2.1） |
| ItemView | `Nt` | ~1146536 | 建 `view-header`/`view-content`；移动端另加侧栏开关 |
| FileView | `kn` | ~1355652 | `navigation=true`；`onload` 注册 vault rename/delete |
| EditableFileView | `vo` | ~2282550 | inline title 行为 |
| TextFileView | `Ia` | ~2441889 | 定义 `requestSave`（dirty 标记 + 2 s 防抖 `save`）；`onload` 注册 vault `modify` 重载 |
| MarkdownView | `lt` | ~2668431 | `editMode=new MarkdownEditView 实现类 Nx(this)`、`previewMode=new Ho(this)`、`metadataEditor=new _d(app,this)`、inline-title、模式按钮；按 `defaultViewMode` 立即 `currentMode.show()` |

关键：**MarkdownView 构造即创建完整 CodeMirror 编辑器**——`K3`（source 模式基类，~2239747）构造器
`this.cm=new Y({parent: editorEl})`；`Nx`（Live Preview/source 模式，`MarkdownEditView` 的运行时实现，`Nx=class extends rw`，~2266200 一带）
在其 `set(data, clear)` 时才装扩展。`livePreview` 配置决定 `sourceMode` 初值：
`this.sourceMode=!this.app.vault.getConfig("livePreview")`（K3 构造器）——**Live Preview = source 模式 + `sourceMode=false`**，
`toggleSource()` 翻转（~2250515）。

### 3.2 load/open/setState/onLoadFile 生命周期【运行时 + 公开面】

- `View.open(e)`：`e.appendChild(this.containerEl)` → `this.load()`（`onload()` + 子组件 load）→ `onOpen()`。
- `leaf.open(view)`【公开，d.ts ~11240】：关闭旧视图（`view.close()`：`containerEl.detach()` + `unload()` + `onClose()`）、
  `this.view=view`、`view.open(this.containerEl)`。leaf 构造器自带 `this.view=this._empty=new Vr(this); this.view.open(...)`（空视图）。
- `FileView.loadFile(file)`：`onUnloadFile(旧)` → `file=新` → `onLoadFile(新)` → `renderBreadcrumbs()` →
  `leaf.updateHeader()` → **若该 leaf 是 activeLeaf 则 `workspace.requestActiveLeafEvents()`**（~1358868）。
  `onClose()` 会 `contentEl.empty(); await this.loadFile(null)`。
- `TextFileView.onLoadFile` → `loadFileInternal` → `setData` → `setViewData(data, clear)`；
  外部 `modify` 且未在保存中时同样走 `loadFileInternal`，dirty 时做三向合并（`sw(n,a,r)`）并弹"文件已变更"通知。
- `WorkspaceLeaf.setViewState(state, eState)`（~1395500）：视图类型变化时新建视图（经 `viewRegistry` 创建器）、
  `c={history:!1,layout:!1,close:!1}` 传给 `view.setState(d,c)`；`state.active` → `workspace.setActiveLeaf(this,{focus:!0})`；
  结束时 `c.layout&&workspace.onLayoutChange()`、`c.history&&recordHistory(l)`。`FileView.setState` 在文件变化时强制 `layout/history=true`。
- `MarkdownView.setState`：处理 `mode/source/backlinks`；`r&&(i.layout=!0)` 会**改写传入的结果对象**；
  `setMode` 离开 source 模式前 `await this.save()`（~2671500）。

### 3.3 保存管线（问题 4 的核心）【运行时 + 公开面】

| 成员 | 公开性 | 行为（app.js 证据） |
|---|---|---|
| `TextFileView.requestSave` | 【公开】属性（d.ts TextFileView 类起于 ~9849） | `()=>{this.dirty=!0; debounce(save,2e3)()}`（~2441889） |
| `Nx.onUpdate` docChanged | 【运行时】 | `this.view.requestSave()` + `requestOnInternalDataChange()` + `requestSaveFolds()`（~2266200） |
| `TextFileView.save(clear?)` | 【公开】 | 仅当 `lastSavedData!==getViewData()` 时 `writeData` → **`vault.modify(file, 全部内容)`**（~2441889）；`clear=true` 后清空数据 |
| `K3` blur 处理器 | 【运行时】 | `owner instanceof lt && owner.saveImmediately()`（~2244200） |
| `MarkdownView.saveFrontmatter` | 【运行时】 | `Up(getViewData(),e)` 注入 frontmatter → `setViewData` → `save()`（~2670500） |
| `TextFileView.onUnloadFile` | 【公开】 | `await this.save(!0)` |
| `FileView.onDelete` | 【运行时】 | 文件被删 → `history.back()`，历史空则 `open(null)`（~1358868 一带） |

结论：**只要 `file` 为 null，`save()` 在 `if(!i||i.deleted)return` 处空转**（~2441889）——旧方案碰巧没写盘；
但一旦给视图赋了真实 file（为了让链接/属性解析），原生路径就会整文件 `vault.modify`，并吞掉 frontmatter/正文分离。
因此"只呈现编辑表面、保存自控"= 子类化并接管 save 链（见 §6）。

---

## 4. 问题 2：detached/offscreen WorkspaceLeaf 的可行性

### 4.1 公开 API 层面【公开】

- `WorkspaceLeaf` 在 d.ts 中**未声明公开构造器**（d.ts ~11200 起，全类无 `constructor`）→ 不能 `new WorkspaceLeaf(app)`（TS 层面）。
- `workspace.createLeafInParent(parent: WorkspaceSplit, index)`【公开，@since 0.9.11，d.ts ~10763】存在，
  但运行时它 `new Lt(app)` 后 `e.insertChild(i,r)` 并 **`this.setActiveLeaf(r)`**（app.js ~2539322）——
  parent 是真实布局 split 时就是真实 tab；并且 `WorkspaceSplit`/`WorkspaceTabs` 构造器均非公开。
- `workspace.getLeaf("tab"|"split"|"window"|true|false)`【公开】全部产出真实挂载 leaf（`createLeafInTabGroup`/`createLeafBySplit`/`openPopoutLeaf`/`getUnpinnedLeaf`，~2541062），其中 `createLeafBySplit`、`createLeafInParent`、`getUnpinnedLeaf(e=true)` 都会 `setActiveLeaf`。

### 4.2 运行时内部路径【运行时，确证】

```ts
const LeafCtor = this.app.workspace.getLeaf(false).constructor as new (app: App) => WorkspaceLeaf;
const leaf = new LeafCtor(this.app);   // 内部类 Lt：constructor(e,i){ super(e.workspace,i); this.app=e; ... }
```

`Lt` 构造器（~1389354）做的事：建 `containerEl`（**游离 div，不在文档树**）、建 `tabHeaderEl`（游离，仅当被
`WorkspaceTabs.insertChild` 时才渲染成标签页）、`focusin/pointerdown` 监听、`ResizeObserver`、
创建并 open 空视图。**不做任何工作区注册**。

安全性逐条核对（全部源码级证据）：

| 检查点 | 结果 | 证据 |
|---|---|---|
| `setActiveLeaf(detached)` | 空操作：`isAttached` 要求 `getRoot()∈{leftSplit,rootSplit,floatingSplit,rightSplit}`，无 parent 时 getRoot=自身 → 拒绝 | ~2544083、~1363465（`Zh.getRoot`）、~2542222 |
| leaf 自带 focusin/pointerdown 监听 | 同样被 isAttached 挡住 | ~1389354 |
| 写 history | 只有 `leaf.setViewState` 会 `recordHistory`；我们不调用即无。`pushUndoHistory` 只在 `leaf.detach()` 且经 parent 时触发，detached leaf 无 parent | ~1395500、~2555440、~1363465 |
| tab chrome | `tabHeaderEl` 游离；只有 `WorkspaceTabs` 收编才上屏 | ~1389354、~1389354 前的 `rt.insertChild` |
| `workspace.iterateAllLeaves/getLeavesOfType("markdown")/updateOptions` | 只遍历 rootSplit/floatingSplit/两侧 dock，detached 不可见 | ~2545864、~2546380、~2548316 |
| `workspace.activeLeaf/getActiveFile` | 不受影响（activeEditor 会在 focus 时被改写，见 §5） | ~2531104、~2545286 |
| `revealLeaf(detached)` | 不检查 isAttached：`getContainer()` 无 parent 时回退 rootSplit 并可能 `focus()`；**不调用即可** | ~2547621 |

结论：**运行时存在真正 detached 的 leaf 构造路径**，配合"永不调用 setViewState/openFile/revealLeaf/setActiveLeaf"
即可完全隔离导航与工作区状态。代价是依赖私有构造器（无 d.ts 类型、跨版本可能失效）。

### 4.3 从 workspace 创建 leaf 后"安全隔离导航"是否可行

可以，但只能在"不激活"意义上隔离：`createLeafInTabGroup` 是唯一默认不强制激活的创建口
（仅当用户配置 `focusNewTab` 时激活，~2541222），且仍产生真实 tab、可被用户拖放/关闭、会进历史。
对"内嵌在日记流行里"的诉求没有帮助。**结论：共享/真实 leaf 做不到干净隔离，detached leaf 才行。**

---

## 5. 问题 3：哪些调用会写 history / reveal / 建 tab / 插 chrome（速查表）

| 调用 | 写 history | 激活/reveal | 建 tab/chrome | 证据 |
|---|---|---|---|---|
| `leaf.setViewState(...)`（类型变化时） | 是（recordHistory 上一状态） | `state.active` 时 `setActiveLeaf(focus)` | 经 viewRegistry 新建视图 | ~1395500 |
| `leaf.openFile(file)` | 经由上 | 默认 `active = this===workspace.activeLeaf` | 同上 | ~1392000 |
| `workspace.getLeaf()/getUnpinnedLeaf(true)` | — | **是** | 复用或新建真实 leaf | ~2541062、~2540644 |
| `workspace.createLeafInParent/BySplit` | — | **是**（setActiveLeaf） | 真实 split/tab | ~2539322、~2539940 |
| `workspace.createLeafInTabGroup` | — | 仅当 `focusNewTab` | 真实 tab | ~2541222 |
| `workspace.revealLeaf` | — | **是**（激活+focus+loadIfDeferred） | — | ~2547621 |
| `workspace.openLinkText` / `openFile`（无 pane 指定） | 经由目标 leaf | 复用 activeLeaf | 目标 leaf 的 setViewState | ~2542158 |
| `workspace.duplicateLeaf` | — | 取决于 leafType | 真实 leaf | ~2540351 |
| `leaf.detach()` | `pushUndoHistory`（重开标签页栈） | — | 移除 tab | ~1401200、~2555440 |
| `view.close()` / `leaf.open(null)` | 否 | 否 | 仅清理自身 DOM | ~1144867 |
| **`new MarkdownView(detachedLeaf)` + `leaf.open(view)` + `setViewData`** | **否** | **否** | **无（见 §4.2）** | §3、§4 |
| `setState({mode...})` 裸调用 | 否（不经 leaf） | 否 | `i.layout` 标记仅被 leaf.setViewState 消费 | ~2671500 |

写盘类副作用另计：`workspace.onLayoutChange()` → `requestSaveLayout`（布局序列化落盘）只该由真实布局变化触发；
内嵌方案不触发。

## 5.1 无法屏蔽的内嵌副作用【运行时，确证】

- 每次 docChanged：`workspace.trigger("editor-change", editor, owner)`、`editor-selection-change`（rw.onUpdate，~2260271）。
- cm focus：`workspace.activeEditor = owner`；blur：原生 `saveImmediately()`（被我们的 save 覆盖接管）。
- `workspace.editorSuggest` 是全局共享的 suggest 管理器（K3 构造 `this.editorSuggest=e.workspace.editorSuggest`），
  内嵌编辑器触发自动补全时与其它视图互斥。
- `MarkdownView.onload` 注册的 `quick-preview/resize/css-change/config-changed` 监听在 `leaf.open(view)` 后生效，
  其中 `onExternalDataChange` 只对 `e===this.file` 响应；保持 `file=null` 即安全。
- 全局 editor extensions（各插件 `registerEditorExtension`）在内嵌视图 `setViewData(...,clear=true)` 时快照；
  之后注册的扩展不会热更（`updateOptions` 只遍历已挂载 leaf 的 MarkdownView，~2548316）。

## 6. 推荐方案（方案 A）：detached leaf + MarkdownView 子类

设计要点（全部为对公开类的子类化 + 少量运行时字段，原型代码可全部用 TS 写在测试插件里）：

```ts
class DetachedDiaryMarkdownView extends MarkdownView {
  constructor(leaf: WorkspaceLeaf, private ctl: DiaryEntryControllerLike) {
    super(leaf);
    // 1) 接管保存链：永不 vault.modify 整文件
    this.requestSave = () => { this.ctl.onEditorChanged(this.getViewData()); };
  }
  // path 被多处消费（链接解析、hover、Dv 代理），file 为 null 时原生 getter 直接抛 TypeError
  get path(): string { return this.ctl.file.path; }
  get file(): TFile | null { return null; }          // 保持 save() 原生路径空转（双保险）
  async save(): Promise<void> { return; }            // 公开成员覆盖
  saveImmediately(): void { void this.ctl.flush(); }
  onModify(file: TFile): void { this.ctl.handleModified(file); }   // 阻止整文件重载合并
  setViewData(data: string, clear: boolean): void { super.setViewData(data, clear); }
  triggerClickableToken(e: {type:string;text:string}, newPane?: boolean): void {
    if (e.type === "internal-link")
      void this.app.workspace.getLeaf("tab").openLinkText(e.text, this.path, newPane);
    else super.triggerClickableToken(e as any, newPane);
  }
}
```

装配序列（对照旧方案逐条替换）：

```ts
const leaf = new (Object.getPrototypeOf(this.app.workspace.getLeaf(false)).constructor as any)(this.app) as WorkspaceLeaf;
const view = new DetachedDiaryMarkdownView(leaf, controller);
await leaf.open(view);                    // 公开 API；触发 load/onload
hostEl.appendChild(leaf.containerEl);     // 挂进日记行；chrome 用 CSS 隐藏
view.setViewData(body, true);
if (view.editMode.sourceMode) (view.editMode as any).toggleSource();  // 强制 Live Preview
// 隐藏非编辑表面：.view-header、.inline-title、.metadata-container、模式按钮
```

卸载序列：

```ts
await view.close();                        // 公开：unload + onClose（save 已被覆盖为空）
(leaf as any).resizeObserver?.disconnect();
leaf.containerEl.detach();
// leaf 无 parent、workspace 无引用，随 GC 回收；history 栈从未被写入
```

- 正文/frontmatter 分离：`setViewData(body)` 只喂正文；`getViewData()` 返回当前正文交给 controller 的
  `replaceDiaryBody` + baseline 冲突控制（沿用 `entry.ts` 现有逻辑，不改动）。
- 原生表面保留：Live Preview 渲染、fold、行号/缩进参考线、cm search、`editorSuggest`、内部悬浮预览（hover-link
  事件 source="editor"，targetEl 在内嵌 DOM 内，正常弹 HoverPopover）。
- 明确舍弃：Properties 编辑器（对 body-only 数据为空，直接隐藏 `.metadata-container` 与 `.inline-title`）；
  阅读视图模式（隐藏模式按钮，只允许 source/LP）。

## 7. 最小型验证原型

### 7.1 搭建步骤（不动 diary-feed 代码，另建一次性测试插件）

1. `npm i -D obsidian@1.14.4`（与 diary-feed 相同类型包）；esbuild 同构打包。
2. 命令 `Open detached MarkdownView sandbox`：开一个 Modal，内部放一个容器。
3. 步骤 A（隔离性）：按 §6 装配，正文用当前打开日记的 body（复用 `getDiaryBody` 逻辑现抄到测试插件）。
   断言脚本：监听并计数 `workspace.on("active-leaf-change")`、`workspace.on("file-open")`、`workspace.on("layout-change")`，
   在内嵌编辑器点击/输入/失焦各 10 次，计数必须为零；`document.querySelectorAll(".workspace-tab-header").length`
   前后不变（无新 tab）。
4. 步骤 B（保存接管）：内嵌编辑后 `app.vault.read(file)` 必须保持 frontmatter 逐字节不变；
   制造外部修改（`vault.modify` 追加内容）→ controller 冲突 UI 路径被触发而非原生合并通知（`msgFileChanged`）。
5. 步骤 C（链接行为）：内嵌正文放 `[[另一篇]]`，普通点击 → 新 tab 打开、日记流 leaf 不变（activeLeaf 引用前后一致）。
6. 步骤 D（生命周期）：反复创建/销毁 50 次，`performance.memory`（或活动监听器计数代理：对比
   `getEventListeners` 不可用，改用 `workspace` 内部 `_events` 数组长度差）无泄漏；切换主题、切换 livePreview 配置、
   窗口 resize 不报错。
7. 步骤 E（虚拟滚动集成评估）：模拟 diary-feed 的行复用——同一时刻最多 1 个编辑实例；
   `finishEditing` 走 §6 卸载序列；快速滚动触发 detach 时不丢未保存内容（controller flush 先行）。

### 7.2 验证通过标准

- §7.1 步骤 A–E 全绿；
- `iterateAllLeaves` 枚举不到内嵌 leaf；`workspace.getLeavesOfType("markdown")` 不含它；
- 编辑全程 `file-open` 零触发；关闭 Obsidian 前布局 JSON（`.obsidian/workspace.json`）不含任何残留状态。

### 7.3 对照实验（可选）

用 `workspace.getLeaf("tab").setViewState({type:"markdown",state:{file:...}})` 打开同一文件，
对比 `editor-change` 事件参数形态，确认内嵌视图事件与真实 tab 一致（用于评估第三方插件兼容性）。

### 7.4 停止条件（命中任一回退自研 CM6 / 方案 B）

1. 内嵌 leaf 在任何交互后出现在真实布局、tab 条或 `workspace.json`；
2. `active-leaf-change`/`file-open` 被污染（步骤 A 计数非零）；
3. 任何路径绕过 controller 直接写盘（frontmatter 被改写或丢失）；
4. `new LeafCtor(app)` 在当前或升级后的 Obsidian 上抛错/签名变化（内部 API 失效）；
5. 内存随创建/销毁轮次单调增长（cm/监听器泄漏）；
6. 移动端 drawer 分支出现明显异常（原型按桌面验证，移动端默认禁用）。

## 8. 无法消除的风险（诚实清单）

| 风险 | 性质 | 缓解 |
|---|---|---|
| `LeafCtor` 私有构造器 | 【运行时】跨版本可能改名/改签名 | 构造失败静默回退自研 CM6（步骤 7.4-4） |
| 全局 `editor-change`/`activeEditor` 污染 | 【运行时】无开关 | 文档化；内嵌视图 focus 时 `workspace.activeEditor` 指向它，第三方 `editorCallback` 命令会作用于内嵌编辑器——与真实 tab 行为一致，可接受 |
| 每实例一套完整 CodeMirror + 全部扩展 | 【公开】架构事实 | 虚拟滚动下严格"每文件最多一个编辑实例"，阅读态继续用 MarkdownRenderer |
| properties/inline-title 不可用 | 模型代价（body-only） | 已隐藏；属性编辑仍走"打开原文件" |
| 全局扩展快照不热更 | 【运行时】 | 打开编辑实例时重建视图（现状本来如此） |
| `MarkdownEditView` d.ts 声明公开但 1.15.1 未导出 | d.ts/运行时不一致 | 不依赖；只用 MarkdownView 本体 |
| blur 原生"失焦即存"语义被覆盖 | 行为差异 | 由 controller 的 flush 时机替代，需在 UI 上保持"失焦保存"体感 |

## 9. 附：关键证据索引

| 结论 | 位置 |
|---|---|
| View 构造器注入 leaf DOM、open/close | app.js ~1144867（`es`） |
| ItemView header/content | app.js ~1146536（`Nt`） |
| WorkspaceLeaf 构造器（激活监听、空视图、tabHeader） | app.js ~1389354（`Lt`） |
| History 类 pushState/go | app.js ~1387000（`Q9`） |
| setViewState / recordHistory / openFile | app.js ~1392000–1401500 |
| FileView（navigation=true、setState 强制 history/layout、loadFile、onDelete） | app.js ~1355652（`kn`） |
| TextFileView（requestSave/save/vault.modify/onModify/onUnloadFile） | app.js ~2441889（`Ia`） |
| MarkdownView（构造器、onload、setState、setMode、setViewData、get path、triggerClickableToken） | app.js ~2668431（`lt`） |
| K3 source 模式基类（cm 即建、focus/blur 处理器、toggleSource） | app.js ~2239747、~2244200、~2250515 |
| Nx/rw onUpdate（editor-change、requestSave） | app.js ~2260271、~2266200 |
| 链接代理 Dv | app.js ~1817424 |
| Workspace（createLeaf*、setActiveLeaf、isAttached、activeLeafEvents、onQuickPreview、iterateCodeMirrors 空实现、pushUndoHistory、updateOptions） | app.js ~2539322–2556200（`Mw`） |
| WorkspaceItem（getRoot/getContainer/detach） | app.js ~1363465（`Zh`） |
| Component.addChild 级联 load | app.js ~797432（`Se`） |
| 导出表（MarkdownView/WorkspaceLeaf 等公开符号全表；无 MarkdownEditView） | app.js ~2414707 |
| WorkspaceLeaf 无公开构造器；FileView/TextFileView/MarkdownView 构造器公开 | 本地 d.ts ~11200、~4663、~9849、~6141 |
| `createLeafInParent` 公开 | 本地 d.ts ~10763 |
| `Editor` 抽象不可实例化 | 本地 d.ts ~3652 |
| `MarkdownEditView` 声明公开 | 本地 d.ts ~5765；上游 master d.ts ~5771 |
