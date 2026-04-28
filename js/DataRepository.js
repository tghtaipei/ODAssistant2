/**
 * @fileoverview Repository for CSV-based application data (legislators, groups).
 *
 * Parses raw CSV strings, exposes typed query methods, and persists to
 * IndexedDB via the `db` module.
 *
 * CSV format (議員分組.csv):
 *   第一列（選填）：會期中繼資料
 *     14,07,20260428,20260616,戴錫欽,葉林傳
 *     欄位：屆期, 會期, 起始日期(YYYYMMDD), 結束日期(YYYYMMDD), 議長, 副議長
 *
 *   後續列：議員分組資料
 *     部門,組別號碼,姓名
 *     警政衛生部門,1,洪健益
 *     警政衛生部門,1,劉耀仁
 *     警政衛生部門,2,應曉薇
 *
 * Data is stored in IndexedDB under the DATA store using the keys
 * `'legislators'`, `'groups'`, and `'sessionMeta'`.
 */

import { get, put, STORES } from './db.js';

/** IndexedDB keys for each data type. */
const KEY_LEGISLATORS  = 'legislators';
const KEY_GROUPS       = 'groups';
const KEY_SESSION_META = 'sessionMeta';

/**
 * 正規表達式：識別 CSV 第一列為會期中繼資料。
 * 格式：屆期,會期,起始日期(8碼),結束日期(8碼),議長,副議長
 * 範例：14,07,20260428,20260616,戴錫欽,葉林傳
 */
const META_ROW_RE = /^(\d+),(\d+),(\d{8}),(\d{8}),([^,]+),([^,]*)$/;

/**
 * @typedef {Object} SessionMeta
 * @property {string} term        - 屆期（如 "14"）
 * @property {string} session     - 會期（如 "07"）
 * @property {string} startDate   - 起始日期 YYYYMMDD（如 "20260428"）
 * @property {string} endDate     - 結束日期 YYYYMMDD（如 "20260616"）
 * @property {string} speaker     - 議長姓名
 * @property {string} viceSpeaker - 副議長姓名
 */

/**
 * @typedef {{ group: string, legislators: string[] }} GroupEntry
 */

/**
 * Manages legislator and group data loaded from CSV files.
 *
 * The in-memory state is backed by:
 *  - `_legislators` — a {@link Set} of legislator name strings for O(1) lookup.
 *  - `_groups`      — a {@link Map} from legislator name → group string
 *                     (e.g. `'第3組'`), enabling fast group lookups.
 */
export class DataRepository {
  /**
   * @param {import('./db.js').IDBDatabase|object} db
   *   The open IndexedDB instance (or the db module — not used directly;
   *   all reads/writes go through the module-level `get`/`put` helpers).
   */
  constructor(db) {
    /** @private */
    this._db = db;

    /**
     * Set of all known legislator names (without the "議員" suffix).
     * @private
     * @type {Set<string>}
     */
    this._legislators = new Set();

    /**
     * 二層 Map：外層 key = 部門/會議類型（如「定期大會」、「警政衛生部門」），
     * 內層 key = 議員姓名，value = 組別（如「第1組」）。
     *
     * 結構：Map<meetingType, Map<name, group>>
     *
     * 同一位議員在不同會議類型可能屬於不同組別，因此以會議類型作為外層索引。
     * @private
     * @type {Map<string, Map<string, string>>}
     */
    this._groups = new Map();

    /**
     * CSV 第一列的會期中繼資料（若存在）。
     * @private
     * @type {SessionMeta|null}
     */
    this._sessionMeta = null;
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /**
   * Load persisted legislators and groups from IndexedDB into memory.
   * Call once at application startup before any query methods.
   *
   * @returns {Promise<void>}
   */
  async init() {
    await Promise.all([
      this._loadLegislatorsFromDB(),
      this._loadGroupsFromDB(),
      this._loadSessionMetaFromDB(),
    ]);
  }

  // ---------------------------------------------------------------------------
  // CSV loading
  // ---------------------------------------------------------------------------

  /**
   * Parse 「議員分組.csv」 and replace the in-memory roster and group mapping.
   *
   * Expected format (no header row):
   * ```
   * 部門,組別號碼,姓名
   * 警政衛生部門,1,洪健益
   * 警政衛生部門,2,應曉薇
   * ```
   * Column 0 = 部門 (ignored), Column 1 = 組別號碼, Column 2 = 姓名
   *
   * @param {string} csvContent - Raw CSV text.
   * @returns {Promise<void>}
   */
  async loadMemberGroupCSV(csvContent) {
    const { legislators, groups, sessionMeta } = this._parseMemberGroupCsv(csvContent);
    this._legislators = legislators;
    this._groups      = groups;
    this._sessionMeta = sessionMeta;
    await Promise.all([
      this.persistLegislators(),
      this.persistGroups(),
      this.persistSessionMeta(),
    ]);
  }

  /**
   * @deprecated 舊格式，保留向下相容。
   * @param {string} csvContent
   */
  async loadLegislatorsCSV(csvContent) {
    this._legislators = this._parseLegislatorsCsv(csvContent);
    await this.persistLegislators();
  }

  /**
   * @deprecated 舊格式，保留向下相容。
   * @param {string} csvContent
   */
  async loadGroupsCSV(csvContent) {
    this._groups = this._parseGroupsCsv(csvContent);
    await this.persistGroups();
  }

  // ---------------------------------------------------------------------------
  // Query API
  // ---------------------------------------------------------------------------

  /**
   * Return `true` if the given legislator name exists in the roster.
   *
   * @param {string} name - Name only, without the `議員` suffix.
   * @returns {boolean}
   */
  hasLegislator(name) {
    return this._legislators.has((name ?? '').trim());
  }

  /**
   * 查詢特定議員在「指定會議類型」下的組別。
   *
   * @param {string} name        - 議員姓名（不含「議員」二字）。
   * @param {string} meetingType - 會議/部門類型，對應 CSV 第一欄（如「定期大會」、「警政衛生部門」）。
   * @returns {string|null} 組別字串（如「第3組」），若查無資料則回傳 null。
   */
  getLegislatorGroupByType(name, meetingType) {
    return this._groups.get(meetingType)?.get((name ?? '').trim()) ?? null;
  }

  /**
   * 取得所有已載入的會議/部門類型清單（即 CSV 第一欄的所有不重複值）。
   * GroupValidator 用此清單在文件主旨中搜尋對應的會議類型。
   *
   * @returns {string[]}
   */
  getAllMeetingTypes() {
    return [...this._groups.keys()];
  }

  /**
   * 取得指定會議類型與組別的所有議員姓名。
   *
   * @param {string} meetingType - 會議/部門類型（CSV 第一欄），如「市政總質詢」。
   * @param {string} groupLabel  - 組別字串，如「第1組」。
   * @returns {string[]} 議員姓名陣列；若查無資料則回傳空陣列。
   */
  getLegislatorsByGroup(meetingType, groupLabel) {
    const typeMap = this._groups.get(meetingType);
    if (!typeMap) return [];
    const result = [];
    for (const [name, grp] of typeMap.entries()) {
      if (grp === groupLabel) result.push(name);
    }
    return result;
  }

  /**
   * Return all known legislator names as a sorted array.
   *
   * @returns {string[]}
   */
  getAllLegislators() {
    return [...this._legislators].sort();
  }

  /**
   * 回傳 CSV 第一列解析出的會期中繼資料，若無則回傳 null。
   *
   * @returns {SessionMeta|null}
   */
  getSessionMeta() {
    return this._sessionMeta;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Save the current in-memory legislator roster to IndexedDB.
   *
   * @returns {Promise<void>}
   */
  async persistLegislators() {
    await put(STORES.DATA, {
      id: KEY_LEGISLATORS,
      payload: [...this._legislators],
    });
  }

  /**
   * Save the current in-memory group mapping to IndexedDB.
   *
   * 序列化格式：Array<[meetingType, Array<[name, group]>]>
   * 例：[["定期大會", [["洪健益","第1組"]]], ["警政衛生部門", [["洪健益","第2組"]]]]
   *
   * @returns {Promise<void>}
   */
  async persistGroups() {
    const payload = [...this._groups.entries()].map(([type, nameMap]) => [
      type,
      [...nameMap.entries()],
    ]);
    await put(STORES.DATA, { id: KEY_GROUPS, payload });
  }

  /**
   * Save the current session metadata to IndexedDB.
   *
   * @returns {Promise<void>}
   */
  async persistSessionMeta() {
    await put(STORES.DATA, { id: KEY_SESSION_META, payload: this._sessionMeta });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load legislators from IndexedDB (stored as a plain string array).
   * @private
   */
  async _loadLegislatorsFromDB() {
    try {
      const record = await get(STORES.DATA, KEY_LEGISLATORS);
      if (!record?.payload) return;

      const payload = record.payload;

      if (Array.isArray(payload)) {
        // Stored as an array of name strings (written by persistLegislators).
        this._legislators = new Set(payload.filter(Boolean));
      } else if (typeof payload === 'string') {
        // Legacy: stored as raw CSV text.
        this._legislators = this._parseLegislatorsCsv(payload);
      }
    } catch (err) {
      console.error('[DataRepository] 載入議員資料失敗：', err);
    }
  }

  /**
   * Load groups from IndexedDB.
   *
   * 支援兩種格式（向下相容）：
   *   新格式：Array<[meetingType, Array<[name, group]>]>  ← persistGroups() 寫入的格式
   *   舊格式：Array<[name, group]>  ← 舊版寫入，自動轉換為 meetingType='(未分類)' 的單一類型
   * @private
   */
  async _loadGroupsFromDB() {
    try {
      const record = await get(STORES.DATA, KEY_GROUPS);
      if (!record?.payload) return;

      const payload = record.payload;
      if (!Array.isArray(payload) || payload.length === 0) return;

      // 判斷是新格式還是舊格式：
      // 新格式：第一個元素的 [1] 也是陣列（e.g. ["定期大會", [...]]）
      // 舊格式：第一個元素是 [name, group] 兩個字串
      const isNewFormat =
        Array.isArray(payload[0]) &&
        Array.isArray(payload[0][1]);

      if (isNewFormat) {
        this._groups = new Map(
          payload.map(([type, pairs]) => [type, new Map(pairs)])
        );
      } else {
        // 舊格式（單層 [[name, group], ...]）：資料來自舊版程式，無法得知會議類型。
        // 直接丟棄；待下次同步重新下載 CSV 後，會以新格式正確儲存。
        console.warn('[DataRepository] 偵測到舊版組別格式，已捨棄，等待重新同步。');
      }
    } catch (err) {
      console.error('[DataRepository] 載入組別資料失敗：', err);
    }
  }

  /**
   * Load session metadata from IndexedDB.
   * @private
   */
  async _loadSessionMetaFromDB() {
    try {
      const record = await get(STORES.DATA, KEY_SESSION_META);
      if (record?.payload) this._sessionMeta = record.payload;
    } catch (err) {
      console.error('[DataRepository] 載入會期資料失敗：', err);
    }
  }

  /**
   * Parse 「議員分組.csv」 content into legislators Set, a two-level groups Map,
   * and optional session metadata from the first row.
   *
   * CSV 格式：
   *   第一列（選填）會期中繼資料：
   *     14,07,20260428,20260616,戴錫欽,葉林傳
   *   後續列：部門/會議類型, 組別號碼, 姓名
   *     定期大會,1,洪健益
   *     警政衛生部門,2,洪健益
   *
   * @private
   * @param {string} csv
   * @returns {{ legislators: Set<string>, groups: Map<string, Map<string, string>>, sessionMeta: SessionMeta|null }}
   */
  _parseMemberGroupCsv(csv) {
    const legislators = new Set();
    /** @type {Map<string, Map<string, string>>} */
    const groups = new Map();
    /** @type {SessionMeta|null} */
    let sessionMeta = null;

    if (!csv) return { legislators, groups, sessionMeta };

    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let startIndex = 0;

    // 偵測第一列是否為會期中繼資料
    if (lines.length > 0) {
      const m = META_ROW_RE.exec(lines[0]);
      if (m) {
        sessionMeta = {
          term:        m[1].trim(),
          session:     m[2].trim(),
          startDate:   m[3].trim(),
          endDate:     m[4].trim(),
          speaker:     m[5].trim(),
          viceSpeaker: m[6].trim(),
        };
        startIndex = 1; // 跳過中繼資料列
      }
    }

    for (let i = startIndex; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      if (cols.length < 3) continue;

      const meetingType = cols[0]; // 部門/會議類型，如「定期大會」、「警政衛生部門」
      const groupNum    = cols[1]; // 組別號碼，如「1」
      const name        = cols[2]; // 議員姓名

      if (!meetingType || !groupNum || !name) continue;

      legislators.add(name);

      if (!groups.has(meetingType)) groups.set(meetingType, new Map());
      groups.get(meetingType).set(name, `第${groupNum}組`);
    }

    return { legislators, groups, sessionMeta };
  }

  /**
   * Parse `legislators.csv` content into a Set of names.
   *
   * Each non-empty, non-whitespace line is treated as one legislator name.
   *
   * @private
   * @param {string} csv
   * @returns {Set<string>}
   */
  _parseLegislatorsCsv(csv) {
    if (!csv) return new Set();
    const names = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return new Set(names);
  }

  /**
   * Parse `groups.csv` content into a Map of legislator name → group string.
   *
   * Expected columns: `組別` (index 0) and `議員姓名` (index 1).
   * The header row (if present) is automatically skipped.
   *
   * @private
   * @param {string} csv
   * @returns {Map<string, string>}
   */
  _parseGroupsCsv(csv) {
    if (!csv) return new Map();

    const lines = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) return new Map();

    // Skip header row if present.
    const firstLine = lines[0];
    const isHeader = firstLine.includes('組別') || firstLine.includes('議員姓名');
    const dataLines = isHeader ? lines.slice(1) : lines;

    /** @type {Map<string, string>} legislatorName → groupString */
    const result = new Map();

    for (const line of dataLines) {
      // Support simple comma-delimited values (no quoted fields needed for this format).
      const cols = line.split(',').map((c) => c.trim());
      const group       = cols[0] ?? '';  // e.g. "第3組"
      const legislator  = cols[1] ?? '';  // e.g. "王大明"

      if (group && legislator) {
        result.set(legislator, group);
      }
    }

    return result;
  }
}
