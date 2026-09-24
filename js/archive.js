/*
 * 存档层：负责工作区数据的持久化、旧稿迁移与导出。
 * 不关心纹样怎么编辑，只负责把状态对象完整写入 / 读出 localStorage。
 */
const Archive = (() => {
  const KEY = "zfl31Workspace"; // 版本化工作区存档
  const LEGACY_KEY = "zfl31Pattern"; // 旧版“随时会变”的单稿存档

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "null");
    } catch (err) {
      // 存档损坏时不直接吞掉，交给上层按空工作区处理
      return { error: String(err && err.message || err) };
    }
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function loadLegacyDraft() {
    try {
      return JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    } catch (err) {
      return null;
    }
  }

  function downloadJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return { KEY, LEGACY_KEY, load, save, loadLegacyDraft, downloadJSON };
})();
