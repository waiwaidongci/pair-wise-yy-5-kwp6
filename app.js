/*
 * app.js —— 织锦排版台「界面交互」业务文件
 * 职责：DOM 渲染与事件。不直接读写 localStorage（走 Archive），
 * 不实现版本规则（走 State.Workspace）。
 */
(function () {
  "use strict";

  const Archive = window.BrocadeArchive;
  const State = window.BrocadeState;
  const colors = State.COLORS;

  // ---------- 载入存档，组装工作区 ----------
  const workspace = new State.Workspace(Archive.load());

  // ---------- DOM 引用 ----------
  const gridEl = document.querySelector("#grid");
  const paletteEl = document.querySelector("#palette");
  const statsEl = document.querySelector("#stats");
  const previewEl = document.querySelector("#preview");
  const riskEl = document.querySelector("#risk");
  const colsInput = document.querySelector("#cols");
  const rowsInput = document.querySelector("#rows");
  const notesInput = document.querySelector("#notes");
  const commitNameInput = document.querySelector("#commitName");
  const statusEl = document.querySelector("#draftStatus");
  const versionsEl = document.querySelector("#versions");
  const messageEl = document.querySelector("#commitMessage");

  let active = 1; // 当前选中的色线
  let block = "dot"; // 当前纹样块
  let dragging = false;
  let strokeDirty = false; // 当前这一笔是否改过格子（抬笔时决定是否落盘）

  function persist() {
    return Archive.save(workspace.toArchive());
  }

  function showMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = "message " + (kind || "info");
  }

  function clearMessage() {
    messageEl.textContent = "";
    messageEl.className = "message";
  }

  // ---------- 色线库 ----------
  function renderPalette() {
    paletteEl.innerHTML = colors.map(function (c, i) {
      return '<button type="button" class="swatch ' + (i === active ? "active" : "") +
        '" data-color="' + i + '" title="色线' + i + '" style="background:' + c + '"></button>';
    }).join("");
  }

  paletteEl.addEventListener("click", function (e) {
    const el = e.target.closest("[data-color]");
    if (!el) return;
    active = Number(el.dataset.color);
    renderPalette();
  });

  // ---------- 纹样块 ----------
  document.querySelectorAll("[data-block]").forEach(function (btn) {
    btn.addEventListener("click", function () { block = btn.dataset.block; });
  });

  // ---------- 网格 ----------
  function renderGrid() {
    const cells = workspace.draft.cells;
    gridEl.style.gridTemplateColumns = "repeat(" + workspace.draft.cols + ", 1fr)";
    gridEl.innerHTML = cells.map(function (v, i) {
      return '<div class="cell" data-i="' + i + '" style="background:' + colors[v] + '"></div>';
    }).join("");
  }

  function paintAt(i) {
    // 整笔走状态层：撤销点只有一个，且只要改过格子就会落盘
    if (workspace.strokeApply(i, active, block)) {
      strokeDirty = true;
      renderGrid();
      renderStats();
      renderStatus();
      renderUndoButtons();
    }
  }

  gridEl.addEventListener("pointerdown", function (e) {
    const el = e.target.closest(".cell");
    if (!el) return;
    dragging = true;
    strokeDirty = false;
    workspace.beginStroke();
    paintAt(Number(el.dataset.i));
    e.preventDefault();
  });
  gridEl.addEventListener("pointerenter", function (e) {
    const el = e.target.closest(".cell");
    if (el && dragging) paintAt(Number(el.dataset.i));
  }, true);
  window.addEventListener("pointerup", function () {
    if (dragging && strokeDirty) persist(); // 一笔结束统一落盘，避免漏存拖动中的改动
    dragging = false;
  });

  // ---------- 用色统计 / 重复单元预览 / 断线风险 ----------
  function renderStats() {
    const cells = workspace.draft.cells;
    const cols = workspace.draft.cols;
    const rows = workspace.draft.rows;
    const usage = State.computeUsage(cells);
    statsEl.innerHTML = usage.map(function (u) {
      return '<div class="stat"><span><span class="dot" style="background:' + u.color + '"></span> 色线' +
        u.index + '</span><b>' + u.count + '</b></div>';
    }).join("");

    // 取前 6×6 作为重复单元预览
    previewEl.innerHTML = Array.from({ length: 36 }, function (_, i) {
      const idx = (i % 6) + Math.floor(i / 6) * cols;
      const v = cells[idx] || 0;
      return '<div class="mini" style="background:' + colors[v] + '"></div>';
    }).join("");

    const riskRows = [];
    for (let y = 0; y < rows; y++) {
      let switches = 0;
      for (let x = 1; x < cols; x++) {
        if (cells[y * cols + x] !== cells[y * cols + x - 1]) switches++;
      }
      if (switches > cols * 0.62) riskRows.push(y + 1);
    }
    riskEl.innerHTML = riskRows.length
      ? '<p class="warning">第' + riskRows.join("、") + '行换色过密，可能断线。</p>'
      : '<p>暂无明显断线风险。</p>';
  }

  // ---------- 撤销 / 重做 / 新建 ----------
  function renderUndoButtons() {
    document.querySelector("#undoBtn").disabled = !workspace.canUndo();
    document.querySelector("#redoBtn").disabled = !workspace.canRedo();
  }

  document.querySelector("#undoBtn").addEventListener("click", function () {
    if (workspace.undo()) { renderGrid(); renderStats(); renderStatus(); renderUndoButtons(); persist(); }
  });
  document.querySelector("#redoBtn").addEventListener("click", function () {
    if (workspace.redo()) { renderGrid(); renderStats(); renderStatus(); renderUndoButtons(); persist(); }
  });

  document.querySelector("#newBtn").addEventListener("click", function () {
    workspace.newGrid(colsInput.value, rowsInput.value);
    colsInput.value = workspace.draft.cols;
    rowsInput.value = workspace.draft.rows;
    notesInput.value = "";
    renderAll();
    persist();
    showMessage("已另起一张空白网格，备注已清空；已提交的版本仍在版本历史中，不会被清掉。", "info");
  });

  // ---------- 备注 ----------
  notesInput.addEventListener("input", function () {
    if (workspace.setNotes(notesInput.value)) {
      renderStatus();
      persist();
    }
  });

  // ---------- 提交打样（冻结当前工作稿） ----------
  document.querySelector("#commitBtn").addEventListener("click", function () {
    const result = workspace.commit(commitNameInput.value);
    if (!result.ok) {
      // 重名 / 空名都在这里给出明确原因，工作稿不动
      showMessage(result.reason, "error");
      commitNameInput.focus();
      return;
    }
    persist();
    commitNameInput.value = "";
    clearMessage();
    renderAll();
    showMessage("已提交为第 " + result.version.seq + " 版「" + result.version.name +
      "」，网格、色线用量与备注均已冻结；继续修改不会影响这一版。", "success");
  });

  // ---------- 版本历史 ----------
  function miniGrid(version) {
    const cols = version.cols;
    return Array.from({ length: 36 }, function (_, i) {
      const idx = (i % 6) + Math.floor(i / 6) * cols;
      const v = version.cells[idx] || 0;
      return '<div class="mini" style="background:' + (colors[v] || "#eee") + '"></div>';
    }).join("");
  }

  function renderVersions() {
    if (!workspace.versions.length) {
      versionsEl.innerHTML = '<p class="hint">还没有提交过版本。填好版本名称点「提交打样」，当前网格就会被冻结存档。</p>';
      return;
    }
    // 最新的排在最上面显示，但 seq 仍代表提交先后
    versionsEl.innerHTML = workspace.versions.slice().reverse().map(function (v) {
      const isBase = workspace.draft.basedOn === v.id;
      const usageRows = v.usage
        .filter(function (u) { return u.count > 0; })
        .map(function (u) {
          const colorHex = u.color || colors[u.index] || "#ccc";
          return '<span class="usage-pill"><span class="dot" style="background:' + colorHex +
            '"></span>色线' + u.index + ' × ' + u.count + '</span>';
        }).join("");
      const baseSeq = v.basedOn ? workspace.seqForId(v.basedOn) : null;
      return '<article class="version' + (isBase ? " current-base" : "") + '">'
        + '<header><span class="vseq">第 ' + v.seq + ' 版</span>'
        + '<strong class="vname">' + escapeHtml(v.name) + '</strong>'
        + (isBase ? '<span class="tag">当前工作稿起点</span>' : '')
        + '<time>' + v.createdAt + '</time></header>'
        + '<div class="vmeta">' + v.cols + ' × ' + v.rows
        + (baseSeq ? ' · 自第 ' + baseSeq + ' 版续作' : '') + '</div>'
        + '<div class="preview frozen-preview">' + miniGrid(v) + '</div>'
        + '<div class="usage">' + usageRows + '</div>'
        + (v.notes ? '<p class="vnotes">' + escapeHtml(v.notes) + '</p>' : '<p class="vnotes empty">（无备注）</p>')
        + '<button type="button" class="secondary fork-btn" data-seq="' + v.seq + '">从此版开始编辑</button>'
        + '</article>';
    }).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  versionsEl.addEventListener("click", function (e) {
    const btn = e.target.closest(".fork-btn");
    if (!btn) return;
    const seq = Number(btn.dataset.seq);
    const v = workspace.getVersionBySeq(seq);
    if (workspace.isDirty()) {
      const ok = window.confirm("当前工作稿有未提交的改动，从第 " + seq + " 版「" + v.name +
        "」开始会替换工作稿内容（已提交的版本不受影响）。确定继续吗？");
      if (!ok) return;
    }
    const result = workspace.forkFromVersion(seq);
    if (!result.ok) { showMessage(result.reason, "error"); return; }
    colsInput.value = workspace.draft.cols;
    rowsInput.value = workspace.draft.rows;
    notesInput.value = workspace.draft.notes;
    persist();
    clearMessage();
    renderAll();
    showMessage("已以第 " + seq + " 版「" + result.source.name + "」为起点生成新工作稿，旧版本原封未动。", "success");
  });

  // ---------- 工作稿状态条 ----------
  function renderStatus() {
    const d = workspace.draft;
    const baseSeq = d.basedOn ? workspace.seqForId(d.basedOn) : null;
    const base = baseSeq
      ? '基于第 ' + baseSeq + ' 版「' + workspace.getVersionBySeq(baseSeq).name + '」'
      : (workspace.versions.length ? '独立工作稿' : '全新工作稿');
    statusEl.textContent = base + ' · ' + d.cols + ' × ' + d.rows +
      (workspace.isDirty() ? ' · 有未提交改动（自动暂存）' : ' · 与起点版本一致');
    statusEl.className = "status " + (workspace.isDirty() ? "dirty" : "clean");
  }

  // ---------- 导出完整存档 ----------
  document.querySelector("#exportBtn").addEventListener("click", function () {
    const data = {
      exportedAt: new Date().toISOString(),
      versions: workspace.versions.map(function (v) {
        return {
          seq: v.seq, name: v.name, createdAt: v.createdAt,
          cols: v.cols, rows: v.rows, cells: v.cells, notes: v.notes,
          basedOnSeq: v.basedOn ? workspace.seqForId(v.basedOn) : null,
          usage: v.usage
        };
      }),
      draft: workspace.draft
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "brocade-versions.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------- 全量渲染 ----------
  function renderAll() {
    renderPalette();
    renderGrid();
    renderStats();
    renderUndoButtons();
    renderVersions();
    renderStatus();
  }

  notesInput.value = workspace.draft.notes;
  colsInput.value = workspace.draft.cols;
  rowsInput.value = workspace.draft.rows;
  renderAll();
})();
