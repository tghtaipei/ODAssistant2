/**
 * @fileoverview Main application coordinator for ODAssistant2.
 *
 * Bootstraps all modules, wires up the UI, and manages application lifecycle:
 *  1. Register Service Worker
 *  2. Open IndexedDB
 *  3. Initialise DataRepository, TemplateStore, DriveSync, DraftManager,
 *     ValidationEngine, ExportService, EditorUI
 *  4. Background sync from Google Drive
 *  5. Draft restoration / template selection
 *  6. Wire toolbar buttons (儲存草稿, 匯出, 設定)
 */

import { openDB }               from './db.js';
import { parse }                from './DIParser.js';
import { DataRepository }       from './DataRepository.js';
import { TemplateStore }        from './TemplateStore.js';
import { DriveSync }            from './DriveSync.js';
import { DraftManager }         from './DraftManager.js';
import { ExportService }        from './ExportService.js';
import { EditorUI }             from './EditorUI.js';
import { ValidationEngine }     from './validation/ValidationEngine.js';
import { autoFillRecipients, fillProposers } from './RecipientAutoFiller.js';

// ─── Module-level state ──────────────────────────────────────────────────────

/** @type {DataRepository} */
let dataRepo;
/** @type {TemplateStore} */
let templateStore;
/** @type {DriveSync} */
let driveSync;
/** @type {DraftManager} */
let draftManager;
/** @type {ValidationEngine} */
let validationEngine;
/** @type {ExportService} */
let exportService;
/** @type {EditorUI} */
let editorUI;

/** Currently loaded XML document. @type {Document|null} */
let _xmlDoc    = null;
/** Current template filename. @type {string|null} */
let _xmlDecl   = null;
/** Current DOCTYPE string. @type {string|null} */
let _doctype   = null;
/** Current template filename. @type {string|null} */
let _templateFilename = null;
/** 目前文件是否含「等議員提案」尚未填寫（略過後再次提醒）。 */
let _proposerPending = false;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  _boot().catch((err) => {
    console.error('[app] 啟動失敗：', err);
    showNotification('系統啟動失敗：' + err.message, 'error');
  });
});

async function _boot() {
  // 1. Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[app] Service Worker 註冊失敗：', err);
    });
  }

  // 2. IndexedDB
  const db = await openDB();

  // 3. Initialise modules
  dataRepo        = new DataRepository();
  templateStore   = new TemplateStore(db);
  driveSync       = new DriveSync(db);
  draftManager    = new DraftManager(db);
  validationEngine = new ValidationEngine(dataRepo);
  exportService   = new ExportService(validationEngine, null);

  const editorContainer = document.getElementById('editor-container');
  editorUI = new EditorUI(editorContainer);
  editorUI.onChange(() => {
    // Optionally mark as dirty — auto-save handles persistence
  });

  await Promise.all([
    dataRepo.init(),
    templateStore.init(),
  ]);

  // 4. Background sync (uses default URL if not configured)
  _syncInBackground();

  // 5. Check draft and show template selector
  const draft = await draftManager.load();
  openTemplateSelector(draft);

  // 6. Show welcome modal (unless user dismissed it)
  _showWelcomeIfNeeded();

  // 7. Wire toolbar
  _wireToolbar();
}

// ─── Background sync ─────────────────────────────────────────────────────────

async function _syncInBackground() {
  const statusEl = document.getElementById('sync-status');
  if (statusEl) statusEl.textContent = '正在檢查更新...';

  try {
    const result = await driveSync.sync();

    if (result.error) {
      console.warn('[app] 同步警告：', result.error);
      if (statusEl) statusEl.textContent = '同步失敗';
      return;
    }

    if (!result.updated) {
      if (statusEl) statusEl.textContent = '已是最新';
      return;
    }

    // Process sync items (new / updated)
    for (const item of result.items) {
      if (item.type === 'template') {
        await templateStore.saveTemplate({
          filename:     item.filename,
          content:      item.content,
          modifiedTime: item.modifiedTime,
        });
      } else if (item.type === 'memberGroup') {
        await dataRepo.loadMemberGroupCSV(item.content);
      } else if (item.type === 'legislators') {
        await dataRepo.loadLegislatorsCSV(item.content);
      } else if (item.type === 'groups') {
        await dataRepo.loadGroupsCSV(item.content);
      }
    }

    // Remove templates that have been deleted from the remote source
    for (const filename of (result.removed ?? [])) {
      try {
        await templateStore.deleteTemplate(filename);
        console.info(`[app] 已移除已刪除的範本：${filename}`);
      } catch (err) {
        console.warn(`[app] 移除範本 "${filename}" 失敗：`, err);
      }
    }

    const updatedCount = result.items.length;
    const removedCount = (result.removed ?? []).length;

    const parts = [];
    if (updatedCount > 0) parts.push(`已更新 ${updatedCount} 個檔案`);
    if (removedCount > 0) parts.push(`已移除 ${removedCount} 個已刪除的範本`);
    const msg = parts.join('，') || '資料已同步';

    if (statusEl) statusEl.textContent = msg;
    showNotification(msg, 'success');
  } catch (err) {
    console.error('[app] 同步錯誤：', err);
    if (statusEl) statusEl.textContent = '同步錯誤';
  }
}

// ─── Welcome modal ───────────────────────────────────────────────────────────

/** localStorage key that suppresses the welcome modal when set to '1'. */
const LS_WELCOME_DISMISSED = 'odassistant-welcome-dismissed';

/**
 * Show the welcome modal unless the user previously checked "下次不再顯示".
 */
function _showWelcomeIfNeeded() {
  if (localStorage.getItem(LS_WELCOME_DISMISSED) === '1') return;
  const modal = document.getElementById('modal-welcome');
  if (!modal) return;
  modal.classList.add('modal--open');
  modal.removeAttribute('hidden');
}

// ─── Template selection modal ────────────────────────────────────────────────

/**
 * Show the template selector modal.
 * @param {import('./DraftManager.js').DraftRecord|null} draft
 */
export function openTemplateSelector(draft) {
  const modal      = document.getElementById('modal-template');
  const listEl     = document.getElementById('template-list');
  const draftBtnEl = document.getElementById('btn-restore-draft');
  const draftInfoEl = document.getElementById('draft-info');

  if (!modal || !listEl) return;

  // Clear previous list
  listEl.innerHTML = '';

  // Show draft restore option if a draft exists
  if (draft && draftBtnEl && draftInfoEl) {
    const savedDate = new Date(draft.savedAt).toLocaleString('zh-TW');
    draftInfoEl.textContent = `上次儲存：${savedDate} — 範本：${draft.templateFilename}`;
    draftBtnEl.style.display = '';
    draftBtnEl.onclick = () => {
      _loadFromDraft(draft);
      _closeModal(modal);
    };
  } else if (draftBtnEl) {
    draftBtnEl.style.display = 'none';
  }

  // Populate template list
  const templates = templateStore.getList();

  if (templates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'template-list__empty';
    empty.textContent = '尚無可用範本。請先點選「⚙️ 設定」填入範本資料夾網址，再重新整理頁面。';
    listEl.appendChild(empty);
  } else {
    templates.forEach(({ filename }) => {
      const btn = document.createElement('button');
      btn.className   = 'template-list__item';
      btn.type        = 'button';
      btn.textContent = templateStore.getDisplayName(filename);
      btn.title       = filename;
      btn.addEventListener('click', async () => {
        await _loadTemplate(filename);
        _closeModal(modal);
      });
      listEl.appendChild(btn);
    });
  }

  modal.classList.add('modal--open');
  modal.removeAttribute('hidden');
}

// ─── Settings modal ───────────────────────────────────────────────────────────

/**
 * Show the settings modal.
 */
export async function openSettings() {
  const modal = document.getElementById('modal-settings');
  if (!modal) return;

  const config = await driveSync.getConfig();
  const baseUrlInput = /** @type {HTMLInputElement|null} */ (document.getElementById('settings-base-url'));

  // Show current effective URL (stored value or default)
  if (baseUrlInput) baseUrlInput.value = config.baseUrl;

  modal.classList.add('modal--open');
  modal.removeAttribute('hidden');
}

// ─── Notification toast ───────────────────────────────────────────────────────

/**
 * Show a temporary toast notification.
 *
 * @param {string} message
 * @param {'success'|'error'|'info'|'warning'} [type='info']
 */
export function showNotification(message, type = 'info') {
  const container = document.getElementById('notifications') ?? _createNotificationContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', 'alert');
  toast.textContent = message;

  container.appendChild(toast);

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.classList.add('toast--hide');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 4000);
}

function _createNotificationContainer() {
  const div = document.createElement('div');
  div.id = 'notifications';
  document.body.appendChild(div);
  return div;
}

// ─── Validation modal ─────────────────────────────────────────────────────────

/**
 * Show the validation warnings modal.
 *
 * @param {import('./validation/ValidatorBase.js').ValidationResult[]} warnings
 * @param {Function} onConfirm  - Called when the user clicks "仍要匯出".
 */
/**
 * @param {import('./validation/ValidatorBase.js').ValidationResult[]} warnings
 * @param {()=>void} onConfirm
 * @param {{ confirmLabel?: string }} [opts]
 */
export function showValidationModal(warnings, onConfirm, opts = {}) {
  const { confirmLabel = '仍要匯出' } = opts;
  const modal   = document.getElementById('modal-validation');
  const listEl  = document.getElementById('validation-list');
  const confirmBtn = document.getElementById('btn-validation-confirm');
  const cancelBtn  = document.getElementById('btn-validation-cancel');

  if (!modal || !listEl) {
    // Fallback if modal HTML is missing
    const hasErrors = warnings.some((w) => w.level === 'error');
    if (!hasErrors && confirm('驗證發現警告，仍要繼續？\n\n' + warnings.map((w) => w.message).join('\n'))) {
      onConfirm();
    }
    return;
  }

  listEl.innerHTML = '';

  const hasErrors = warnings.some((w) => w.level === 'error');

  warnings.forEach((w) => {
    const item = document.createElement('li');
    item.className = `validation-item validation-item--${w.level ?? 'warning'}`;
    item.textContent = w.field ? `[${w.field}] ${w.message}` : w.message;
    listEl.appendChild(item);
  });

  if (confirmBtn) {
    confirmBtn.disabled = hasErrors;
    confirmBtn.textContent = hasErrors ? '無法繼續（請修正錯誤）' : confirmLabel;
    confirmBtn.onclick = () => {
      _closeModal(modal);
      onConfirm();
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = () => _closeModal(modal);
  }

  modal.classList.add('modal--open');
  modal.removeAttribute('hidden');
}

// ─── Load helpers ─────────────────────────────────────────────────────────────

async function _loadTemplate(filename) {
  try {
    const content = await templateStore.getContent(filename);
    const { xmlDecl, doctype, xmlDoc } = parse(content);

    _xmlDoc           = xmlDoc;
    _xmlDecl          = xmlDecl;
    _doctype          = doctype;
    _templateFilename = filename;

    editorUI.render(xmlDoc);
    document.getElementById('welcome-screen')?.style.setProperty('display', 'none');
    draftManager.stopAutoSave();
    draftManager.startAutoSave(() => _getEditorState());

    _proposerPending = false;  // reset; _checkProposerModal may set it true
    _updateDocumentTitle(filename);
    showNotification(`已載入範本：${templateStore.getDisplayName(filename)}`, 'success');
    _checkProposerModal(xmlDoc);
  } catch (err) {
    console.error('[app] 載入範本失敗：', err);
    showNotification(`載入範本失敗：${err.message}`, 'error');
  }
}

async function _loadFromDraft(draft) {
  try {
    const { xmlDecl, doctype, xmlDoc } = parse(draft.xmlContent);

    _xmlDoc           = xmlDoc;
    _xmlDecl          = xmlDecl;
    _doctype          = doctype;
    _templateFilename = draft.templateFilename;

    editorUI.render(xmlDoc);
    document.getElementById('welcome-screen')?.style.setProperty('display', 'none');
    draftManager.stopAutoSave();
    draftManager.startAutoSave(() => _getEditorState());

    _proposerPending = false;
    _updateDocumentTitle(draft.templateFilename);
    const savedDate = new Date(draft.savedAt).toLocaleString('zh-TW');
    showNotification(`已還原草稿（${savedDate}）`, 'success');
  } catch (err) {
    console.error('[app] 草稿還原失敗：', err);
    showNotification(`草稿還原失敗：${err.message}`, 'error');
  }
}

// ─── Toolbar wiring ───────────────────────────────────────────────────────────

function _wireToolbar() {
  // 儲存草稿
  const saveDraftBtn = document.getElementById('btn-save-draft');
  if (saveDraftBtn) {
    saveDraftBtn.addEventListener('click', async () => {
      const doc = editorUI.getDocument();
      if (!doc || !_templateFilename) {
        showNotification('請先開啟或選擇一個範本', 'warning');
        return;
      }

      // ── 等議員提案：若尚未填寫，先彈出 modal 再繼續 ────────────
      if (_proposerPending) await _awaitProposerModal(doc);

      // ── 自動填入副本受文者 ─────────────────────────────────────
      const fillResult = autoFillRecipients(doc, dataRepo);

      if (fillResult.failed) {
        showNotification(fillResult.reason, 'warning');
      } else if (!fillResult.skipped) {
        editorUI.render(doc);
        showNotification(fillResult.reason, 'success');
      }

      // ── 檢核並儲存草稿 ────────────────────────────────────────
      const caseType = templateStore.getCaseType(_templateFilename);
      let findings = [];
      try {
        findings = await validationEngine.validate(doc, caseType);
      } catch (err) {
        console.warn('[app] 儲存草稿時檢核失敗：', err);
      }

      if (findings.length > 0) {
        showValidationModal(findings, _doSaveDraft, { confirmLabel: '仍要儲存' });
      } else {
        await _doSaveDraft();
      }
    });
  }

  // 匯出
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const doc = editorUI.getDocument();
      if (!doc || !_templateFilename) {
        showNotification('請先開啟或選擇一個範本', 'warning');
        return;
      }

      // ── 等議員提案：若尚未填寫，先彈出 modal 再繼續（略過仍允許匯出）──
      if (_proposerPending) await _awaitProposerModal(doc);

      // ── 自動填入副本受文者（同儲存草稿邏輯）────────────────────
      const fillResult = autoFillRecipients(doc, dataRepo);
      if (fillResult.failed) {
        showNotification(fillResult.reason, 'warning');
      } else if (!fillResult.skipped) {
        editorUI.render(doc);
        showNotification(fillResult.reason, 'success');
      }

      // ── 匯出前自動儲存草稿 ─────────────────────────────────────
      try {
        const state = _getEditorState();
        if (state) await draftManager.save(state.templateFilename, state.xmlContent);
      } catch (err) {
        console.warn('[app] 匯出前自動儲存失敗：', err);
      }

      // ── 執行驗證並匯出 ─────────────────────────────────────────
      const caseType = templateStore.getCaseType(_templateFilename);
      const filename = _templateFilename.replace(/\.di$/i, '_export.di');

      try {
        const prep = await exportService.prepareExport(
          doc, _doctype ?? '', _xmlDecl ?? '', caseType, filename
        );

        if (prep.warnings.length === 0) {
          prep.proceed();
          showNotification('文件已匯出', 'success');
        } else {
          showValidationModal(prep.warnings, () => {
            prep.proceed();
            showNotification('文件已匯出', 'success');
          });
        }
      } catch (err) {
        showNotification(`匯出失敗：${err.message}`, 'error');
      }
    });
  }

  // 設定
  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => openSettings());
  }

  // 選擇範本
  const templateBtn = document.getElementById('btn-select-template');
  if (templateBtn) {
    templateBtn.addEventListener('click', async () => {
      const draft = await draftManager.load();
      openTemplateSelector(draft);
    });
  }

  // Settings form save
  const saveSettingsBtn = document.getElementById('btn-save-settings');
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async () => {
      const baseUrlInput = /** @type {HTMLInputElement|null} */ (document.getElementById('settings-base-url'));
      const baseUrl = baseUrlInput?.value?.trim() ?? '';
      try {
        await driveSync.saveConfig(baseUrl);
        showNotification('設定已儲存', 'success');
        const modal = document.getElementById('modal-settings');
        if (modal) _closeModal(modal);
        // Trigger sync with new config
        _syncInBackground();
      } catch (err) {
        showNotification(`設定儲存失敗：${err.message}`, 'error');
      }
    });
  }

  // Welcome modal — "開始使用" button
  const welcomeCloseBtn = document.getElementById('btn-welcome-close');
  if (welcomeCloseBtn) {
    welcomeCloseBtn.addEventListener('click', () => {
      const chk = /** @type {HTMLInputElement|null} */ (document.getElementById('chk-welcome-dismiss'));
      if (chk?.checked) {
        localStorage.setItem(LS_WELCOME_DISMISSED, '1');
      }
      const modal = document.getElementById('modal-welcome');
      if (modal) _closeModal(modal);
    });
  }

  // Modal close buttons (data-close-modal attribute)
  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.dataset.closeModal) {
      const modal = document.getElementById(target.dataset.closeModal);
      if (modal) _closeModal(modal);
    }
    // Click outside modal content closes it
    if (target.classList.contains('modal')) {
      _closeModal(target);
    }
  });

  // Keyboard ESC closes open modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal--open').forEach((m) => _closeModal(/** @type {HTMLElement} */(m)));
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 執行草稿儲存並顯示通知（供儲存草稿流程直接呼叫或作為 modal 確認的 callback）。 */
async function _doSaveDraft() {
  try {
    const state = _getEditorState();
    if (!state) return;
    await draftManager.save(state.templateFilename, state.xmlContent);
    showNotification('草稿已儲存', 'success');
  } catch (err) {
    showNotification(`草稿儲存失敗：${err.message}`, 'error');
  }
}

function _getEditorState() {
  const doc = editorUI?.getDocument();
  if (!doc || !_templateFilename) return null;

  const serialiser = new XMLSerializer();
  let xmlContent   = serialiser.serializeToString(doc);
  xmlContent       = xmlContent.replace(/^<\?xml[^?]*\?>\s*/i, '');
  const parts = [];
  if (_xmlDecl)  parts.push(_xmlDecl);
  if (_doctype)  parts.push(_doctype);
  parts.push(xmlContent);

  return {
    templateFilename: _templateFilename,
    xmlContent:       parts.join('\n'),
  };
}

function _updateDocumentTitle(filename) {
  const titleEl = document.getElementById('document-title');
  if (titleEl) {
    titleEl.textContent = templateStore.getDisplayName(filename);
  }
  document.title = `${templateStore.getDisplayName(filename)} — 公文寫作輔助系統`;
}

/**
 * 關閉 modal。若 modal 上掛有 `_onclose` 回呼（來自 _awaitProposerModal），
 * 關閉後立即觸發，確保 await 在所有關閉路徑（略過、✕、Escape、backdrop）都能 resolve。
 * @param {HTMLElement} modal
 */
function _closeModal(modal) {
  modal.classList.remove('modal--open');
  modal.setAttribute('hidden', '');
  if (typeof (/** @type {any} */ (modal))._onclose === 'function') {
    const cb = /** @type {any} */ (modal)._onclose;
    /** @type {any} */ (modal)._onclose = null;
    cb();
  }
}

// ─── 等議員提案 modal ─────────────────────────────────────────────────────────

/**
 * 載入範本後，若主旨含「等議員提案」，設定提醒旗標並開啟 modal。
 * @param {Document} xmlDoc
 */
function _checkProposerModal(xmlDoc) {
  const wenziEl = xmlDoc.getElementsByTagName('主旨')[0]
    ?.getElementsByTagName('文字')[0];
  if (!wenziEl) return;
  if (!(wenziEl.textContent ?? '').includes('等議員提案')) return;
  _proposerPending = true;
  _openProposerModal(xmlDoc);
}

/**
 * 以 Promise 包裝 _openProposerModal，供 save/export 流程 await 使用。
 * modal 關閉（無論確認或略過）後 Promise resolve。
 * @param {Document} xmlDoc
 * @returns {Promise<void>}
 */
function _awaitProposerModal(xmlDoc) {
  return new Promise(resolve => _openProposerModal(xmlDoc, resolve));
}

/**
 * 開啟提案議員名單輸入 modal，並掛載互動邏輯。
 * @param {Document}       xmlDoc
 * @param {(()=>void)|null} [afterClose] - modal 關閉後呼叫（確認或略過皆觸發）。
 */
function _openProposerModal(xmlDoc, afterClose = null) {
  const modal      = document.getElementById('modal-proposers');
  const listEl     = document.getElementById('proposers-list');
  const addBtn     = document.getElementById('btn-proposers-add');
  const confirmBtn = document.getElementById('btn-proposers-confirm');
  if (!modal || !listEl || !addBtn || !confirmBtn) {
    afterClose?.();
    return;
  }

  // 每次開啟都重設，避免殘留前次資料
  listEl.innerHTML = '';
  _addProposerRow(listEl, true);   // 第一列：必填、無刪除鍵

  addBtn.onclick = () => _addProposerRow(listEl, false);

  confirmBtn.onclick = () => {
    const inputs = /** @type {NodeListOf<HTMLInputElement>} */ (
      listEl.querySelectorAll('input.proposer-input')
    );
    const names = Array.from(inputs)
      .map(inp => inp.value.trim())
      .filter(n => n.length > 0);

    // 至少需要一個名字
    if (names.length === 0) {
      inputs[0]?.focus();
      return;
    }

    _proposerPending = false;   // 已成功填寫，清除提醒旗標
    const result = fillProposers(xmlDoc, names);
    editorUI.render(xmlDoc);
    _closeModal(modal);         // 此處觸發 _onclose → afterClose?.()
    showNotification(result.reason, result.ok ? 'success' : 'warning');
  };

  // 掛載 afterClose，_closeModal 關閉時自動呼叫（含略過、✕、Escape、backdrop）
  /** @type {any} */ (modal)._onclose = afterClose;

  modal.classList.add('modal--open');
  modal.removeAttribute('hidden');
  listEl.querySelector('input')?.focus();
}

/**
 * 動態新增一列議員姓名輸入欄。
 * @param {HTMLElement} listEl  - #proposers-list 容器
 * @param {boolean}     isFirst - 是否為第一列（必填、無刪除按鈕）
 */
function _addProposerRow(listEl, isFirst) {
  const row = document.createElement('div');
  row.className = 'proposer-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'proposer-input';
  input.placeholder = isFirst ? '提案議員姓名（必填）' : '議員姓名';
  input.setAttribute('autocomplete', 'off');
  row.appendChild(input);

  if (!isFirst) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove';
    removeBtn.title = '移除';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(removeBtn);
  }

  listEl.appendChild(row);
  if (!isFirst) input.focus();
}
