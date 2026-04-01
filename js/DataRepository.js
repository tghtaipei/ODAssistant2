/**
 * @fileoverview Repository for CSV-based application data (legislators, groups).
 *
 * Parses raw CSV strings, exposes typed query methods, and persists to
 * IndexedDB via the `db` module.
 *
 * CSV formats:
 *  - `legislators.csv` — one legislator name per line, no header.
 *  - `groups.csv`      — `組別,議員姓名` header row, then data rows.
 *
 * Data is stored in IndexedDB under the DATA store using the keys
 * `'legislators'` and `'groups'`.
 */

import { get, put, STORES } from './db.js';

/** IndexedDB keys for each data type. */
const KEY_LEGISLATORS = 'legislators';
const KEY_GROUPS       = 'groups';

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
     * Map from legislator name → group string (e.g. `'第3組'`).
     * @private
     * @type {Map<string, string>}
     */
    this._groups = new Map();
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
    ]);
  }

  // ---------------------------------------------------------------------------
  // CSV loading
  // ---------------------------------------------------------------------------

  /**
   * Parse a `legislators.csv` string and replace the in-memory roster.
   *
   * Expected format: one legislator name per line, no header row.
   * Empty lines are ignored.
   *
   * @param {string} csvContent - Raw CSV text.
   * @returns {Promise<void>}
   */
  async loadLegislatorsCSV(csvContent) {
    this._legislators = this._parseLegislatorsCsv(csvContent);
    await this.persistLegislators();
  }

  /**
   * Parse a `groups.csv` string and replace the in-memory group mapping.
   *
   * Expected format:
   * ```
   * 組別,議員姓名
   * 第1組,王大明
   * 第1組,李小華
   * 第2組,陳志偉
   * ```
   * The header row is detected by the presence of `組別` or `議員姓名` in the
   * first line and is skipped automatically.
   *
   * @param {string} csvContent - Raw CSV text.
   * @returns {Promise<void>}
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
   * Return the group string for a legislator, or `null` if unknown.
   *
   * @param {string} name - Name only, without the `議員` suffix.
   * @returns {string|null} A string like `'第3組'`, or `null`.
   */
  getLegislatorGroup(name) {
    return this._groups.get((name ?? '').trim()) ?? null;
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
   * Return all groups with their associated legislators.
   *
   * Groups are ordered by their numeric suffix; legislators within each group
   * are in insertion order (preserving the original CSV order).
   *
   * @returns {GroupEntry[]}
   */
  getAllGroups() {
    /** @type {Map<string, string[]>} group → legislators */
    const byGroup = new Map();

    for (const [legislator, group] of this._groups) {
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(legislator);
    }

    // Sort groups numerically by the digit(s) embedded in the group name.
    return [...byGroup.entries()]
      .sort(([a], [b]) => {
        const numA = parseInt((a.match(/\d+/) ?? ['0'])[0], 10);
        const numB = parseInt((b.match(/\d+/) ?? ['0'])[0], 10);
        return numA - numB;
      })
      .map(([group, legislators]) => ({ group, legislators }));
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
   * @returns {Promise<void>}
   */
  async persistGroups() {
    // Serialise the Map as an array of [name, group] pairs.
    await put(STORES.DATA, {
      id: KEY_GROUPS,
      payload: [...this._groups.entries()],
    });
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
   * Load groups from IndexedDB (stored as an array of [name, group] pairs).
   * @private
   */
  async _loadGroupsFromDB() {
    try {
      const record = await get(STORES.DATA, KEY_GROUPS);
      if (!record?.payload) return;

      const payload = record.payload;

      if (Array.isArray(payload)) {
        // Stored as array of [legislatorName, groupString] pairs.
        this._groups = new Map(payload.filter(
          (entry) => Array.isArray(entry) && entry.length >= 2
        ));
      }
    } catch (err) {
      console.error('[DataRepository] 載入組別資料失敗：', err);
    }
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
