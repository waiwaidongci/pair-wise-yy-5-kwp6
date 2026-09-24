/*
 * archive.js —— 织锦排版台「存档」业务文件
 * 职责：已提交版本与工作稿的本地持久化、旧版单稿数据迁移、入档数据冻结。
 * 不依赖 DOM / 状态逻辑，storage 可注入，便于直接在 Node 中验证。
 */
(function (global) {
  "use strict";

  const STORE_KEY = "zfl31BrocadeArchive.v1";
  const LEGACY_KEY = "zfl31Pattern"; // 旧版单稿存档，仅用于一次性迁移

  function emptyArchive() {
    return { versions: [], draft: null };
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (value && typeof value === "object") {
      Object.keys(value).forEach(function (k) { deepFreeze(value[k]); });
      Object.freeze(value);
    }
    return value;
  }

  // 存档损坏时的兜底：只按格子重建用量快照（颜色十六进制未知，留空）
  function usageFromCells(cells) {
    const totals = new Map();
    cells.forEach(function (v) { totals.set(v, (totals.get(v) || 0) + 1); });
    return Array.from(totals.entries())
      .sort(function (a, b) { return a[0] - b[0]; })
      .map(function ([index, count]) { return { index: index, color: null, count: count }; });
  }

  function asCellArray(cells, length) {
    if (!Array.isArray(cells)) return null;
    const out = cells.slice(0, length).map(Number);
    while (out.length < length) out.push(0);
    return out.map(function (n) { return Number.isFinite(n) ? n : 0; });
  }

  function normalizeVersion(raw, seq) {
    const cols = Number(raw.cols);
    const rows = Number(raw.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return null;
    const cells = asCellArray(raw.cells, cols * rows);
    if (!cells) return null;
    const usage = Array.isArray(raw.usage) && raw.usage.length
      ? raw.usage.map(function (u) {
          return { index: Number(u.index), color: u.color || null, count: Number(u.count) || 0 };
        })
      : usageFromCells(cells);
    return {
      id: String(raw.id || "ver-" + seq),
      seq: seq,
      name: String(raw.name == null ? "" : raw.name),
      createdAt: String(raw.createdAt || ""),
      cols: cols,
      rows: rows,
      cells: cells,
      notes: String(raw.notes || ""),
      basedOn: raw.basedOn ? String(raw.basedOn) : null,
      usage: usage
    };
  }

  function normalize(raw) {
    const versions = (Array.isArray(raw.versions) ? raw.versions : [])
      .map(function (v, i) { return normalizeVersion(v, i + 1); })
      .filter(Boolean)
      // seq 永远等于提交顺序，重排后也不留空洞
      .map(function (v, i) {
        v.seq = i + 1;
        return deepFreeze(v);
      });

    let draft = null;
    const d = raw.draft;
    if (d && Number.isFinite(+d.cols) && Number.isFinite(+d.rows) && Array.isArray(d.cells)
        && d.cells.length === (+d.cols) * (+d.rows)) {
      draft = {
        cols: +d.cols,
        rows: +d.rows,
        cells: d.cells.map(Number),
        notes: String(d.notes || ""),
        basedOn: d.basedOn ? String(d.basedOn) : null
      };
    }
    return { versions: versions, draft: draft };
  }

  function defaultStorage() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  // 读取存档；没有新格式时，尝试把旧版「随时会变的单稿」迁成工作稿
  function load(storage) {
    const s = storage || defaultStorage();
    if (!s) return emptyArchive();
    let raw = null;
    try { raw = s.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (raw) {
      try { return normalize(JSON.parse(raw)); } catch (e) { return emptyArchive(); }
    }
    try {
      const legacy = s.getItem(LEGACY_KEY);
      if (legacy) {
        const old = JSON.parse(legacy);
        if (Number.isFinite(+old.cols) && Number.isFinite(+old.rows) && Array.isArray(old.cells)) {
          return {
            versions: [],
            draft: { cols: +old.cols, rows: +old.rows, cells: old.cells.map(Number), notes: "", basedOn: null }
          };
        }
      }
    } catch (e) { /* 旧稿不可读时按空存档启动 */ }
    return emptyArchive();
  }

  function save(archive, storage) {
    const s = storage || defaultStorage();
    if (!s) return { ok: false, reason: "当前环境不支持本地存储" };
    try {
      s.setItem(STORE_KEY, JSON.stringify({ versions: archive.versions, draft: archive.draft }));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "写入本地存储失败：" + (e && e.message ? e.message : e) };
    }
  }

  global.BrocadeArchive = {
    STORE_KEY: STORE_KEY,
    LEGACY_KEY: LEGACY_KEY,
    emptyArchive: emptyArchive,
    clone: clone,
    deepFreeze: deepFreeze,
    normalize: normalize,
    load: load,
    save: save
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
