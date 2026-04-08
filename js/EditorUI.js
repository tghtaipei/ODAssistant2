/**
 * @fileoverview Renders and manages the DI document editor.
 *
 * The editor reflects the full DI XML structure as an interactive HTML form.
 * All edits directly mutate the live XML DOM document, so the caller can
 * serialise it at any time without extra synchronisation.
 *
 * Visual sections:
 *  1. 基本資訊 — 檔號, 保存年限, 函類別, 速別, 密等, 發文日期, 發文字號
 *  2. 機關資訊 — 發文機關, 地址, 聯絡方式 (repeatable), 受文者
 *  3. 主旨      — large textarea
 *  4. 說明      — paragraph with repeatable 條列 items
 *  5. 正本      — repeatable recipient list
 *  6. 副本      — repeatable recipient list
 *  7. 其他      — 稿面註記, 附件, 署名
 */

// ─── Section ID constants ───────────────────────────────────────────────────

const SEC = {
  BASIC:       'editor-sec-basic',
  AGENCY:      'editor-sec-agency',
  SUBJECT:     'editor-sec-subject',
  EXPLANATION: 'editor-sec-explanation',
  ZHENGBEN:    'editor-sec-zhengben',
  FUBEN:       'editor-sec-fuben',
  OTHERS:      'editor-sec-others',
};

// ─── CSS class names used throughout ────────────────────────────────────────

const CLS = {
  SECTION:        'editor-section',
  SECTION_TITLE:  'editor-section__title',
  FIELD:          'editor-field',
  LABEL:          'editor-field__label',
  INPUT:          'editor-field__input',
  TEXTAREA:       'editor-field__textarea',
  LIST:           'editor-list',
  LIST_ITEM:      'editor-list__item',
  BTN_ADD:        'editor-btn editor-btn--add',
  BTN_REMOVE:     'editor-btn editor-btn--remove',
  RECIPIENT_CARD: 'editor-recipient-card',
  NESTED:         'editor-nested',
};

// ─── Helper: create element with optional class / text ──────────────────────

/**
 * @param {string}   tag
 * @param {string}   [cls]
 * @param {string}   [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ─── Main class ─────────────────────────────────────────────────────────────

export class EditorUI {
  /**
   * @param {HTMLElement} containerEl - The DOM element that hosts the editor.
   */
  constructor(containerEl) {
    /** @type {HTMLElement} @private */
    this._container = containerEl;

    /** @type {Document|null} @private */
    this._xmlDoc = null;

    /**
     * Maps an XML Element to its primary bound <input>/<textarea>.
     * Used to detect which XML node an input controls.
     * @private
     * @type {WeakMap<Element, HTMLElement>}
     */
    this._nodeToInput = new WeakMap();

    /** @private @type {Function|null} */
    this._onChange = null;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Render the XML document as an editable form.
   *
   * @param {Document} xmlDoc
   */
  render(xmlDoc) {
    this._xmlDoc = xmlDoc;
    this._container.innerHTML = '';

    const rootEl = xmlDoc.documentElement; // <函>

    this._renderSubject(this._container, rootEl);
    this._renderExplanation(this._container, rootEl);
    this._renderRecipients(this._container, rootEl, '副本');
  }

  /**
   * Return the live XML document (all edits are already applied in-place).
   *
   * @returns {Document|null}
   */
  getDocument() {
    return this._xmlDoc;
  }

  /**
   * Register a callback that is invoked whenever the user edits any field.
   *
   * @param {Function} fn
   */
  onChange(fn) {
    this._onChange = fn;
  }

  // ─── Section renderers ────────────────────────────────────────────────────

  /**
   * Section 1: 基本資訊
   * @private
   */
  _renderBasicInfo(container, rootEl) {
    const sec = this._makeSection(container, '基本資訊', SEC.BASIC);

    // 檔號
    this._appendField(sec, '檔號', this._createBoundTextInput(
      this._getOrCreate(rootEl, '檔號')
    ));

    // 保存年限
    this._appendField(sec, '保存年限', this._createBoundTextInput(
      this._getOrCreate(rootEl, '保存年限')
    ));

    // 函類別 — attribute 代碼 on self-closing element
    const hanLeiEl = this._getOrCreate(rootEl, '函類別');
    this._appendField(sec, '函類別', this._createBoundAttrInput(hanLeiEl, '代碼'));

    // 速別 — attribute 代碼
    const subieEl = this._getOrCreate(rootEl, '速別');
    this._appendField(sec, '速別', this._createBoundAttrInput(subieEl, '代碼'));

    // 密等
    const midengParent = this._getOrCreate(rootEl, '密等及解密條件或保密期限');
    const midengEl = this._getOrCreate(midengParent, '密等');
    this._appendField(sec, '密等', this._createBoundTextInput(midengEl));

    // 解密條件或保密期限
    const jieEl = this._getOrCreate(midengParent, '解密條件或保密期限');
    this._appendField(sec, '解密條件或保密期限', this._createBoundTextInput(jieEl));

    // 發文日期 → 年月日
    const fwrqEl = this._getOrCreate(rootEl, '發文日期');
    const ymEl   = this._getOrCreate(fwrqEl, '年月日');
    this._appendField(sec, '發文日期（年月日）', this._createBoundTextInput(ymEl));

    // 發文字號
    const fwzhEl = this._getOrCreate(rootEl, '發文字號');
    const ziEl   = this._getOrCreate(fwzhEl, '字');
    this._appendField(sec, '發文字號（字）', this._createBoundTextInput(ziEl));

    const wenHaoEl  = this._getOrCreate(fwzhEl, '文號');
    const niandoEl  = this._getOrCreate(wenHaoEl, '年度');
    const liushuiEl = this._getOrCreate(wenHaoEl, '流水號');
    const zhihaoEl  = this._getOrCreate(wenHaoEl, '支號');

    this._appendField(sec, '年度', this._createBoundTextInput(niandoEl));
    this._appendField(sec, '流水號', this._createBoundTextInput(liushuiEl));
    this._appendField(sec, '支號', this._createBoundTextInput(zhihaoEl));
  }

  /**
   * Section 2: 機關資訊
   * @private
   */
  _renderAgencyInfo(container, rootEl) {
    const sec = this._makeSection(container, '機關資訊', SEC.AGENCY);

    // 發文機關 → 全銜, 機關代碼
    const fwjgEl  = this._getOrCreate(rootEl, '發文機關');
    const quanxEl = this._getOrCreate(fwjgEl, '全銜');
    const jgdmEl  = this._getOrCreate(fwjgEl, '機關代碼');
    this._appendField(sec, '發文機關全銜', this._createBoundTextInput(quanxEl));
    this._appendField(sec, '機關代碼', this._createBoundTextInput(jgdmEl));

    // 地址
    const dizhiEl = this._getOrCreate(rootEl, '地址');
    this._appendField(sec, '地址', this._createBoundTextInput(dizhiEl));

    // 聯絡方式 (repeatable)
    this._renderContactList(sec, rootEl);

    // 受文者 → 交換表 attribute 交換表單
    const swzEl = this._getOrCreate(rootEl, '受文者');
    const jtEl  = this._getOrCreate(swzEl, '交換表');
    this._appendField(sec, '受文者交換表單', this._createBoundAttrInput(jtEl, '交換表單'));
  }

  /**
   * Render the repeatable 聯絡方式 list.
   * @private
   */
  _renderContactList(sec, rootEl) {
    const listWrapper = el('div', 'editor-list-wrapper');
    const listTitle   = el('div', 'editor-field__label', '聯絡方式');
    listWrapper.appendChild(listTitle);

    const listEl = el('div', CLS.LIST);
    listWrapper.appendChild(listEl);

    // Render existing 聯絡方式 elements
    const existing = Array.from(rootEl.getElementsByTagName('聯絡方式'))
      .filter((e) => e.parentElement === rootEl);

    if (existing.length === 0) {
      // Create one default empty element
      const newEl = this._xmlDoc.createElement('聯絡方式');
      rootEl.appendChild(newEl);
      existing.push(newEl);
    }

    existing.forEach((contactEl) => {
      this._appendContactItem(listEl, rootEl, contactEl);
    });

    // Add button
    const addBtn = el('button', CLS.BTN_ADD, '＋ 新增聯絡方式');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => {
      const newEl = this._xmlDoc.createElement('聯絡方式');
      // Insert before the next non-聯絡方式 sibling or at end
      const lastContact = Array.from(rootEl.getElementsByTagName('聯絡方式'))
        .filter((e) => e.parentElement === rootEl).pop();
      if (lastContact?.nextSibling) {
        rootEl.insertBefore(newEl, lastContact.nextSibling);
      } else {
        rootEl.appendChild(newEl);
      }
      this._appendContactItem(listEl, rootEl, newEl);
      this._notifyChange();
    });
    listWrapper.appendChild(addBtn);

    sec.appendChild(listWrapper);
  }

  /**
   * @private
   */
  _appendContactItem(listEl, rootEl, contactEl) {
    const item = el('div', CLS.LIST_ITEM);
    const input = this._createBoundTextInput(contactEl);
    item.appendChild(input);

    const removeBtn = el('button', CLS.BTN_REMOVE, '✕');
    removeBtn.type  = 'button';
    removeBtn.title = '移除此聯絡方式';
    removeBtn.addEventListener('click', () => {
      rootEl.removeChild(contactEl);
      item.remove();
      this._notifyChange();
    });
    item.appendChild(removeBtn);
    listEl.appendChild(item);
  }

  /**
   * Section 3: 主旨
   * @private
   */
  _renderSubject(container, rootEl) {
    const sec = this._makeSection(container, '主旨', SEC.SUBJECT);

    const zhuZhiEl = this._getOrCreate(rootEl, '主旨');
    const wenziEl  = this._getOrCreate(zhuZhiEl, '文字');

    this._appendField(sec, '主旨內容', this._createBoundTextInput(wenziEl, true));
  }

  /**
   * Section 4: 說明
   * @private
   */
  _renderExplanation(container, rootEl) {
    const sec = this._makeSection(container, '說明', SEC.EXPLANATION);

    // Find the 段落 元素 with 段名="說明："
    let duanEl = null;
    const duanEls = rootEl.getElementsByTagName('段落');
    for (let i = 0; i < duanEls.length; i++) {
      if (duanEls[i].getAttribute('段名')?.includes('說明')) {
        duanEl = duanEls[i];
        break;
      }
    }

    if (!duanEl) {
      // Create one with default attribute
      duanEl = this._xmlDoc.createElement('段落');
      duanEl.setAttribute('段名', '說明：');
      // Insert after 主旨 or append
      const zhuZhiEl = rootEl.getElementsByTagName('主旨')[0];
      if (zhuZhiEl?.nextSibling) {
        rootEl.insertBefore(duanEl, zhuZhiEl.nextSibling);
      } else {
        rootEl.appendChild(duanEl);
      }
    }

    // 段名 attribute input
    this._appendField(sec, '段名', this._createBoundAttrInput(duanEl, '段名'));

    // 文字 inside 段落 (paragraph-level intro text, optional)
    const introWenziEl = Array.from(duanEl.childNodes)
      .find((n) => n.nodeType === Node.ELEMENT_NODE && n.nodeName === '文字');
    if (introWenziEl) {
      this._appendField(sec, '段落說明文字', this._createBoundTextInput(/** @type {Element} */(introWenziEl), true));
    }

    // Repeatable 條列 items
    const itemsLabel = el('div', 'editor-field__label', '條列項目');
    sec.appendChild(itemsLabel);

    const listEl = el('div', CLS.LIST);
    sec.appendChild(listEl);

    // Render existing 條列 items
    const existingItems = Array.from(duanEl.getElementsByTagName('條列'));
    existingItems.forEach((itemEl) => {
      this._appendExplanationItem(listEl, duanEl, itemEl);
    });

    // Add button
    const addBtn = el('button', CLS.BTN_ADD, '＋ 新增條列');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => {
      const count = duanEl.getElementsByTagName('條列').length + 1;
      const newItemEl = this._xmlDoc.createElement('條列');
      // Assign sequence number based on count
      const prefixes = ['一、', '二、', '三、', '四、', '五、', '六、', '七、', '八、', '九、', '十、'];
      newItemEl.setAttribute('序號', prefixes[count - 1] ?? `${count}、`);
      const newWenZi = this._xmlDoc.createElement('文字');
      newItemEl.appendChild(newWenZi);
      duanEl.appendChild(newItemEl);
      this._appendExplanationItem(listEl, duanEl, newItemEl);
      this._notifyChange();
    });
    sec.appendChild(addBtn);
  }

  /**
   * @private
   */
  _appendExplanationItem(listEl, duanEl, itemEl) {
    const item = el('div', CLS.LIST_ITEM + ' editor-list__item--explanation');

    // 序號 attribute
    const seqLabel = el('span', 'editor-list__seq', itemEl.getAttribute('序號') ?? '');
    item.appendChild(seqLabel);

    const wenziEl = this._getOrCreate(itemEl, '文字');
    const textarea = this._createBoundTextInput(wenziEl, true);
    item.appendChild(textarea);

    const removeBtn = el('button', CLS.BTN_REMOVE, '✕');
    removeBtn.type  = 'button';
    removeBtn.title = '移除此條列';
    removeBtn.addEventListener('click', () => {
      duanEl.removeChild(itemEl);
      item.remove();
      this._notifyChange();
    });
    item.appendChild(removeBtn);

    listEl.appendChild(item);
  }

  /**
   * Section 6: 副本（唯讀，受文者由儲存草稿時自動填入）
   * @private
   * @param {HTMLElement} container
   * @param {Element} rootEl
   * @param {string} tagName - 目前僅使用 '副本'
   */
  _renderRecipients(container, rootEl, tagName) {
    const sec = this._makeSection(container, tagName, SEC.FUBEN);

    let parentEl = rootEl.getElementsByTagName(tagName)[0];
    if (!parentEl) {
      parentEl = this._xmlDoc.createElement(tagName);
      rootEl.appendChild(parentEl);
    }

    // 說明文字：不開放手動新增，由系統自動填入
    const note = document.createElement('p');
    note.className = 'editor-section__note';
    note.textContent = '副本受文者將於儲存草稿時依主旨組別自動填入。如有其他特殊之副本受文者，請匯入公文系統後自行手動增加。';
    sec.appendChild(note);

    const listEl = el('div', CLS.LIST);
    sec.appendChild(listEl);

    // 顯示現有 <全銜>（唯讀）
    const existing = Array.from(parentEl.getElementsByTagName('全銜'))
      .filter((e) => e.parentElement === parentEl);

    if (existing.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'editor-section__empty';
      empty.textContent = '（尚未填入，請先完成主旨後儲存草稿）';
      listEl.appendChild(empty);
    } else {
      existing.forEach((recipEl) => {
        this._appendRecipientReadOnly(listEl, recipEl);
      });
    }
    // 無新增按鈕 — 副本由自動填入機制控制
  }

  /**
   * 以唯讀方式呈現一筆副本受文者。
   * @private
   */
  _appendRecipientReadOnly(listEl, recipEl) {
    const item = el('div', CLS.LIST_ITEM);

    // 讀取 <全銜> 的直接文字節點（受文者名稱）
    let nameText = '';
    for (const child of recipEl.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        nameText = (child.nodeValue ?? '').trim();
        break;
      }
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'editor-field__readonly-value';
    nameSpan.textContent = nameText || '（未填寫）';
    item.appendChild(nameSpan);

    listEl.appendChild(item);
  }

  /**
   * Section 7: 其他
   * @private
   */
  _renderOthers(container, rootEl) {
    const sec = this._makeSection(container, '其他', SEC.OTHERS);

    // 稿面註記 → 擬辦方式, 應用限制
    const gaoMianEl   = this._getOrCreate(rootEl, '稿面註記');
    const nibanEl     = this._getOrCreate(gaoMianEl, '擬辦方式');
    const yingyongEl  = this._getOrCreate(gaoMianEl, '應用限制');
    this._appendField(sec, '擬辦方式', this._createBoundTextInput(nibanEl));
    this._appendField(sec, '應用限制', this._createBoundTextInput(yingyongEl));

    // 附件 → 文字
    const fujianEl  = this._getOrCreate(rootEl, '附件');
    const fujianWzEl = this._getOrCreate(fujianEl, '文字');
    this._appendField(sec, '附件', this._createBoundTextInput(fujianWzEl));

    // 署名 (self-closing, no content — just display info)
    const shuMingEl = rootEl.getElementsByTagName('署名')[0];
    const shuMingNote = el('div', 'editor-field');
    const shuMingLabel = el('label', CLS.LABEL, '署名');
    const shuMingInfo  = el('span', 'editor-field__info',
      shuMingEl ? '（已存在，自動處理）' : '（不存在）'
    );
    shuMingNote.appendChild(shuMingLabel);
    shuMingNote.appendChild(shuMingInfo);
    sec.appendChild(shuMingNote);
  }

  // ─── Private building helpers ─────────────────────────────────────────────

  /**
   * Create a section wrapper and append it to `container`.
   * @private
   * @param {HTMLElement} container
   * @param {string} title
   * @param {string} id
   * @returns {HTMLElement} The section's content area.
   */
  _makeSection(container, title, id) {
    const section  = el('section', CLS.SECTION);
    section.id     = id;
    const heading  = el('h2', CLS.SECTION_TITLE, title);
    section.appendChild(heading);
    container.appendChild(section);
    return section;
  }

  /**
   * Wrap a label + input element together and append to a parent.
   * @private
   */
  _appendField(parent, labelText, inputEl) {
    const wrapper = el('div', CLS.FIELD);
    const label   = el('label', CLS.LABEL, labelText);

    // Associate label with input if input has an id; otherwise generate one.
    if (!inputEl.id) {
      inputEl.id = `field-${Math.random().toString(36).slice(2, 9)}`;
    }
    label.htmlFor = inputEl.id;

    wrapper.appendChild(label);
    wrapper.appendChild(inputEl);
    parent.appendChild(wrapper);
    return wrapper;
  }

  /**
   * Create an `<input>` bound to the **direct text node** of `xmlElement`.
   *
   * Unlike `_createBoundTextInput` which uses `textContent` (includes all
   * descendant text), this method reads and writes only the first TEXT_NODE
   * child of `xmlElement`.
   *
   * Example: `<全銜 發文方式="紙本">臺北市議會○○議員<傳送方式/></全銜>`
   *   → reads/writes "臺北市議會○○議員" only.
   *
   * @private
   * @param {Element} xmlElement
   * @returns {HTMLInputElement}
   */
  _createBoundDirectTextInput(xmlElement) {
    const input = /** @type {HTMLInputElement} */ (document.createElement('input'));
    input.className = CLS.INPUT;
    input.type = 'text';

    // Find or create the direct text node.
    let textNode = null;
    for (const child of xmlElement.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        textNode = child;
        break;
      }
    }
    if (!textNode) {
      textNode = this._xmlDoc.createTextNode('');
      xmlElement.insertBefore(textNode, xmlElement.firstChild);
    }

    input.value = (textNode.nodeValue ?? '').trim();

    input.addEventListener('input', () => {
      textNode.nodeValue = input.value;
      this._notifyChange();
    });

    return input;
  }

  /**
   * Create an `<input>` or `<textarea>` that is two-way bound to the text
   * content of `xmlElement`.
   *
   * @private
   * @param {Element} xmlElement - The XML element whose textContent is edited.
   * @param {boolean} [multiline=false] - Use `<textarea>` instead of `<input>`.
   * @returns {HTMLInputElement|HTMLTextAreaElement}
   */
  _createBoundTextInput(xmlElement, multiline = false) {
    const input = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (
      document.createElement(multiline ? 'textarea' : 'input')
    );

    input.className = multiline ? CLS.TEXTAREA : CLS.INPUT;
    if (!multiline) /** @type {HTMLInputElement} */ (input).type = 'text';

    // Set initial value from the live XML node.
    input.value = (xmlElement.textContent ?? '').trim();

    // On user edit, write back to the XML node.
    input.addEventListener('input', () => {
      xmlElement.textContent = input.value;
      this._notifyChange();
    });

    this._nodeToInput.set(xmlElement, input);
    return input;
  }

  /**
   * Create an `<input>` bound to an attribute of `xmlElement`.
   *
   * @private
   * @param {Element} xmlElement
   * @param {string}  attrName
   * @returns {HTMLInputElement}
   */
  _createBoundAttrInput(xmlElement, attrName) {
    const input = /** @type {HTMLInputElement} */ (document.createElement('input'));
    input.className = CLS.INPUT;
    input.type = 'text';

    input.value = xmlElement.getAttribute(attrName) ?? '';

    input.addEventListener('input', () => {
      xmlElement.setAttribute(attrName, input.value);
      this._notifyChange();
    });

    return input;
  }

  /**
   * Get the first child element with `tagName` inside `parent`, or create and
   * append one if it doesn't exist.
   *
   * @private
   * @param {Element|Document} parent
   * @param {string} tagName
   * @returns {Element}
   */
  _getOrCreate(parent, tagName) {
    const existing = parent instanceof Document
      ? parent.documentElement.getElementsByTagName(tagName)[0]
      : /** @type {Element} */(parent).getElementsByTagName(tagName)[0];

    if (existing && existing.parentElement === (
      parent instanceof Document ? parent.documentElement : parent
    )) {
      return existing;
    }

    // Try direct child lookup first
    const el = parent instanceof Document
      ? parent.documentElement
      : /** @type {Element} */(parent);

    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child.nodeType === Node.ELEMENT_NODE && child.nodeName === tagName) {
        return /** @type {Element} */(child);
      }
    }

    // Not found → create
    const newEl = this._xmlDoc.createElement(tagName);
    el.appendChild(newEl);
    return newEl;
  }

  /**
   * Fire the onChange callback if one is registered.
   * @private
   */
  _notifyChange() {
    if (typeof this._onChange === 'function') {
      try {
        this._onChange();
      } catch (err) {
        console.warn('[EditorUI] onChange callback 執行失敗：', err);
      }
    }
  }
}
