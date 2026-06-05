// ============================================
// LabLib - サイドパネル メインロジック
// ============================================

(() => {
  'use strict';

  // ===========================================
  // ストレージ管理 (圧縮形式)
  // ===========================================
  // chrome.storage.sync は 1キーあたり 8,192 bytes、合計 102,400 bytes の制限がある
  // データを極限まで圧縮するため、以下の形式を採用:
  //
  // papers キー: 論文データの配列
  //   各論文: [id, url, title, [tagIndex1, tagIndex2, ...], savedTimestamp]
  //     - id: 短縮UID (6文字)
  //     - url: 文字列（共通プレフィックスは別途辞書化も可能）
  //     - title: 文字列
  //     - tags: タグインデックスの配列（tags辞書を参照）
  //     - savedTimestamp: Date.now() / 1000 の整数部（秒精度で十分）
  //
  // tags キー: タグ辞書 (インデックス順の文字列配列)
  //   例: ["機械学習", "NLP", "CV", "強化学習"]
  //
  // これにより各論文のタグはインデックス番号で保持され、
  // 同じタグ名の繰り返し保存を回避できる

  const STORAGE_KEY_PAPERS = 'p';
  const STORAGE_KEY_TAGS = 't';

  // 論文配列内のインデックス定数
  const P_ID = 0;
  const P_URL = 1;
  const P_TITLE = 2;
  const P_TAGS = 3;
  const P_TIME = 4;

  /** 6文字の短縮UIDを生成 */
  function generateId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  /** ストレージからデータを読み込む */
  async function loadStorage() {
    const data = await chrome.storage.sync.get([STORAGE_KEY_PAPERS, STORAGE_KEY_TAGS]);
    return {
      papers: data[STORAGE_KEY_PAPERS] || [],
      tags: data[STORAGE_KEY_TAGS] || []
    };
  }

  /** ストレージにデータを保存 */
  async function saveStorage(papers, tags) {
    await chrome.storage.sync.set({
      [STORAGE_KEY_PAPERS]: papers,
      [STORAGE_KEY_TAGS]: tags
    });
  }

  /** 圧縮形式の論文データを展開してオブジェクトにする */
  function expandPaper(compressed, tagDict) {
    return {
      id: compressed[P_ID],
      url: compressed[P_URL],
      title: compressed[P_TITLE],
      tags: (compressed[P_TAGS] || []).map(i => tagDict[i]).filter(Boolean),
      savedAt: (compressed[P_TIME] || 0) * 1000
    };
  }

  /** タグ名からインデックスを取得（なければ追加） */
  function getOrCreateTagIndex(tagName, tagDict) {
    const normalized = tagName.trim();
    if (!normalized) return -1;
    let idx = tagDict.indexOf(normalized);
    if (idx === -1) {
      idx = tagDict.length;
      tagDict.push(normalized);
    }
    return idx;
  }

  /** 使われていないタグをタグ辞書からクリーンアップ */
  function cleanupTags(papers, tags) {
    const usedIndices = new Set();
    papers.forEach(p => {
      (p[P_TAGS] || []).forEach(i => usedIndices.add(i));
    });

    if (usedIndices.size === tags.length) return { papers, tags };

    // 新しいタグ辞書を作成（使用されているもののみ）
    const newTags = [];
    const indexMap = {};
    tags.forEach((tag, oldIdx) => {
      if (usedIndices.has(oldIdx)) {
        indexMap[oldIdx] = newTags.length;
        newTags.push(tag);
      }
    });

    // 論文のタグインデックスを更新
    const newPapers = papers.map(p => {
      const updated = [...p];
      updated[P_TAGS] = (p[P_TAGS] || []).map(i => indexMap[i]).filter(i => i !== undefined);
      return updated;
    });

    return { papers: newPapers, tags: newTags };
  }


  // ===========================================
  // 状態管理
  // ===========================================
  let state = {
    papers: [],    // 圧縮形式の論文配列
    tags: [],      // タグ辞書
    selectedIds: new Set(),
    searchQuery: '',
    detailPaperId: null,
    editingField: null   // 'title' | 'tags' | null
  };


  // ===========================================
  // DOM要素の参照
  // ===========================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    // ヘッダー
    btnSave: $('#btn-save-paper'),
    searchInput: $('#search-input'),
    btnClearSearch: $('#btn-clear-search'),

    // ツールバー
    checkboxSelectAll: $('#checkbox-select-all'),
    selectedCount: $('#selected-count'),
    btnBulkReference: $('#btn-bulk-reference'),
    btnBulkDownload: $('#btn-bulk-download'),
    btnBulkDelete: $('#btn-bulk-delete'),

    // 論文リスト
    paperList: $('#paper-list'),
    emptyState: $('#empty-state'),

    // 保存モーダル
    modalOverlay: $('#modal-overlay'),
    saveUrl: $('#save-url'),
    saveTitle: $('#save-title'),
    saveTags: $('#save-tags'),
    tagInputTags: $('#tag-input-tags'),
    tagSuggestions: $('#tag-suggestions'),
    btnModalClose: $('#btn-modal-close'),
    btnModalCancel: $('#btn-modal-cancel'),
    btnModalSave: $('#btn-modal-save'),

    // 詳細パネル
    detailPanel: $('#detail-panel'),
    btnDetailBack: $('#btn-detail-back'),
    detailTitle: $('#detail-title'),
    detailTitleInput: $('#detail-title-input'),
    btnEditTitle: $('#btn-edit-title'),
    detailTags: $('#detail-tags'),
    detailTagsEdit: $('#detail-tags-edit'),
    detailTagInputTags: $('#detail-tag-input-tags'),
    detailTagInput: $('#detail-tag-input'),
    btnEditTags: $('#btn-edit-tags'),
    detailUrl: $('#detail-url'),
    btnCopyLink: $('#btn-copy-link'),
    btnDownloadPaper: $('#btn-download-paper'),
    btnDeletePaper: $('#btn-delete-paper'),

    // 参考文献モーダル
    referenceOverlay: $('#reference-modal-overlay'),
    referenceOutput: $('#reference-output'),
    btnReferenceClose: $('#btn-reference-close'),
    btnCopyReference: $('#btn-copy-reference'),

    // トースト
    toastContainer: $('#toast-container')
  };


  // ===========================================
  // ユーティリティ
  // ===========================================

  /** 文字列のハッシュ値からHSLカラーを生成する */
  function getTagStyles(tagName) {
    let hash = 0;
    for (let i = 0; i < tagName.length; i++) {
      hash = tagName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    const bg = `hsl(${h}, 70%, 93%)`;
    const text = `hsl(${h}, 75%, 38%)`;
    const border = `hsl(${h}, 70%, 85%)`;
    return { bg, text, border };
  }

  /** 要素にタグのスタイルを適用する */
  function applyTagStyle(el, tagName) {
    const styles = getTagStyles(tagName);
    el.style.backgroundColor = styles.bg;
    el.style.color = styles.text;
    el.style.borderColor = styles.border;
  }

  /** ストレージ使用率を更新 */
  function updateStorageUsage() {
    try {
      chrome.storage.sync.getBytesInUse(null, (bytesInUse) => {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError);
          return;
        }
        const maxBytes = 102400; // chrome.storage.sync の合計制限
        const percent = Math.min(100, Math.round((bytesInUse / maxBytes) * 100));
        
        const usageEl = $('#storage-usage');
        if (usageEl) {
          usageEl.textContent = `${percent}%`;
          usageEl.className = 'storage-usage';
          if (percent >= 90) {
            usageEl.classList.add('danger');
          } else if (percent >= 70) {
            usageEl.classList.add('warning');
          }
        }
      });
    } catch (e) {
      console.error('ストレージ容量の取得に失敗:', e);
    }
  }

  /** トースト通知を表示 */
  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-exit');
      let removed = false;
      const removeToast = () => {
        if (!removed) {
          removed = true;
          toast.remove();
        }
      };
      toast.addEventListener('animationend', removeToast);
      setTimeout(removeToast, 400); // 予備のタイムアウトで確実に消去
    }, 2500);
  }

  /** 検索クエリで論文をフィルタ */
  function getFilteredPapers() {
    const q = state.searchQuery.toLowerCase().trim();
    if (!q) return state.papers;
    return state.papers.filter(p => {
      const title = (p[P_TITLE] || '').toLowerCase();
      const tagNames = (p[P_TAGS] || []).map(i => (state.tags[i] || '').toLowerCase());
      return title.includes(q) || tagNames.some(t => t.includes(q));
    });
  }

  /** タグのカウントマップを取得 */
  function getTagCounts() {
    const counts = {};
    state.papers.forEach(p => {
      (p[P_TAGS] || []).forEach(i => {
        const name = state.tags[i];
        if (name) counts[name] = (counts[name] || 0) + 1;
      });
    });
    return counts;
  }


  // ===========================================
  // レンダリング
  // ===========================================

  /** 論文カードリストを描画 */
  function renderPaperList() {
    const filtered = getFilteredPapers();

    // 既存カードを削除（空状態は残す）
    dom.paperList.querySelectorAll('.paper-card').forEach(el => el.remove());

    if (filtered.length === 0) {
      dom.emptyState.style.display = '';
      if (state.papers.length > 0 && state.searchQuery) {
        dom.emptyState.querySelector('.empty-title').textContent = '検索結果がありません';
        dom.emptyState.querySelector('.empty-description').innerHTML = '別のキーワードで検索してみてください';
      } else {
        dom.emptyState.querySelector('.empty-title').textContent = '論文がまだありません';
        dom.emptyState.querySelector('.empty-description').innerHTML =
          '上の「保存」ボタンから<br>開いているタブの論文を保存しましょう';
      }
    } else {
      dom.emptyState.style.display = 'none';
      filtered.forEach(p => {
        dom.paperList.appendChild(createPaperCard(p));
      });
    }

    updateSelectAllState();
    updateSelectedCount();
  }

  /** 論文カードのDOM要素を生成 */
  function createPaperCard(compressedPaper) {
    const paper = expandPaper(compressedPaper, state.tags);

    const article = document.createElement('article');
    article.className = 'paper-card card-enter';
    article.dataset.id = paper.id;

    // チェックボックス
    const cbArea = document.createElement('div');
    cbArea.className = 'card-checkbox-area';
    const cbLabel = document.createElement('label');
    cbLabel.className = 'checkbox-wrapper';
    const cbInput = document.createElement('input');
    cbInput.type = 'checkbox';
    cbInput.className = 'paper-checkbox';
    cbInput.dataset.id = paper.id;
    cbInput.checked = state.selectedIds.has(paper.id);
    const cbCustom = document.createElement('span');
    cbCustom.className = 'checkbox-custom';
    cbLabel.appendChild(cbInput);
    cbLabel.appendChild(cbCustom);
    cbArea.appendChild(cbLabel);

    // チェックボックスのクリックイベント（バブリング停止）
    cbInput.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleSelection(paper.id, cbInput.checked);
    });
    cbArea.addEventListener('click', (e) => e.stopPropagation());

    // カード本文
    const body = document.createElement('div');
    body.className = 'card-body';
    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = paper.title || '(無題)';

    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'card-tags';
    paper.tags.forEach(tagName => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tagName;
      applyTagStyle(span, tagName);
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.searchInput.value = tagName;
        handleSearch();
      });
      tagsDiv.appendChild(span);
    });

    body.appendChild(title);
    body.appendChild(tagsDiv);

    // 詳細ボタン
    const detailBtn = document.createElement('button');
    detailBtn.className = 'btn-card-detail';
    detailBtn.title = '詳細を表示';
    detailBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    detailBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDetailPanel(paper.id);
    });

    // カードクリック → 新タブで開く
    article.addEventListener('click', () => {
      if (paper.url) {
        chrome.tabs.create({ url: paper.url });
      }
    });

    article.appendChild(cbArea);
    article.appendChild(body);
    article.appendChild(detailBtn);

    return article;
  }


  // ===========================================
  // 選択管理
  // ===========================================

  function toggleSelection(id, checked) {
    if (checked) {
      state.selectedIds.add(id);
    } else {
      state.selectedIds.delete(id);
    }
    updateSelectAllState();
    updateSelectedCount();
  }

  function updateSelectAllState() {
    const filtered = getFilteredPapers();
    const allIds = filtered.map(p => p[P_ID]);
    const allChecked = allIds.length > 0 && allIds.every(id => state.selectedIds.has(id));
    const someChecked = allIds.some(id => state.selectedIds.has(id));

    dom.checkboxSelectAll.checked = allChecked;
    dom.checkboxSelectAll.indeterminate = someChecked && !allChecked;
  }

  function updateSelectedCount() {
    const count = state.selectedIds.size;
    dom.selectedCount.innerHTML = `${count}件<br>選択中`;
  }

  function handleSelectAll() {
    const filtered = getFilteredPapers();
    const allIds = filtered.map(p => p[P_ID]);
    const allChecked = allIds.every(id => state.selectedIds.has(id));

    if (allChecked) {
      // すべて解除
      allIds.forEach(id => state.selectedIds.delete(id));
    } else {
      // すべて選択
      allIds.forEach(id => state.selectedIds.add(id));
    }

    // チェックボックスUIを更新
    document.querySelectorAll('.paper-checkbox').forEach(cb => {
      cb.checked = state.selectedIds.has(cb.dataset.id);
    });

    updateSelectAllState();
    updateSelectedCount();
  }


  // ===========================================
  // 保存モーダル
  // ===========================================
  let modalTags = []; // モーダルで追加されたタグの一時リスト

  function openSaveModal() {
    modalTags = [];
    dom.tagInputTags.innerHTML = '';
    dom.saveTitle.value = '';
    dom.saveTags.value = '';
    dom.saveUrl.value = '';
    dom.tagSuggestions.style.display = 'none';

    // 現在のタブの情報を取得
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        dom.saveUrl.value = tabs[0].url || '';
        dom.saveTitle.value = tabs[0].title || '';
      }
      dom.modalOverlay.style.display = '';
      dom.saveTitle.focus();
    });
  }

  function closeSaveModal() {
    dom.modalOverlay.style.display = 'none';
    modalTags = [];
  }

  /** モーダル内でタグを追加 */
  function addModalTag(tagName) {
    const normalized = tagName.trim();
    if (!normalized || modalTags.includes(normalized)) return;
    modalTags.push(normalized);
    renderModalTags();
  }

  /** モーダル内タグを描画 */
  function renderModalTags() {
    dom.tagInputTags.innerHTML = '';
    modalTags.forEach(tagName => {
      const span = document.createElement('span');
      span.className = 'tag tag-removable';
      span.innerHTML = `${escapeHtml(tagName)}<span class="tag-remove">&times;</span>`;
      applyTagStyle(span, tagName);
      span.querySelector('.tag-remove').addEventListener('click', () => {
        modalTags = modalTags.filter(t => t !== tagName);
        renderModalTags();
      });
      dom.tagInputTags.appendChild(span);
    });
  }

  /** タグサジェストを表示 */
  function showTagSuggestions(inputEl, suggestionsEl, currentTags, onSelect) {
    const query = inputEl.value.trim().toLowerCase();
    if (!query) {
      suggestionsEl.style.display = 'none';
      return;
    }

    const tagCounts = getTagCounts();
    const matches = Object.entries(tagCounts)
      .filter(([name]) => name.toLowerCase().includes(query) && !currentTags.includes(name))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    if (matches.length === 0) {
      suggestionsEl.style.display = 'none';
      return;
    }

    suggestionsEl.innerHTML = '';
    matches.forEach(([name, count]) => {
      const li = document.createElement('li');
      li.className = 'tag-suggestion-item';
      li.innerHTML = `<span class="suggestion-name">${escapeHtml(name)}</span><span class="suggestion-count">${count}件</span>`;
      li.addEventListener('click', () => {
        onSelect(name);
        inputEl.value = '';
        suggestionsEl.style.display = 'none';
      });
      suggestionsEl.appendChild(li);
    });
    suggestionsEl.style.display = '';
  }

  /** 保存処理を実行 */
  async function savePaper() {
    const url = dom.saveUrl.value.trim();
    const title = dom.saveTitle.value.trim();

    if (!url) {
      showToast('URLが取得できませんでした', 'error');
      return;
    }
    if (!title) {
      showToast('タイトルを入力してください', 'error');
      dom.saveTitle.focus();
      return;
    }

    // 重複チェック
    const duplicate = state.papers.find(p => p[P_URL] === url);
    if (duplicate) {
      showToast('この論文はすでに保存されています', 'error');
      return;
    }

    // タグインデックスの解決
    const tagIndices = modalTags.map(name => getOrCreateTagIndex(name, state.tags));

    // 新しい論文を作成
    const newPaper = [
      generateId(),
      url,
      title,
      tagIndices.filter(i => i >= 0),
      Math.floor(Date.now() / 1000)
    ];

    state.papers.unshift(newPaper);

    try {
      await saveStorage(state.papers, state.tags);
      showToast('論文を保存しました');
      closeSaveModal();
      renderPaperList();
      updateStorageUsage();
    } catch (err) {
      console.error('保存エラー:', err);
      state.papers.shift();
      showToast('保存に失敗しました。ストレージの容量制限の可能性があります', 'error');
    }
  }


  // ===========================================
  // 詳細パネル
  // ===========================================
  let detailTags = []; // 詳細パネル編集中のタグ

  function openDetailPanel(paperId) {
    const compressed = state.papers.find(p => p[P_ID] === paperId);
    if (!compressed) return;

    state.detailPaperId = paperId;
    state.editingField = null;

    const paper = expandPaper(compressed, state.tags);

    // 表示を更新
    dom.detailTitle.textContent = paper.title || '(無題)';
    dom.detailTitle.style.display = '';
    dom.detailTitleInput.style.display = 'none';
    dom.detailTitleInput.value = paper.title || '';

    // タグ表示
    renderDetailTags(paper.tags);
    dom.detailTags.style.display = '';
    dom.detailTagsEdit.style.display = 'none';

    // URL
    dom.detailUrl.textContent = paper.url || '';
    dom.detailUrl.href = paper.url || '#';

    // パネル表示
    dom.detailPanel.style.display = '';
  }

  function closeDetailPanel() {
    dom.detailPanel.style.display = 'none';
    state.detailPaperId = null;
    state.editingField = null;
  }

  function renderDetailTags(tagNames) {
    dom.detailTags.innerHTML = '';
    tagNames.forEach(name => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = name;
      applyTagStyle(span, name);
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        closeDetailPanel();
        dom.searchInput.value = name;
        handleSearch();
      });
      dom.detailTags.appendChild(span);
    });
    if (tagNames.length === 0) {
      const span = document.createElement('span');
      span.style.color = 'var(--text-tertiary)';
      span.style.fontSize = 'var(--font-size-sm)';
      span.textContent = 'タグなし';
      dom.detailTags.appendChild(span);
    }
  }

  /** 詳細パネル: タイトル編集開始 */
  function startEditTitle() {
    const compressed = state.papers.find(p => p[P_ID] === state.detailPaperId);
    if (!compressed) return;

    state.editingField = 'title';
    dom.detailTitle.style.display = 'none';
    dom.detailTitleInput.style.display = '';
    dom.detailTitleInput.value = compressed[P_TITLE] || '';
    dom.detailTitleInput.focus();
  }

  /** 詳細パネル: タイトル編集確定 */
  async function commitEditTitle() {
    if (state.editingField !== 'title') return;
    const newTitle = dom.detailTitleInput.value.trim();
    if (!newTitle) {
      showToast('タイトルを入力してください', 'error');
      return;
    }

    const idx = state.papers.findIndex(p => p[P_ID] === state.detailPaperId);
    if (idx === -1) return;

    state.papers[idx] = [...state.papers[idx]];
    state.papers[idx][P_TITLE] = newTitle;

    await saveStorage(state.papers, state.tags);
    state.editingField = null;

    dom.detailTitle.textContent = newTitle;
    dom.detailTitle.style.display = '';
    dom.detailTitleInput.style.display = 'none';

    renderPaperList();
    showToast('タイトルを更新しました');
    updateStorageUsage();
  }

  /** 詳細パネル: タグ編集開始 */
  function startEditTags() {
    const compressed = state.papers.find(p => p[P_ID] === state.detailPaperId);
    if (!compressed) return;

    state.editingField = 'tags';
    detailTags = (compressed[P_TAGS] || []).map(i => state.tags[i]).filter(Boolean);

    dom.detailTags.style.display = 'none';
    dom.detailTagsEdit.style.display = '';
    renderDetailEditTags();
    dom.detailTagInput.value = '';
    dom.detailTagInput.focus();
  }

  function renderDetailEditTags() {
    dom.detailTagInputTags.innerHTML = '';
    detailTags.forEach(tagName => {
      const span = document.createElement('span');
      span.className = 'tag tag-removable';
      span.innerHTML = `${escapeHtml(tagName)}<span class="tag-remove">&times;</span>`;
      applyTagStyle(span, tagName);
      span.querySelector('.tag-remove').addEventListener('click', () => {
        detailTags = detailTags.filter(t => t !== tagName);
        renderDetailEditTags();
      });
      dom.detailTagInputTags.appendChild(span);
    });
  }

  /** 詳細パネル: タグ編集確定 */
  async function commitEditTags() {
    if (state.editingField !== 'tags') return;

    const idx = state.papers.findIndex(p => p[P_ID] === state.detailPaperId);
    if (idx === -1) return;

    const tagIndices = detailTags.map(name => getOrCreateTagIndex(name, state.tags));

    state.papers[idx] = [...state.papers[idx]];
    state.papers[idx][P_TAGS] = tagIndices.filter(i => i >= 0);

    // 使われなくなったタグをクリーンアップ
    const cleaned = cleanupTags(state.papers, state.tags);
    state.papers = cleaned.papers;
    state.tags = cleaned.tags;

    await saveStorage(state.papers, state.tags);
    state.editingField = null;

    const paper = expandPaper(state.papers[idx], state.tags);
    renderDetailTags(paper.tags);
    dom.detailTags.style.display = '';
    dom.detailTagsEdit.style.display = 'none';

    renderPaperList();
    showToast('タグを更新しました');
    updateStorageUsage();
  }


  // ===========================================
  // 一括操作
  // ===========================================

  /** 選択中の論文を一括ダウンロード */
  function bulkDownload() {
    if (state.selectedIds.size === 0) {
      showToast('論文を選択してください', 'error');
      return;
    }
    const selected = state.papers.filter(p => state.selectedIds.has(p[P_ID]));
    selected.forEach(p => {
      if (p[P_URL]) {
        chrome.downloads.download({ url: p[P_URL] });
      }
    });
    showToast(`${selected.length}件のダウンロードを開始しました`);
  }

  /** 選択中の論文を一括削除 */
  async function bulkDelete() {
    if (state.selectedIds.size === 0) {
      showToast('論文を選択してください', 'error');
      return;
    }

    const count = state.selectedIds.size;
    if (!confirm(`${count}件の論文を削除しますか？`)) return;

    state.papers = state.papers.filter(p => !state.selectedIds.has(p[P_ID]));

    const cleaned = cleanupTags(state.papers, state.tags);
    state.papers = cleaned.papers;
    state.tags = cleaned.tags;

    state.selectedIds.clear();
    await saveStorage(state.papers, state.tags);
    renderPaperList();
    showToast(`${count}件の論文を削除しました`);
    updateStorageUsage();
  }

  /** 単一論文の削除 */
  async function deleteSinglePaper(paperId) {
    if (!confirm('この論文を削除しますか？')) return;

    state.papers = state.papers.filter(p => p[P_ID] !== paperId);
    state.selectedIds.delete(paperId);

    const cleaned = cleanupTags(state.papers, state.tags);
    state.papers = cleaned.papers;
    state.tags = cleaned.tags;

    await saveStorage(state.papers, state.tags);
    closeDetailPanel();
    renderPaperList();
    showToast('論文を削除しました');
    updateStorageUsage();
  }

  /** 参考文献リストを生成 */
  function generateReferenceList() {
    if (state.selectedIds.size === 0) {
      showToast('論文を選択してください', 'error');
      return;
    }

    const selected = state.papers
      .filter(p => state.selectedIds.has(p[P_ID]))
      .map(p => expandPaper(p, state.tags));

    const lines = selected.map((paper, i) => {
      return `[${i + 1}] ${paper.title}. ${paper.url}`;
    });

    dom.referenceOutput.value = lines.join('\n');
    dom.referenceOverlay.style.display = '';
  }

  function closeReferenceModal() {
    dom.referenceOverlay.style.display = 'none';
  }


  // ===========================================
  // 検索
  // ===========================================

  function handleSearch() {
    state.searchQuery = dom.searchInput.value;
    dom.btnClearSearch.style.display = state.searchQuery ? '' : 'none';
    renderPaperList();
  }

  function clearSearch() {
    dom.searchInput.value = '';
    state.searchQuery = '';
    dom.btnClearSearch.style.display = 'none';
    renderPaperList();
  }


  // ===========================================
  // ヘルパー
  // ===========================================

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** クリップボードにコピー */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('コピーしました');
    } catch {
      // フォールバック
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('コピーしました');
    }
  }


  // ===========================================
  // イベントバインド
  // ===========================================

  function bindEvents() {
    // 保存ボタン
    dom.btnSave.addEventListener('click', openSaveModal);

    // モーダル: 閉じる
    dom.btnModalClose.addEventListener('click', closeSaveModal);
    dom.btnModalCancel.addEventListener('click', closeSaveModal);
    dom.modalOverlay.addEventListener('click', (e) => {
      if (e.target === dom.modalOverlay) closeSaveModal();
    });

    // モーダル: 保存
    dom.btnModalSave.addEventListener('click', savePaper);

    // モーダル: タグ入力 (Enter で追加)
    dom.saveTags.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = dom.saveTags.value.trim();
        if (val) {
          addModalTag(val);
          dom.saveTags.value = '';
          dom.tagSuggestions.style.display = 'none';
        }
      }
    });

    // モーダル: タグサジェスト
    dom.saveTags.addEventListener('input', () => {
      showTagSuggestions(dom.saveTags, dom.tagSuggestions, modalTags, (name) => {
        addModalTag(name);
      });
    });

    // モーダル: フォーカスアウトでサジェスト非表示
    dom.saveTags.addEventListener('blur', () => {
      setTimeout(() => { dom.tagSuggestions.style.display = 'none'; }, 200);
    });

    // 検索
    dom.searchInput.addEventListener('input', handleSearch);
    dom.btnClearSearch.addEventListener('click', clearSearch);

    // 全選択
    dom.checkboxSelectAll.addEventListener('change', handleSelectAll);

    // 一括操作
    dom.btnBulkDownload.addEventListener('click', bulkDownload);
    dom.btnBulkDelete.addEventListener('click', bulkDelete);
    dom.btnBulkReference.addEventListener('click', generateReferenceList);

    // 詳細パネル: 戻る
    dom.btnDetailBack.addEventListener('click', () => {
      // 編集中なら確定してから閉じる
      if (state.editingField === 'title') {
        commitEditTitle().then(closeDetailPanel);
      } else if (state.editingField === 'tags') {
        commitEditTags().then(closeDetailPanel);
      } else {
        closeDetailPanel();
      }
    });

    // 詳細パネル: タイトル編集
    dom.btnEditTitle.addEventListener('click', startEditTitle);
    dom.detailTitleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitEditTitle();
      }
    });
    dom.detailTitleInput.addEventListener('blur', () => {
      // 少し遅延してからコミット（ボタンクリックとの競合回避）
      setTimeout(() => {
        if (state.editingField === 'title') commitEditTitle();
      }, 150);
    });

    // 詳細パネル: タグ編集
    dom.btnEditTags.addEventListener('click', startEditTags);
    dom.detailTagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = dom.detailTagInput.value.trim();
        if (val && !detailTags.includes(val)) {
          detailTags.push(val);
          renderDetailEditTags();
          dom.detailTagInput.value = '';
        }
      }
    });

    // 詳細パネル: タグ編集確定（フォーカスアウト時）
    dom.detailTagInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (state.editingField === 'tags') commitEditTags();
      }, 200);
    });

    // 詳細パネル: リンクコピー
    dom.btnCopyLink.addEventListener('click', () => {
      const compressed = state.papers.find(p => p[P_ID] === state.detailPaperId);
      if (compressed) copyToClipboard(compressed[P_URL] || '');
    });

    // 詳細パネル: ダウンロード
    dom.btnDownloadPaper.addEventListener('click', () => {
      const compressed = state.papers.find(p => p[P_ID] === state.detailPaperId);
      if (compressed && compressed[P_URL]) {
        chrome.downloads.download({ url: compressed[P_URL] });
        showToast('ダウンロードを開始しました');
      }
    });

    // 詳細パネル: 削除
    dom.btnDeletePaper.addEventListener('click', () => {
      if (state.detailPaperId) deleteSinglePaper(state.detailPaperId);
    });

    // 参考文献モーダル: 閉じる
    dom.btnReferenceClose.addEventListener('click', closeReferenceModal);
    dom.referenceOverlay.addEventListener('click', (e) => {
      if (e.target === dom.referenceOverlay) closeReferenceModal();
    });

    // 参考文献モーダル: コピー
    dom.btnCopyReference.addEventListener('click', () => {
      copyToClipboard(dom.referenceOutput.value);
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (dom.referenceOverlay.style.display !== 'none') {
          closeReferenceModal();
        } else if (dom.detailPanel.style.display !== 'none') {
          closeDetailPanel();
        } else if (dom.modalOverlay.style.display !== 'none') {
          closeSaveModal();
        }
      }
    });
  }


  // ===========================================
  // 初期化
  // ===========================================

  async function init() {
    const data = await loadStorage();
    state.papers = data.papers;
    state.tags = data.tags;

    bindEvents();
    renderPaperList();
    updateStorageUsage();
  }

  // DOM準備後に初期化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
