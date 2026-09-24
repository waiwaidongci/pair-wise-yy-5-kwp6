/*
 * 界面交互层：负责把工作区状态画到排版台上，并把师傅的操作转给状态层。
 * 不直接碰 localStorage（那是存档层的事），也不直接改已提交版本（冻结在状态层）。
 */
const UI = (() => {
  let active = 1;            // 当前选中的色线
  let block = "dot";         // 当前纹样块：dot / cross / diamond
  let dragging = false;
  let viewingVersionId = null; // 正在查看的已提交版本（只读弹层）
  let message = null;        // { type: "ok"|"err", text }

  const $ = sel => document.querySelector(sel);
  const el = {};
  const COLORS = Workspace.colors();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  /* ---------- 初始化 ---------- */
  function init() {
    el.cols = $("#cols"); el.rows = $("#rows");
    el.palette = $("#palette"); el.grid = $("#grid");
    el.stats = $("#stats"); el.preview = $("#preview"); el.risk = $("#risk");
    el.undoBtn = $("#undoBtn"); el.redoBtn = $("#redoBtn");
    el.verName = $("#verName"); el.verNote = $("#verNote"); el.submitBtn = $("#submitBtn");
    el.draftMeta = $("#draftMeta"); el.versionList = $("#versionList");
    el.message = $("#message");
    el.modal = $("#versionModal"); el.modalBody = $("#modalBody");

    // 静态控件只绑一次
    $("#newBtn").onclick = onNewGrid;
    el.undoBtn.onclick = () => { clearMessage(); Workspace.undo(); };
    el.redoBtn.onclick = () => { clearMessage(); Workspace.redo(); };
    $("#exportBtn").onclick = onExport;
    el.submitBtn.onclick = onSubmit;
    document.querySelectorAll("[data-block]").forEach(btn => {
      btn.onclick = () => { block = btn.dataset.block; renderBlocks(); };
    });
    el.grid.addEventListener("pointerdown", e => {
      const cell = e.target.closest(".cell");
      if (!cell) return;
      dragging = true;
      clearMessage();
      Workspace.paint(Number(cell.dataset.i), active, block);
    });
    el.grid.addEventListener("pointerenter", e => {
      const cell = e.target.closest(".cell");
      if (dragging && cell) Workspace.paint(Number(cell.dataset.i), active, block);
    }, true);
    window.addEventListener("pointerup", () => { dragging = false; });

    el.versionList.addEventListener("click", onVersionAction);
    el.modal.addEventListener("click", e => {
      if (e.target === el.modal || e.target.closest("#modalClose")) closeModal();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

    Workspace.subscribe(render);
  }

  function boot() {
    const stored = Archive.load();
    if (stored && !stored.error) {
      Workspace.init(stored);
    } else {
      // 首次使用：把旧版单稿迁成一份工作稿，不丢师傅之前画的东西
      Workspace.init(Archive.loadLegacyDraft());
    }
    persist();
    Workspace.subscribe(persist);
    init();
    Workspace.emit();
  }

  /* 任何状态变化后由订阅触发，存档层负责落盘 */
  function persist() {
    const s = Workspace.get();
    Archive.save({
      cols: s.cols, rows: s.rows, cells: s.cells,
      basedOnId: s.basedOnId, nextSeq: s.nextSeq,
      versions: s.versions.map(v => ({
        id: v.id, seq: v.seq, name: v.name, note: v.note,
        cols: v.cols, rows: v.rows, cells: v.cells, usage: v.usage,
        submittedAt: v.submittedAt, basedOnId: v.basedOnId
      }))
    });
  }

  function flash(type, text) {
    message = { type, text };
    renderMessage();
  }
  function clearMessage() { if (message) { message = null; renderMessage(); } }

  /* ---------- 操作 ---------- */
  function onNewGrid() {
    const s = Workspace.get();
    if (Workspace.isDirty() &&
        !confirm("当前工作稿有未提交的修改，新建网格会丢弃这些改动。确定新建吗？")) return;
    clearMessage();
    Workspace.newGrid(el.cols.value, el.rows.value);
    flash("ok", "已新建空白网格，之前的未提交改动已清空。");
  }

  function onSubmit() {
    const result = Workspace.submitProof(el.verName.value, el.verNote.value);
    if (!result.ok) {
      flash("err", result.reason); // 重名 / 无名：说明原因并拒绝
      return;
    }
    el.verName.value = "";
    el.verNote.value = "";
    flash("ok", `已提交并冻结「${result.version.name}」（第 ${result.version.seq} 版）。` +
                "工作稿仍可继续编辑，不会改动这份存档。");
  }

  function onVersionAction(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.closest("[data-id]").dataset.id;
    const v = Workspace.getVersion(id);
    if (!v) return;

    if (btn.dataset.action === "view") openModal(v);
    if (btn.dataset.action === "start") {
      if (Workspace.isDirty() &&
          !confirm("当前工作稿有未提交的修改，从旧版本开始会覆盖工作稿。确定继续吗？")) return;
      const result = Workspace.startFromVersion(id);
      if (result.ok) {
        closeModal();
        flash("ok", `已从「${v.name}」（第 ${v.seq} 版）复制出一份新工作稿，旧版本保持不变。`);
      } else {
        flash("err", result.reason);
      }
    }
  }

  function onExport() {
    const s = Workspace.get();
    Archive.downloadJSON("brocade-pattern-workspace.json", {
      exportedAt: new Date().toISOString(),
      draft: {
        cols: s.cols, rows: s.rows, cells: s.cells,
        basedOnId: s.basedOnId,
        basedOnName: s.basedOnId ? (Workspace.getVersion(s.basedOnId) || {}).name : null,
        usage: Workspace.usage()
      },
      versions: s.versions.map(v => ({
        seq: v.seq, name: v.name, note: v.note,
        cols: v.cols, rows: v.rows, cells: v.cells, usage: v.usage,
        submittedAt: new Date(v.submittedAt).toISOString(),
        basedOnName: v.basedOnId ? (Workspace.getVersion(v.basedOnId) || {}).name : null
      }))
    });
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const s = Workspace.get();
    // 正在输入时不回填，避免打断改列数/行数
    if (document.activeElement !== el.cols) el.cols.value = s.cols;
    if (document.activeElement !== el.rows) el.rows.value = s.rows;
    el.undoBtn.disabled = !Workspace.canUndo();
    el.redoBtn.disabled = !Workspace.canRedo();
    renderPalette();
    renderBlocks();
    renderGrid();
    renderStats(s);
    renderDraftMeta(s);
    renderVersions(s);
    renderMessage();
  }

  function renderPalette() {
    el.palette.innerHTML = COLORS.map((c, i) =>
      `<button type="button" class="swatch ${i === active ? "active" : ""}" data-color="${i}" style="background:${c}" title="色线${i}"></button>`
    ).join("");
    el.palette.querySelectorAll("[data-color]").forEach(sw => {
      sw.onclick = () => { active = Number(sw.dataset.color); renderPalette(); };
    });
  }

  function renderBlocks() {
    document.querySelectorAll("[data-block]").forEach(btn => {
      btn.classList.toggle("active-tool", btn.dataset.block === block);
    });
  }

  function renderGrid() {
    const s = Workspace.get();
    el.grid.style.gridTemplateColumns = `repeat(${s.cols}, 1fr)`;
    el.grid.innerHTML = s.cells.map((v, i) =>
      `<div class="cell" data-i="${i}" style="background:${COLORS[v]}"></div>`).join("");
  }

  function usageRows(usage) {
    return usage.map(u =>
      `<div class="stat"><span><span class="dot" style="background:${u.color}"></span> ${esc(u.color)}</span><b>${u.count}</b></div>`
    ).join("");
  }

  function renderStats(s) {
    el.stats.innerHTML = usageRows(Workspace.usage());

    // 重复单元预览（6×6 左上角，越界留空）
    let mini = "";
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
      const i = y * s.cols + x;
      mini += `<div class="mini" style="background:${x < s.cols && y < s.rows ? COLORS[s.cells[i]] : "#eee2cf"}"></div>`;
    }
    el.preview.innerHTML = mini;

    const riskRows = [];
    for (let y = 0; y < s.rows; y++) {
      let switches = 0;
      for (let x = 1; x < s.cols; x++) if (s.cells[y*s.cols+x] !== s.cells[y*s.cols+x-1]) switches++;
      if (switches > s.cols * .62) riskRows.push(y + 1);
    }
    el.risk.innerHTML = riskRows.length
      ? `<p class="warning">第${riskRows.join("、")}行换色过密，可能断线。</p>`
      : `<p>暂无明显断线风险。</p>`;
  }

  function renderDraftMeta(s) {
    const dirty = Workspace.isDirty();
    let origin, cleanText;
    if (s.basedOnId) {
      const base = Workspace.getVersion(s.basedOnId);
      origin = base
        ? `源自 <b>第 ${base.seq} 版「${esc(base.name)}」</b>，已在此基础上另起工作稿`
        : "来源版本已不在存档中";
      cleanText = "与该版一致";
    } else {
      origin = "全新工作稿，尚未基于任何已提交版本";
      cleanText = "空白新稿";
    }
    el.draftMeta.innerHTML =
      `<span class="meta-origin">${origin}</span>` +
      `<span class="badge ${dirty ? "badge-dirty" : "badge-clean"}">${dirty ? "有未提交修改" : cleanText}</span>`;
  }

  function renderVersions(s) {
    if (!s.versions.length) {
      el.versionList.innerHTML = `<p class="empty">还没有提交过打样。填好名称和备注后点“提交打样”，就会冻结当前网格、色线用量和备注。</p>`;
      return;
    }
    // 最新提交排在最上面，但每张卡都带提交序号，顺序不会乱
    const list = s.versions.slice().sort((a, b) => b.seq - a.seq);
    el.versionList.innerHTML = list.map(v => {
      const parent = v.basedOnId ? Workspace.getVersion(v.basedOnId) : null;
      return `
      <article class="vcard ${v.id === viewingVersionId ? "viewing" : ""}" data-id="${v.id}">
        <div class="vcard-head">
          <span class="seq">第 ${v.seq} 版</span>
          <span class="vname">${esc(v.name)}</span>
          <span class="vtime">${Workspace.formatTime(v.submittedAt)}</span>
        </div>
        ${v.note ? `<p class="vnote">${esc(v.note)}</p>` : `<p class="vnote muted">（无备注）</p>`}
        <div class="vmeta">
          ${v.cols}×${v.rows} 网格 · 共 ${v.cells.length} 格
          ${parent ? ` · 从第 ${parent.seq} 版「${esc(parent.name)}」起稿` : ""}
        </div>
        <div class="vusage">
          ${v.usage.filter(u => u.count > 0).map(u =>
            `<span class="chip"><span class="dot" style="background:${u.color}"></span>${u.count}</span>`).join("")}
        </div>
        <div class="vactions">
          <button type="button" class="secondary" data-action="view">查看冻结稿</button>
          <button type="button" class="secondary" data-action="start">从此版开始</button>
        </div>
      </article>`;
    }).join("");
  }

  /* ---------- 只读弹层：查看冻结版本 ---------- */
  function openModal(v) {
    viewingVersionId = v.id;
    renderVersions(Workspace.get());
    el.modalBody.innerHTML = `
      <div class="modal-head">
        <h3>第 ${v.seq} 版「${esc(v.name)}」<small>${Workspace.formatTime(v.submittedAt)} 冻结</small></h3>
        <button type="button" id="modalClose" class="secondary">关闭</button>
      </div>
      ${v.note ? `<p class="vnote">${esc(v.note)}</p>` : `<p class="vnote muted">（无备注）</p>`}
      <div class="frozen-grid" style="grid-template-columns:repeat(${v.cols},1fr)">
        ${v.cells.map(c => `<div class="mini frozen" style="background:${COLORS[c]}"></div>`).join("")}
      </div>
      <h4>提交时色线用量快照</h4>
      <div class="stats frozen-stats">${usageRows(v.usage)}</div>`;
    el.modal.classList.add("open");
  }

  function closeModal() {
    el.modal.classList.remove("open");
    viewingVersionId = null;
    renderVersions(Workspace.get());
  }

  function renderMessage() {
    if (!message) { el.message.textContent = ""; el.message.className = "message"; return; }
    el.message.textContent = message.text;
    el.message.className = "message " + (message.type === "ok" ? "msg-ok" : "msg-err");
  }

  document.addEventListener("DOMContentLoaded", boot);

  return { boot };
})();
