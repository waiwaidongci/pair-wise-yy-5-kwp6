/*
 * state.js —— 织锦排版台「状态管理」业务文件
 * 职责：
 *  - 维护可随时编辑的工作稿（网格 / 备注 / 撤销重做）
 *  - 提交打样：冻结网格、色线用量快照、备注，追加为新版本（已提交内容不可再被改动）
 *  - 从旧版本派生新工作稿（原版本保持不动）
 *  - 拒绝空名称与重名提交
 * 依赖：archive.js（存取与冻结工具）。不依赖 DOM，可直接在 Node 中验证。
 */
(function (global) {
  "use strict";

  const Archive = global.BrocadeArchive;

  // 8 色标准色线库，与界面保持一致；用量快照同时记录颜色，便于存档独立复用
  const COLORS = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437",
                  "#355b38", "#713d7b", "#1e1b18", "#e98c52"];

  function clone(value) { return Archive.clone(value); }

  function blankCells(cols, rows) {
    return Array(Math.max(0, cols * rows)).fill(0);
  }

  // 逐色色线用量快照
  function computeUsage(cells, colors) {
    const palette = colors || COLORS;
    return palette.map(function (color, index) {
      let count = 0;
      for (let i = 0; i < cells.length; i++) if (cells[i] === index) count++;
      return { index: index, color: color, count: count };
    });
  }

  function sameCells(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function makeId() {
    return "v" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function formatTime(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function normalizeSize(value, min, max) {
    let n = Math.floor(Number(value));
    if (!Number.isFinite(n)) n = min;
    return Math.min(max, Math.max(min, n));
  }

  function Workspace(archive) {
    const data = archive || Archive.emptyArchive();
    this.versions = data.versions || [];
    const d = data.draft || { cols: 18, rows: 14, cells: blankCells(18, 14), notes: "", basedOn: null };
    this.draft = {
      cols: d.cols,
      rows: d.rows,
      cells: d.cells.slice(),
      notes: d.notes || "",
      basedOn: d.basedOn || null
    };
    this.undoStack = [];
    this.redoStack = [];
    this._recomputeDirty(); // 工作稿是否相对起点版本（basedOn）有未提交改动
  }

  Workspace.prototype._baseVersion = function () {
    if (!this.draft.basedOn) return null;
    for (let i = 0; i < this.versions.length; i++) {
      if (this.versions[i].id === this.draft.basedOn) return this.versions[i];
    }
    return null;
  };

  // 工作稿是否与起点版本完全一致（网格、尺寸、备注都没动过）
  Workspace.prototype._matchesBase = function () {
    const v = this._baseVersion();
    if (!v) return false;
    return v.cols === this.draft.cols && v.rows === this.draft.rows
      && v.notes === this.draft.notes && sameCells(v.cells, this.draft.cells);
  };

  Workspace.prototype.seqForId = function (id) {
    for (let i = 0; i < this.versions.length; i++) {
      if (this.versions[i].id === id) return i + 1;
    }
    return null;
  };

  Workspace.prototype.getVersionBySeq = function (seq) {
    return this.versions[seq - 1] || null;
  };

  Workspace.prototype._recomputeDirty = function () {
    const base = this._baseVersion();
    if (!base) {
      // 没有起点版本（全新稿）：有任何实质内容就算未提交改动
      this.dirty = this.draft.cells.some(function (v) { return v !== 0; })
        || this.draft.notes !== "";
      return;
    }
    this.dirty = !this._matchesBase();
  };

  Workspace.prototype.isDirty = function () { return this.dirty; };

  function cellIndex(cols, rows, x, y) {
    if (x < 0 || x >= cols || y < 0 || y >= rows) return null;
    return y * cols + x;
  }

  // 基础纹样块相对中心点的落点（dot 单点 / cross 十字 / diamond 小菱形）
  function patternTargets(index, block, cols, rows) {
    const x = index % cols;
    const y = Math.floor(index / cols);
    let points;
    if (block === "cross") points = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
    else if (block === "diamond") points = [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1]];
    else points = [[0, 0]];
    const out = [];
    points.forEach(function ([dx, dy]) {
      const t = cellIndex(cols, rows, x + dx, y + dy);
      if (t !== null && out.indexOf(t) === -1) out.push(t);
    });
    return out;
  };

  Workspace.prototype._pushUndo = function () {
    this.undoStack.push(this.draft.cells.slice());
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  };

  // 一次按下拖动视为一笔：首格落色时记撤销点，后续滑过的格子并入同一点
  Workspace.prototype.paint = function (index, colorIndex, block) {
    this.beginStroke();
    return this.strokeApply(index, colorIndex, block);
  };

  // 一笔开始（pointerdown）；整笔最多产生一个撤销点
  Workspace.prototype.beginStroke = function () {
    this._strokeCheckpoint = false;
  };

  // 落笔 / 拖动画过某个格子：首次真正改色前才压入撤销快照
  Workspace.prototype.strokeApply = function (index, colorIndex, block) {
    if (index < 0 || index >= this.draft.cells.length) return false;
    const targets = patternTargets(index, block, this.draft.cols, this.draft.rows);
    let changed = false;
    targets.forEach(function (t) {
      if (this.draft.cells[t] !== colorIndex) changed = true;
    }, this);
    if (!changed) return false;
    if (!this._strokeCheckpoint) {
      this._pushUndo();
      this._strokeCheckpoint = true;
    }
    targets.forEach(function (t) { this.draft.cells[t] = colorIndex; }, this);
    this._recomputeDirty();
    return true;
  };

  Workspace.prototype.canUndo = function () { return this.undoStack.length > 0; };
  Workspace.prototype.canRedo = function () { return this.redoStack.length > 0; };

  Workspace.prototype.undo = function () {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.draft.cells.slice());
    this.draft.cells = this.undoStack.pop();
    this._recomputeDirty();
    return true;
  };

  Workspace.prototype.redo = function () {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.draft.cells.slice());
    this.draft.cells = this.redoStack.pop();
    this._recomputeDirty();
    return true;
  };

  // 重开空白网格：另起独立稿（不再属于任何旧版本），清空撤销历史
  Workspace.prototype.newGrid = function (cols, rows) {
    const c = normalizeSize(cols, 6, 36);
    const r = normalizeSize(rows, 6, 32);
    this.draft.cols = c;
    this.draft.rows = r;
    this.draft.cells = blankCells(c, r);
    this.draft.notes = "";
    this.draft.basedOn = null;
    this.undoStack = [];
    this.redoStack = [];
    this._recomputeDirty();
  };

  Workspace.prototype.setNotes = function (text) {
    const notes = String(text == null ? "" : text);
    if (notes === this.draft.notes) return false;
    this.draft.notes = notes;
    this._recomputeDirty();
    return true;
  };

  /*
   * 提交打样：把当前工作稿冻结为新版本。
   * 返回 { ok: true, version } 或 { ok: false, reason }。
   * 冻结靠深拷贝 + Object.freeze：工作稿之后再怎么编辑都动不到已提交内容。
   */
  Workspace.prototype.commit = function (name, now) {
    const trimmed = String(name == null ? "" : name).trim();
    if (!trimmed) {
      return { ok: false, reason: "请填写版本名称后再提交，未命名的版本无法与旧配色区分。" };
    }
    if (trimmed.length > 40) {
      return { ok: false, reason: "版本名称请控制在 40 个字以内。" };
    }
    if (this.versions.some(function (v) { return v.name === trimmed; })) {
      return {
        ok: false,
        reason: "已存在名为「" + trimmed + "」的版本。每版必须用不同名称，" +
                "否则恢复旧配色时分不清是哪一稿；请换个名字再提交。"
      };
    }

    const frozenCells = Object.freeze(clone(this.draft.cells));
    // 深拷贝 + 递归冻结：网格、用量快照、备注入档后都不再受工作稿编辑影响
    const version = Archive.deepFreeze({
      id: makeId(),
      seq: this.versions.length + 1, // 版本顺序：新提交一律追加在最后
      name: trimmed,
      createdAt: formatTime(now || new Date()),
      cols: this.draft.cols,
      rows: this.draft.rows,
      cells: frozenCells,
      notes: this.draft.notes,
      basedOn: this.draft.basedOn, // 这版是从哪一版继续编辑出来的
      usage: computeUsage(frozenCells)
    });

    this.versions.push(version); // 冻结对象入数组，数组本身仍可追加后续版本
    // 工作稿继续可编辑，但基线指向刚冻结的这一版
    this.draft.basedOn = version.id;
    this.undoStack = [];
    this.redoStack = [];
    this._recomputeDirty(); // 提交后工作稿与该版完全一致
    return { ok: true, version: version };
  };

  /*
   * 从旧版本开始：以旧版内容为起点生成一份「新的」工作稿，
   * 旧版本原样保留（frozen 也保证它不被改到）。
   */
  Workspace.prototype.forkFromVersion = function (seq) {
    const source = this.getVersionBySeq(seq);
    if (!source) return { ok: false, reason: "找不到第 " + seq + " 版。" };
    this.draft = {
      cols: source.cols,
      rows: source.rows,
      cells: clone(source.cells),
      notes: source.notes,
      basedOn: source.id
    };
    this.undoStack = [];
    this.redoStack = [];
    this._recomputeDirty(); // 派生稿与源版本完全一致
    return { ok: true, source: source };
  };

  // 交给存档层落盘的数据
  Workspace.prototype.toArchive = function () {
    return {
      versions: this.versions,
      draft: {
        cols: this.draft.cols,
        rows: this.draft.rows,
        cells: this.draft.cells,
        notes: this.draft.notes,
        basedOn: this.draft.basedOn
      }
    };
  };

  global.BrocadeState = {
    COLORS: COLORS,
    computeUsage: computeUsage,
    patternTargets: patternTargets,
    Workspace: Workspace
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
