/*
 * 状态管理层：维护“一份工作稿 + 一串已提交版本”。
 *
 * 不变量：
 *  - 提交（submitProof）时深拷贝网格、色线用量、备注，冻结成版本；
 *    之后工作稿怎么改都碰不到已提交内容。
 *  - 版本按提交先后分配递增序号 seq，版本顺序永久保留。
 *  - 从旧版本开始（startFromVersion）只把该版快照复制成一份新的工作稿，
 *    并记下来源版本；旧版本本身保持不变。
 *  - 同名提交一律拒绝，由调用方把原因展示给师傅。
 */
const Workspace = (() => {
  const COLORS = ["#f7e7c4","#a6322d","#1f5f78","#d6a437","#355b38","#713d7b","#1e1b18","#e98c52"];
  const MAX_HISTORY = 50;
  const MIN_DIM = 6, MAX_COLS = 36, MAX_ROWS = 32;

  let state = create();
  const listeners = new Set();

  function create() {
    return {
      cols: 18,
      rows: 14,
      cells: new Array(18 * 14).fill(0),
      versions: [], // 已提交打样，顺序即提交顺序
      nextSeq: 1,
      basedOnId: null, // 工作稿来源版本；全新稿为 null
      undoStack: [],
      redoStack: []
    };
  }

  /* 深拷贝版本快照，避免工作稿与存档互相引用 */
  function copyCells(cells) { return cells.slice(); }

  function pad(n) { return String(n).padStart(2, "0"); }
  function formatTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function computeUsage(cells) {
    return COLORS.map((color, i) => ({ color, count: cells.filter(v => v === i).length }));
  }

  /* 从持久化数据（或旧稿）恢复，校验并补齐字段，防止坏档污染 */
  function normalize(raw) {
    const s = create();
    if (!raw || typeof raw !== "object") return s;

    const cols = Number(raw.cols), rows = Number(raw.rows);
    if (Number.isInteger(cols) && Number.isInteger(rows) &&
        cols >= MIN_DIM && rows >= MIN_DIM && cols <= MAX_COLS && rows <= MAX_ROWS &&
        Array.isArray(raw.cells) && raw.cells.length === cols * rows) {
      s.cols = cols;
      s.rows = rows;
      s.cells = raw.cells.map(v => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n < COLORS.length ? n : 0;
      });
    }

    if (Number.isInteger(raw.nextSeq) && raw.nextSeq >= 1) s.nextSeq = raw.nextSeq;

    if (Array.isArray(raw.versions)) {
      for (const v of raw.versions) {
        if (!v || typeof v !== "object") continue;
        const seq = Number(v.seq);
        const hasGrid = Number.isInteger(Number(v.cols)) && Number.isInteger(Number(v.rows)) &&
                        Array.isArray(v.cells) && v.cells.length === Number(v.cols) * Number(v.rows);
        if (!Number.isInteger(seq) || seq < 1 || typeof v.name !== "string" || !v.name.trim() ||
            !Number.isFinite(Number(v.submittedAt)) || !hasGrid) continue;

        const cells = v.cells.map(x => {
          const n = Number(x);
          return Number.isInteger(n) && n >= 0 && n < COLORS.length ? n : 0;
        });
        let usage = Array.isArray(v.usage) && v.usage.length === COLORS.length
          ? v.usage.map((u, i) => ({ color: COLORS[i], count: Number.isFinite(Number(u && u.count)) ? Number(u.count) : cells.filter(x => x === i).length }))
          : computeUsage(cells);

        const frozen = {
          id: typeof v.id === "string" && v.id ? v.id : `v${seq}-${v.submittedAt}`,
          seq,
          name: v.name,
          note: typeof v.note === "string" ? v.note : "",
          cols: Number(v.cols),
          rows: Number(v.rows),
          cells,
          usage,
          submittedAt: Number(v.submittedAt),
          basedOnId: typeof v.basedOnId === "string" ? v.basedOnId : null
        };
        // 冻结：提交后的内容任何人改不动
        Object.freeze(frozen.cells);
        Object.freeze(frozen.usage);
        Object.freeze(frozen);
        s.versions.push(frozen);
      }
      s.versions.sort((a, b) => a.seq - b.seq);
      s.nextSeq = Math.max(s.nextSeq, ...s.versions.map(v => v.seq + 1), 1);
    }

    if (s.versions.some(v => v.id === raw.basedOnId)) s.basedOnId = raw.basedOnId;
    return s;
  }

  function emit() { listeners.forEach(fn => fn(state)); }

  /* ---------- 查询 ---------- */
  const get = () => state;
  const colors = () => COLORS;
  const limits = () => ({ MIN_DIM, MAX_COLS, MAX_ROWS });
  const usage = () => computeUsage(state.cells);
  const getVersion = id => state.versions.find(v => v.id === id) || null;
  const canUndo = () => state.undoStack.length > 0;
  const canRedo = () => state.redoStack.length > 0;

  function isDirty() {
    const base = state.basedOnId ? getVersion(state.basedOnId) : null;
    if (!base) return state.cells.some(v => v !== 0);
    if (base.cols !== state.cols || base.rows !== state.rows) return true;
    return state.cells.some((v, i) => v !== base.cells[i]);
  }

  /* 单点 / 十字 / 菱形的落点计算 */
  function targets(i, block) {
    const cols = state.cols, rows = state.rows;
    const x = i % cols, y = Math.floor(i / cols);
    const idx = (px, py) => (px < 0 || px >= cols || py < 0 || py >= rows ? null : py * cols + px);
    if (block === "cross") return [i, idx(x-1,y), idx(x+1,y), idx(x,y-1), idx(x,y+1)].filter(v => v !== null);
    if (block === "diamond") return [idx(x,y-1), idx(x-1,y), i, idx(x+1,y), idx(x,y+1)].filter(v => v !== null);
    return [i];
  }

  /* ---------- 编辑 ---------- */
  function pushHistory() {
    state.undoStack.push({ cols: state.cols, rows: state.rows, cells: copyCells(state.cells) });
    state.redoStack = [];
    if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
  }

  function paint(i, colorIndex, block) {
    pushHistory();
    targets(i, block).forEach(t => { state.cells[t] = colorIndex; });
    emit();
  }

  function newGrid(cols, rows) {
    const c = Math.max(MIN_DIM, Math.min(MAX_COLS, Math.floor(Number(cols))));
    const r = Math.max(MIN_DIM, Math.min(MAX_ROWS, Math.floor(Number(rows))));
    if (!Number.isInteger(c) || !Number.isInteger(r)) return;
    state.cols = c;
    state.rows = r;
    state.cells = new Array(c * r).fill(0);
    state.basedOnId = null;
    state.undoStack = [];
    state.redoStack = [];
    emit();
  }

  function undo() {
    if (!canUndo()) return;
    state.redoStack.push({ cols: state.cols, rows: state.rows, cells: copyCells(state.cells) });
    const prev = state.undoStack.pop();
    state.cols = prev.cols; state.rows = prev.rows; state.cells = prev.cells;
    emit();
  }

  function redo() {
    if (!canRedo()) return;
    state.undoStack.push({ cols: state.cols, rows: state.rows, cells: copyCells(state.cells) });
    const next = state.redoStack.pop();
    state.cols = next.cols; state.rows = next.rows; state.cells = next.cells;
    emit();
  }

  /* ---------- 提交：冻结一份打样 ---------- */
  function submitProof(name, note) {
    const trimmed = String(name == null ? "" : name).trim();
    if (!trimmed) return { ok: false, reason: "请先填写打样名称，无名版本无法与其它版本区分。" };
    if (state.versions.some(v => v.name === trimmed)) {
      return { ok: false, reason: `名称“${trimmed}”已存在。每版打样必须用不同名称，重名提交会让师傅分不清哪份是哪版，因此拒绝。请换一个名称后再提交。` };
    }

    const seq = state.nextSeq++;
    const frozen = {
      id: `v${seq}-${Date.now()}`,
      seq,
      name: trimmed,
      note: String(note == null ? "" : note).trim(),
      cols: state.cols,
      rows: state.rows,
      cells: copyCells(state.cells),   // 冻结网格
      usage: computeUsage(state.cells), // 冻结色线用量快照
      submittedAt: Date.now(),
      basedOnId: state.basedOnId
    };
    Object.freeze(frozen.cells);
    Object.freeze(frozen.usage);
    Object.freeze(frozen);
    state.versions.push(frozen);
    // 工作稿继续编辑：内容已深拷贝，提交后修改不会影响存档
    state.basedOnId = frozen.id;
    state.undoStack = [];
    state.redoStack = [];
    emit();
    return { ok: true, version: frozen };
  }

  /* ---------- 回溯：从旧版本生成一份新工作稿 ---------- */
  function startFromVersion(id) {
    const v = getVersion(id);
    if (!v) return { ok: false, reason: "找不到该版本，可能存档已被改动。" };
    state.cols = v.cols;
    state.rows = v.rows;
    state.cells = copyCells(v.cells); // 只复制，不改写旧版本
    state.basedOnId = v.id;
    state.undoStack = [];
    state.redoStack = [];
    emit();
    return { ok: true, version: v };
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return {
    init(raw) { state = normalize(raw); },
    initEmpty() { state = create(); },
    subscribe, emit, get, colors, limits, usage, getVersion,
    isDirty, canUndo, canRedo, targets, paint, newGrid, undo, redo,
    submitProof, startFromVersion, computeUsage, formatTime
  };
})();
