/**
 * @fileoverview 從公開的遠端資料夾（GitHub raw 或任何支援 CORS 的靜態主機）
 * 同步 DI 範本與 CSV 資料檔，完全不需要 API 金鑰或任何驗證。
 *
 * 同步原理：
 *  1. 從設定的 Base URL 下載 manifest.json
 *  2. 比對每個檔案的 updated 時間戳記與本機快取
 *  3. 下載有變更的檔案（.di 範本、legislators.csv、groups.csv）
 *
 * manifest.json 格式範例（放在 Base URL 對應的資料夾）：
 * ```json
 * {
 *   "files": [
 *     { "name": "8-1_函復議會協調案件.di", "updated": "2025-01-15" },
 *     { "name": "legislators.csv",          "updated": "2025-01-10" },
 *     { "name": "groups.csv",               "updated": "2025-01-10" }
 *   ]
 * }
 * ```
 *
 * 推薦使用 GitHub 公開儲存庫：
 *   Base URL 範例：https://raw.githubusercontent.com/帳號/儲存庫名稱/main/templates
 */

import { get, put, STORES } from './db.js';

/** IndexedDB key for caching sync metadata (last-known updated timestamps). */
const SYNC_META_KEY = 'syncMeta';

/** Settings keys. */
const SETTINGS_BASE_URL = 'syncBaseUrl';

/**
 * @typedef {Object} SyncItemTemplate
 * @property {'template'} type
 * @property {string}     filename
 * @property {string}     content
 * @property {string}     modifiedTime
 */

/**
 * @typedef {Object} SyncItemData
 * @property {'legislators'|'groups'} type
 * @property {string}                 content
 */

/**
 * @typedef {SyncItemTemplate|SyncItemData} SyncItem
 */

/**
 * @typedef {Object} SyncResult
 * @property {boolean}     updated
 * @property {SyncItem[]}  items
 * @property {string|null} error
 */

export class DriveSync {
  /**
   * @param {object} db - Kept for API symmetry; all DB calls use module helpers.
   */
  constructor(db) {
    this._db = db;
  }

  // ---------------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------------

  /**
   * Read sync configuration from IndexedDB settings store.
   *
   * @returns {Promise<{baseUrl: string}|null>} null if not yet configured.
   */
  async getConfig() {
    const record = await get(STORES.SETTINGS, SETTINGS_BASE_URL);
    const baseUrl = (record?.value ?? '').trim().replace(/\/$/, '');
    if (!baseUrl) return null;
    return { baseUrl };
  }

  /**
   * Persist sync configuration.
   *
   * @param {string} baseUrl - Base URL of the remote template folder (no trailing slash).
   */
  async saveConfig(baseUrl) {
    await put(STORES.SETTINGS, {
      id:    SETTINGS_BASE_URL,
      value: baseUrl.trim().replace(/\/$/, ''),
    });
  }

  // ---------------------------------------------------------------------------
  // Remote fetch helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch and parse the manifest.json from the remote folder.
   *
   * @param {string} baseUrl
   * @returns {Promise<Array<{name: string, updated: string}>>}
   */
  async fetchManifest(baseUrl) {
    const url = `${baseUrl}/manifest.json`;
    const resp = await fetch(url, { cache: 'no-cache' });

    if (!resp.ok) {
      throw new Error(`無法下載 manifest.json（${resp.status}）：${url}`);
    }

    const data = await resp.json();

    if (!Array.isArray(data?.files)) {
      throw new Error('manifest.json 格式不正確，需包含 "files" 陣列。');
    }

    return data.files;
  }

  /**
   * Download a single file as text.
   *
   * @param {string} baseUrl
   * @param {string} filename
   * @returns {Promise<string>}
   */
  async fetchFile(baseUrl, filename) {
    const url = `${baseUrl}/${encodeURIComponent(filename)}`;
    const resp = await fetch(url, { cache: 'no-cache' });

    if (!resp.ok) {
      throw new Error(`檔案下載失敗「${filename}」（${resp.status}）`);
    }

    return resp.text();
  }

  // ---------------------------------------------------------------------------
  // Main sync
  // ---------------------------------------------------------------------------

  /**
   * Sync all files from the configured remote folder.
   *
   * @returns {Promise<SyncResult>}
   */
  async sync() {
    /** @type {SyncItem[]} */
    const items = [];

    // 1. Get config — skip silently if not configured yet.
    let config;
    try {
      config = await this.getConfig();
    } catch (err) {
      return { updated: false, items, error: `讀取設定失敗：${err.message}` };
    }

    if (!config) {
      return { updated: false, items, error: null };
    }

    const { baseUrl } = config;

    // 2. Fetch manifest.
    let manifestFiles;
    try {
      manifestFiles = await this.fetchManifest(baseUrl);
    } catch (err) {
      return { updated: false, items, error: err.message };
    }

    // 3. Load existing sync metadata from IndexedDB.
    let syncMeta = {};
    try {
      const metaRecord = await get(STORES.DATA, SYNC_META_KEY);
      syncMeta = metaRecord?.payload ?? {};
    } catch (_) {
      syncMeta = {};
    }

    const updatedMeta = { ...syncMeta };
    let anyUpdated = false;

    // 4. Process each file in the manifest.
    for (const entry of manifestFiles) {
      const { name, updated } = entry;
      if (!name) continue;

      const isDiTemplate  = /\.di$/i.test(name);
      const isLegislators = name.toLowerCase() === 'legislators.csv';
      const isGroups      = name.toLowerCase() === 'groups.csv';

      if (!isDiTemplate && !isLegislators && !isGroups) continue;

      // Skip if unchanged (same updated timestamp as last sync).
      if (syncMeta[name] === updated) continue;

      let content;
      try {
        content = await this.fetchFile(baseUrl, name);
      } catch (err) {
        console.warn(`[DriveSync] 跳過 "${name}"：${err.message}`);
        continue;
      }

      if (isDiTemplate) {
        items.push({ type: 'template', filename: name, content, modifiedTime: updated ?? '' });
      } else if (isLegislators) {
        items.push({ type: 'legislators', content });
      } else if (isGroups) {
        items.push({ type: 'groups', content });
      }

      updatedMeta[name] = updated;
      anyUpdated = true;
    }

    // 5. Persist updated metadata.
    if (anyUpdated) {
      try {
        await put(STORES.DATA, { id: SYNC_META_KEY, payload: updatedMeta });
      } catch (err) {
        console.warn('[DriveSync] syncMeta 寫入失敗：', err);
      }
    }

    return { updated: anyUpdated, items, error: null };
  }
}
