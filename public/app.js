const DEFAULT_MANIFEST_PATH = '';
const DEFAULT_PSD_PATH = '';
const DEFAULT_COMPARE_MANIFEST_PATH = '';

const state = {
  status: null,
  presets: [],
  derivedTargets: [],
  feishuTargets: [],
  feishuSendHistory: [],
  latestFinalJob: null,
  lastAutoFinalImagePath: '',
  presetCompatibility: [],
  manifestCandidates: [],
  lastCrossTemplatePayload: null,
  lastDerivedPresetPayload: null,
  pendingId: null,
  lastSessionId: null,
  jobPollToken: 0,
  inspection: null,
  selectedSlotKey: null,
  batchSlotKeys: [],
  previewZoom: 0.25,
  previewImagePathOverride: null,
  selectionDrag: null,
  canvasDrafts: {},
  batchDraft: {
    moveX: '',
    moveY: '',
    scalePercent: '',
    rotateDeg: '',
  },
  uiActions: [],
  preflight: null,
  sourceCollapsed: true,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setMessage(id, value, mode = 'text') {
  const el = $(id);
  if (!el) return;
  if (mode === 'html') {
    el.innerHTML = String(value || '');
  } else {
    el.textContent = typeof value === 'string' ? value : pretty(value);
  }
}

async function loadLocalDefaults() {
  try {
    const response = await fetch('/local-defaults.json', { cache: 'no-store' });
    if (!response.ok) return {};
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

function applyInitialDefaults(defaults) {
  $('manifestPath').value = String(defaults.manifestPath || DEFAULT_MANIFEST_PATH || '');
  $('psdPath').value = String(defaults.psdPath || DEFAULT_PSD_PATH || '');
  $('crossManifestPath').value = String(defaults.compareManifestPath || DEFAULT_COMPARE_MANIFEST_PATH || '');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function badge(label, value, tone = 'neutral') {
  return `<div class="status-item ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderStatus(payload) {
  state.status = payload;
  state.presets = Array.isArray(payload.presets) ? payload.presets : [];
  state.derivedTargets = Array.isArray(payload.derivedTargets) ? payload.derivedTargets : [];
  state.feishuTargets = Array.isArray(payload.feishuTargets) ? payload.feishuTargets : [];
  state.feishuSendHistory = Array.isArray(payload.feishuSendHistory) ? payload.feishuSendHistory : [];
  const design006Tone = payload.design006.pendingLogin ? 'warn' : 'ok';
  const photoshopTone = payload.photoshop.configured ? 'ok' : 'warn';
  const feishuReady = payload.feishu.hasChatTarget || payload.feishu.hasUserTarget;
  $('statusStrip').innerHTML = [
    badge('本地服务', window.location.origin, 'ok'),
    badge('design006 profile', payload.design006.pendingLogin ? `登录挂起 ${payload.design006.pendingLogin.id}` : payload.design006.profileDir, design006Tone),
    badge('Photoshop', payload.photoshop.configured ? '已配置' : (payload.photoshop.unavailableReason || '未配置'), photoshopTone),
    badge('飞书输出', feishuReady ? '已设置默认目标' : '未配置默认目标', feishuReady ? 'ok' : 'neutral'),
    badge('下载记录', `${payload.downloads.length} 条`, 'neutral'),
    badge('Job 记录', `${payload.jobs.length} 条`, 'neutral'),
  ].join('');

  if (payload.design006.pendingLogin) {
    state.pendingId = payload.design006.pendingLogin.id;
    $('continueLoginBtn').disabled = false;
    $('cancelLoginBtn').disabled = false;
  }
  renderFeishuDefaultStatus(payload.feishu);
  renderModelRoutes(payload.models || []);
  renderPresetList();
  renderDerivedTargets();
  renderFeishuTargets();
  renderFeishuReadiness();
  renderFeishuSendHistory();
}

function renderFeishuDefaultStatus(feishu) {
  const chatReady = Boolean(feishu?.hasChatTarget);
  const userReady = Boolean(feishu?.hasUserTarget);
  const localCount = state.feishuTargets.length;
  const label = chatReady
    ? '已配置默认 Chat ID'
    : userReady
      ? '已配置默认 User ID'
      : localCount > 0
        ? `未配置默认目标，可复用 ${localCount} 个本地最近目标`
        : '未配置默认目标，需要手动填写 Chat ID 或 User ID';
  $('feishuDefaultStatus').innerHTML = `
    <div class="target-dot ${chatReady || userReady ? 'ok' : 'warn'}"></div>
    <span>${escapeHtml(label)}</span>
    <small>${escapeHtml(feishu?.sender || 'lark-cli --as bot')}</small>
  `;
}

function renderModelRoutes(models) {
  if (!Array.isArray(models) || models.length === 0) {
    $('modelRoutes').innerHTML = '<div class="muted">未读取到模型配置。</div>';
    return;
  }
  $('modelRoutes').innerHTML = models.map((route) => `
    <div class="model-route">
      <div>
        <strong>${escapeHtml(route.label)}</strong>
        <span>${route.configured ? escapeHtml(route.primary) : '未配置'}</span>
      </div>
      <small>备选 ${escapeHtml(route.fallback || '未选择')} · 来源 ${escapeHtml(route.source || '-')}</small>
    </div>
  `).join('');
}

function renderCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return '<div class="muted">没有结果</div>';
  return `<div class="candidate-list">${candidates.map((item) => `
    <div class="candidate">
      <img src="${escapeHtml(item.previewUrl || '')}" alt="">
      <div>
        <strong>${escapeHtml(item.title || '')}</strong>
        <span>${escapeHtml(item.workForm || '')} · ${escapeHtml(item.priceText || '')} · ${escapeHtml(item.sizeText || '')}</span>
        <a href="${escapeHtml(item.detailUrl || '')}" target="_blank" rel="noreferrer">打开详情</a>
      </div>
    </div>
  `).join('')}</div>`;
}

function slotTypePills(slot) {
  return slot.capabilities.map((cap) => `<span class="pill ${cap}">${escapeHtml(cap)}</span>`).join('');
}

function slotMeasure(slot) {
  const b = slot.bounds;
  if (b) {
    const source = slot.boundsSource === 'layer_dump' ? 'layer-dump' : 'manifest';
    return `x ${b.left}, y ${b.top}<br>${b.width} × ${b.height}<br><span class="muted">${source}</span>`;
  }
  if (slot.targetSize) return `${slot.targetSize.width} × ${slot.targetSize.height}`;
  return slot.boundsUnavailableReason ? `<span class="muted">${escapeHtml(slot.boundsUnavailableReason)}</span>` : '-';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function localImageUrl(filePath) {
  return `/api/local-image?path=${encodeURIComponent(filePath)}`;
}

function documentSize() {
  if (state.inspection?.document?.width && state.inspection?.document?.height) {
    return state.inspection.document;
  }
  const bounds = (state.inspection?.slots || []).map((slot) => slot.bounds).filter(Boolean);
  if (bounds.length === 0) return null;
  return {
    width: Math.ceil(Math.max(...bounds.map((item) => Number(item.right) || 0), 1)),
    height: Math.ceil(Math.max(...bounds.map((item) => Number(item.bottom) || 0), 1)),
    sourcePath: null,
  };
}

function boundedSlots() {
  return (state.inspection?.slots || []).filter((slot) => {
    const b = slot.bounds;
    return b
      && Number.isFinite(Number(b.left))
      && Number.isFinite(Number(b.top))
      && Number.isFinite(Number(b.width))
      && Number.isFinite(Number(b.height));
  });
}

function activePreviewImagePath() {
  return state.previewImagePathOverride || state.inspection?.previewImagePath || '';
}

function previewStatusText(backgroundMode = '') {
  if (!state.inspection) return '尚未读取 manifest。';
  const doc = documentSize();
  const overlayCount = boundedSlots().length;
  const noBounds = (state.inspection.slots || []).length - overlayCount;
  const layerDump = state.inspection.layerDump;
  const selected = getSelectedSlot();
  const docLabel = doc ? `${doc.width} x ${doc.height}` : '未知尺寸';
  const dumpLabel = layerDump?.status === 'ready'
    ? ` · 文本 bounds ${layerDump.textBoundsMatched || 0} 个`
    : layerDump?.status === 'failed'
      ? ' · 文本 layer-dump 失败'
      : '';
  const selectedLabel = selected ? ` · 当前 ${selected.key}` : '';
  const batchLabel = state.batchSlotKeys.length ? ` · 多选 ${state.batchSlotKeys.length} 个` : '';
  const missingLabel = noBounds > 0 ? ` · ${noBounds} 个 slot 无真实 bounds` : '';
  const bgLabel = backgroundMode ? ` · ${backgroundMode}` : '';
  return `${docLabel} · ${overlayCount} 个可定位 slot${dumpLabel}${missingLabel}${selectedLabel}${batchLabel}${bgLabel}`;
}

function updatePreviewImageFit() {
  const image = $('previewImage');
  const doc = documentSize();
  if (!image || !doc || !image.naturalWidth || !image.naturalHeight) return;
  const docAspect = doc.width / doc.height;
  const imageAspect = image.naturalWidth / image.naturalHeight;
  const aspectDelta = Math.abs(docAspect - imageAspect) / docAspect;
  const matchesDocument = aspectDelta < 0.08;
  image.classList.toggle('usable', matchesDocument);
  const sourceLabel = state.previewImagePathOverride
    ? '使用 Photoshop 真实预览图'
    : matchesDocument
      ? '使用本地真实预览图'
      : `本地缩略图 ${image.naturalWidth} x ${image.naturalHeight} 与 PSD 比例不一致，定位底图已隐藏`;
  $('previewStatus').textContent = previewStatusText(sourceLabel);
}

function fitTemplatePreview() {
  const doc = documentSize();
  const viewport = $('previewViewport');
  if (!doc || !viewport) return;
  const nextZoom = Math.min(
    (viewport.clientWidth - 32) / doc.width,
    (viewport.clientHeight - 32) / doc.height,
  );
  state.previewZoom = clamp(Number.isFinite(nextZoom) ? nextZoom : 0.25, 0.08, 1.2);
  renderTemplatePreview();
}

function isBatchSelected(slotKey) {
  return state.batchSlotKeys.includes(slotKey);
}

function slotOverlayClass(slot) {
  const classes = [];
  if (slot.capabilities.includes('image')) classes.push('image');
  else if (slot.capabilities.includes('text')) classes.push('text');
  else if (slot.capabilities.includes('transform')) classes.push('transform');
  if (slot.key === state.selectedSlotKey) classes.push('selected');
  if (isBatchSelected(slot.key)) classes.push('multi-selected');
  return classes.join(' ');
}

function canvasPointFromEvent(event) {
  const canvas = $('templateCanvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp(event.clientX - rect.left, 0, rect.width),
    y: clamp(event.clientY - rect.top, 0, rect.height),
  };
}

function normalizeRect(start, end) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function rectsIntersect(a, b) {
  return !(
    a.right < b.left
    || b.right < a.left
    || a.bottom < b.top
    || b.bottom < a.top
  );
}

function slotRectOnCanvas(slot, zoom) {
  const b = slot.bounds;
  const left = Number(b.left) * zoom;
  const top = Number(b.top) * zoom;
  const width = Number(b.width) * zoom;
  const height = Number(b.height) * zoom;
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

function selectionHits(rect, zoom) {
  return boundedSlots()
    .filter((slot) => rectsIntersect(rect, slotRectOnCanvas(slot, zoom)))
    .map((slot) => slot.key);
}

function isCanvasSelectionTarget(target) {
  return !target.closest('button, input, textarea, select, summary, [data-canvas-guide], [data-batch-guide]');
}

function showSelectionRect(rect) {
  const box = $('boxSelectionRect');
  if (!box) return;
  box.hidden = false;
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

function hideSelectionRect() {
  const box = $('boxSelectionRect');
  if (!box) return;
  box.hidden = true;
  box.removeAttribute('style');
}

function selectionPointerId(event) {
  return typeof event.pointerId === 'number' ? event.pointerId : 'mouse';
}

function releaseSelectionCapture(canvas, event) {
  if (typeof event.pointerId === 'number') canvas.releasePointerCapture?.(event.pointerId);
}

function beginCanvasSelection(event) {
  if (state.selectionDrag || !state.inspection || event.button !== 0 || !isCanvasSelectionTarget(event.target)) return;
  const canvas = $('templateCanvas');
  const originSlotKey = event.target.closest('[data-preview-box]')?.dataset.previewBox || '';
  const start = canvasPointFromEvent(event);
  state.selectionDrag = {
    pointerId: selectionPointerId(event),
    start,
    current: start,
    active: false,
    addMode: event.shiftKey || event.metaKey || event.ctrlKey,
    originSlotKey,
  };
  if (typeof event.pointerId === 'number') canvas.setPointerCapture?.(event.pointerId);
  canvas.classList.add('is-box-selecting');
  hideSelectionRect();
  event.preventDefault();
}

function moveCanvasSelection(event) {
  const drag = state.selectionDrag;
  if (!drag || drag.pointerId !== selectionPointerId(event)) return;
  drag.current = canvasPointFromEvent(event);
  const rect = normalizeRect(drag.start, drag.current);
  if (rect.width < 5 && rect.height < 5) return;
  drag.active = true;
  showSelectionRect(rect);
}

function finishCanvasSelection(event) {
  const drag = state.selectionDrag;
  if (!drag || drag.pointerId !== selectionPointerId(event)) return;
  const canvas = $('templateCanvas');
  releaseSelectionCapture(canvas, event);
  canvas.classList.remove('is-box-selecting');
  hideSelectionRect();
  state.selectionDrag = null;
  if (!drag.active) {
    if (drag.originSlotKey) selectSlot(drag.originSlotKey);
    return;
  }
  const finalRect = normalizeRect(drag.start, drag.current);
  const hitKeys = selectionHits(finalRect, state.previewZoom);
  if (drag.addMode) {
    state.batchSlotKeys = [...new Set([...state.batchSlotKeys, ...hitKeys])];
  } else {
    state.batchSlotKeys = hitKeys;
  }
  state.selectedSlotKey = state.batchSlotKeys[0] || null;
  renderSlots();
  renderSlotDetail();
  renderTemplatePreview();
}

function cancelCanvasSelection(event) {
  const drag = state.selectionDrag;
  if (!drag || drag.pointerId !== selectionPointerId(event)) return;
  releaseSelectionCapture($('templateCanvas'), event);
  $('templateCanvas').classList.remove('is-box-selecting');
  hideSelectionRect();
  state.selectionDrag = null;
}

function bindCanvasSelection() {
  const canvas = $('templateCanvas');
  if (!canvas || canvas.dataset.boxSelectBound === 'true') return;
  canvas.dataset.boxSelectBound = 'true';
  canvas.addEventListener('pointerdown', beginCanvasSelection);
  canvas.addEventListener('mousedown', beginCanvasSelection);
  canvas.addEventListener('pointermove', moveCanvasSelection);
  window.addEventListener('mousemove', moveCanvasSelection);
  canvas.addEventListener('pointerup', finishCanvasSelection);
  window.addEventListener('mouseup', finishCanvasSelection);
  canvas.addEventListener('pointercancel', cancelCanvasSelection);
}

function placePreviewLabel(preferredLeft, preferredTop, canvasWidth, canvasHeight, placedLabels) {
  const labelWidth = Math.min(118, Math.max(82, canvasWidth - 8));
  const labelHeight = 18;
  let left = clamp(preferredLeft, 4, Math.max(4, canvasWidth - labelWidth - 4));
  let top = clamp(preferredTop, 4, Math.max(4, canvasHeight - labelHeight - 4));

  function intersects(rect) {
    return !(
      left + labelWidth < rect.left
      || rect.left + rect.width < left
      || top + labelHeight < rect.top
      || rect.top + rect.height < top
    );
  }

  for (let attempt = 0; attempt < 80 && placedLabels.some(intersects); attempt += 1) {
    top += labelHeight + 4;
    if (top > canvasHeight - labelHeight - 4) {
      top = 4;
      left += labelWidth + 8;
      if (left > canvasWidth - labelWidth - 4) left = 4;
    }
  }

  placedLabels.push({ left, top, width: labelWidth, height: labelHeight });
  return { left, top, width: labelWidth };
}

function canvasDraft(slotKey) {
  if (!state.canvasDrafts[slotKey]) {
    state.canvasDrafts[slotKey] = {
      text: '',
      imagePath: '',
      aiPrompt: '',
      aiOutputPath: '',
      modelId: '',
      moveX: '',
      moveY: '',
      scalePercent: '',
      rotateDeg: '',
    };
  }
  return state.canvasDrafts[slotKey];
}

function guidePosition(slot, zoom, canvasWidth, canvasHeight) {
  const panelWidth = Math.min(320, Math.max(260, canvasWidth - 16));
  const panelHeight = slot.capabilities.includes('image') ? 410 : 310;
  const b = slot.bounds;
  const boxLeft = Number(b.left) * zoom;
  const boxTop = Number(b.top) * zoom;
  const boxWidth = Number(b.width) * zoom;
  const boxHeight = Number(b.height) * zoom;
  const rightCandidate = boxLeft + boxWidth + 10;
  const leftCandidate = boxLeft - panelWidth - 10;
  const preferredLeft = rightCandidate + panelWidth < canvasWidth - 6 ? rightCandidate : leftCandidate;
  const preferredTop = boxTop + panelHeight < canvasHeight - 6 ? boxTop : boxTop + boxHeight - panelHeight;
  return {
    left: clamp(preferredLeft, 6, Math.max(6, canvasWidth - panelWidth - 6)),
    top: clamp(preferredTop, 6, Math.max(6, canvasHeight - panelHeight - 6)),
    width: panelWidth,
  };
}

function modelOptionsHtml(selectedModel = '') {
  const model = (state.status?.models || []).find((item) => item.key === 'image');
  if (!model?.configured || !model.primary) return '<option value="">未配置</option>';
  const options = [model.primary, model.fallback].filter(Boolean);
  return [...new Set(options)].map((value) => (
    `<option value="${escapeHtml(value)}" ${value === selectedModel ? 'selected' : ''}>${escapeHtml(value)}</option>`
  )).join('');
}

function batchSlots() {
  const slots = state.inspection?.slots || [];
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  return state.batchSlotKeys.map((key) => byKey.get(key)).filter(Boolean);
}

function renderBatchGuide(canvasWidth) {
  const slots = batchSlots();
  if (slots.length === 0) return '';
  const textCount = slots.filter((slot) => slot.capabilities.includes('text')).length;
  const imageCount = slots.filter((slot) => slot.capabilities.includes('image')).length;
  const transformCount = slots.filter((slot) => slot.capabilities.includes('transform')).length;
  const toggleCount = slots.filter((slot) => slot.capabilities.includes('toggle')).length;
  const width = Math.min(340, Math.max(280, canvasWidth - 16));
  return `
    <div class="batch-guide" data-batch-guide style="left:8px;top:8px;width:${width}px;">
      <div class="batch-guide-head">
        <div>
          <strong>批量制导 · ${slots.length} 个 slot</strong>
          <span>text ${textCount} / image ${imageCount} / transform ${transformCount} / toggle ${toggleCount}</span>
        </div>
        <button type="button" class="secondary small" data-batch-action="clear-selection">清空多选</button>
      </div>
      <div class="batch-tags">
        ${slots.map((slot) => `<span>${escapeHtml(slot.key)}</span>`).join('')}
      </div>
      <div class="button-row">
        <button type="button" class="secondary" data-batch-action="clear-text" ${textCount ? '' : 'disabled'}>清空文本 ${textCount}</button>
        <button type="button" class="danger" data-batch-action="hide">隐藏预检 ${slots.length}</button>
      </div>
      <div class="batch-transform">
        <div class="guide-grid">
          <label class="field tight"><span>dx</span><input id="batchMoveX" value="${escapeHtml(state.batchDraft.moveX)}" inputmode="decimal" placeholder="0"></label>
          <label class="field tight"><span>dy</span><input id="batchMoveY" value="${escapeHtml(state.batchDraft.moveY)}" inputmode="decimal" placeholder="0"></label>
          <label class="field tight"><span>缩放%</span><input id="batchScalePercent" value="${escapeHtml(state.batchDraft.scalePercent)}" inputmode="decimal" placeholder="100"></label>
          <label class="field tight"><span>旋转°</span><input id="batchRotateDeg" value="${escapeHtml(state.batchDraft.rotateDeg)}" inputmode="decimal" placeholder="0"></label>
        </div>
        <button type="button" class="secondary" data-batch-action="transform" ${transformCount ? '' : 'disabled'}>批量位置变换 ${transformCount}</button>
      </div>
    </div>
  `;
}

function renderCanvasGuide(slot, zoom, canvasWidth, canvasHeight) {
  if (!slot?.bounds) return '';
  const draft = canvasDraft(slot.key);
  const pos = guidePosition(slot, zoom, canvasWidth, canvasHeight);
  return `
    <div
      class="canvas-guide ${slot.primaryType || ''}"
      data-canvas-guide="${escapeHtml(slot.key)}"
      style="left:${pos.left}px;top:${pos.top}px;width:${pos.width}px;"
    >
      <div class="canvas-guide-head">
        <div>
          <strong>${escapeHtml(slot.key)}</strong>
          <span>${escapeHtml(slot.primaryType || 'slot')} · ${escapeHtml(slot.boundsSource || 'bounds')}</span>
        </div>
        <button type="button" class="secondary small" data-guide-close>收起</button>
      </div>
      <div class="canvas-guide-path">${escapeHtml(slot.layerPath)}</div>
      ${slot.capabilities.includes('text') ? `
        <div class="canvas-guide-block">
          <label class="field tight">
            <span>替换文本</span>
            <textarea id="canvasTextValue" rows="2" placeholder="输入要写入这一层的文本">${escapeHtml(draft.text)}</textarea>
          </label>
          <div class="button-row">
            <button type="button" data-guide-action="text-replace">替换</button>
            <button type="button" class="secondary" data-guide-action="text-clear">清空</button>
          </div>
        </div>
      ` : ''}
      ${slot.capabilities.includes('image') ? `
        <div class="canvas-guide-block">
          <label class="field tight">
            <span>本地替换图片路径</span>
            <input id="canvasImagePath" value="${escapeHtml(draft.imagePath)}" placeholder="/path/to/source.png">
          </label>
          <button type="button" data-guide-action="image-local">本地替换</button>
        </div>
      ` : ''}
      ${slot.capabilities.includes('transform') ? `
        <div class="canvas-guide-block">
          <div class="guide-grid">
            <label class="field tight"><span>dx</span><input id="canvasMoveX" value="${escapeHtml(draft.moveX)}" inputmode="decimal" placeholder="0"></label>
            <label class="field tight"><span>dy</span><input id="canvasMoveY" value="${escapeHtml(draft.moveY)}" inputmode="decimal" placeholder="0"></label>
            <label class="field tight"><span>缩放%</span><input id="canvasScalePercent" value="${escapeHtml(draft.scalePercent)}" inputmode="decimal" placeholder="100"></label>
            <label class="field tight"><span>旋转°</span><input id="canvasRotateDeg" value="${escapeHtml(draft.rotateDeg)}" inputmode="decimal" placeholder="0"></label>
          </div>
          <button type="button" class="secondary" data-guide-action="transform">加入变换</button>
        </div>
      ` : ''}
      <div class="canvas-guide-block danger-zone">
        <button type="button" class="danger" data-guide-action="hide">隐藏图层</button>
        <span>删除语义在 v1 先按隐藏预检处理。</span>
      </div>
      ${slot.capabilities.includes('image') ? `
        <details class="canvas-guide-block ai-guide">
          <summary>AI 文件替换</summary>
          <label class="field tight">
            <span>AI prompt</span>
            <textarea id="canvasAiPrompt" rows="2" placeholder="先生成真实图片文件，再提交替换">${escapeHtml(draft.aiPrompt)}</textarea>
          </label>
          <div class="guide-grid">
            <label class="field tight">
              <span>模型</span>
              <select id="canvasImageModel">${modelOptionsHtml(draft.modelId)}</select>
            </label>
            <label class="field tight">
              <span>生成文件</span>
              <input id="canvasAiOutputPath" value="${escapeHtml(draft.aiOutputPath)}" placeholder="/path/to/generated.png">
            </label>
          </div>
          <button type="button" class="secondary" data-guide-action="image-ai">加入 AI 文件替换</button>
        </details>
      ` : ''}
    </div>
  `;
}

function renderTemplatePreview() {
  const canvas = $('templateCanvas');
  const overlayLayer = $('overlayLayer');
  const image = $('previewImage');
  const doc = documentSize();
  if (!state.inspection || !doc) {
    canvas.style.width = '';
    canvas.style.height = '';
    overlayLayer.innerHTML = '';
    image.removeAttribute('src');
    image.classList.remove('usable');
    $('previewMeta').textContent = '读取 manifest 后显示真实 PSD 坐标 overlay。';
    $('previewStatus').textContent = '尚未读取 manifest。';
    return;
  }

  const zoom = clamp(state.previewZoom, 0.08, 1.4);
  state.previewZoom = zoom;
  const width = Math.round(doc.width * zoom);
  const height = Math.round(doc.height * zoom);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  $('previewMeta').textContent = `${state.inspection.templateId || '未命名模板'} · ${Math.round(zoom * 100)}%`;

  const previewPath = activePreviewImagePath();
  if (previewPath && image.dataset.path !== previewPath) {
    image.classList.remove('usable');
    image.dataset.path = previewPath;
    image.src = localImageUrl(previewPath);
  } else if (!previewPath) {
    image.removeAttribute('src');
    image.classList.remove('usable');
    image.dataset.path = '';
  }

  const placedLabels = [];
  const overlays = boundedSlots().map((slot) => {
    const b = slot.bounds;
    const left = Number(b.left) * zoom;
    const top = Number(b.top) * zoom;
    const slotWidth = Number(b.width) * zoom;
    const slotHeight = Number(b.height) * zoom;
    const label = `${slot.key} · ${slot.primaryType}`;
    const labelBox = placePreviewLabel(left + 4, top + 4, width, height, placedLabels);
    const classes = slotOverlayClass(slot);
    return `
      <div
        class="slot-overlay-box ${classes}"
        data-preview-box="${escapeHtml(slot.key)}"
        title="${escapeHtml(slot.layerPath)}"
        style="left:${left}px;top:${top}px;width:${slotWidth}px;height:${slotHeight}px;"
      ></div>
      <button
        type="button"
        class="slot-overlay-label ${classes}"
        data-preview-slot="${escapeHtml(slot.key)}"
        title="${escapeHtml(slot.layerPath)}"
        style="left:${labelBox.left}px;top:${labelBox.top}px;width:${labelBox.width}px;"
      >
        <span>${escapeHtml(label)}</span>
      </button>
    `;
  }).join('');
  const selectedSlot = getSelectedSlot();
  overlayLayer.innerHTML = [
    overlays,
    '<div id="boxSelectionRect" class="box-selection-rect" hidden></div>',
    renderBatchGuide(width),
    selectedSlot?.bounds && state.batchSlotKeys.length === 0 ? renderCanvasGuide(selectedSlot, zoom, width, height) : '',
  ].join('');
  bindCanvasSelection();
  document.querySelectorAll('[data-preview-slot]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        toggleBatchSlot(button.dataset.previewSlot);
      } else {
        selectSlot(button.dataset.previewSlot);
      }
    });
  });
  bindBatchGuide();
  bindCanvasGuide();
  $('previewStatus').textContent = previewStatusText(image.classList.contains('usable') ? '显示真实预览底图' : '');
  if (image.complete && image.naturalWidth) updatePreviewImageFit();
}

function readCanvasNumber(id) {
  const value = $(id)?.value?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBatchNumber(id) {
  const value = $(id)?.value?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function syncCanvasDraft(slot) {
  const draft = canvasDraft(slot.key);
  if ($('canvasTextValue')) draft.text = $('canvasTextValue').value;
  if ($('canvasImagePath')) draft.imagePath = $('canvasImagePath').value;
  if ($('canvasAiPrompt')) draft.aiPrompt = $('canvasAiPrompt').value;
  if ($('canvasAiOutputPath')) draft.aiOutputPath = $('canvasAiOutputPath').value;
  if ($('canvasImageModel')) draft.modelId = $('canvasImageModel').value;
  if ($('canvasMoveX')) draft.moveX = $('canvasMoveX').value;
  if ($('canvasMoveY')) draft.moveY = $('canvasMoveY').value;
  if ($('canvasScalePercent')) draft.scalePercent = $('canvasScalePercent').value;
  if ($('canvasRotateDeg')) draft.rotateDeg = $('canvasRotateDeg').value;
  return draft;
}

function syncBatchDraft() {
  if ($('batchMoveX')) state.batchDraft.moveX = $('batchMoveX').value;
  if ($('batchMoveY')) state.batchDraft.moveY = $('batchMoveY').value;
  if ($('batchScalePercent')) state.batchDraft.scalePercent = $('batchScalePercent').value;
  if ($('batchRotateDeg')) state.batchDraft.rotateDeg = $('batchRotateDeg').value;
}

function bindBatchGuide() {
  const guide = document.querySelector('[data-batch-guide]');
  if (!guide) return;
  guide.addEventListener('click', (event) => event.stopPropagation());
  guide.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', syncBatchDraft);
    input.addEventListener('change', syncBatchDraft);
  });
  guide.querySelectorAll('[data-batch-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.batchAction;
      const slots = batchSlots();
      if (action === 'clear-selection') {
        state.batchSlotKeys = [];
        renderSlots();
        renderTemplatePreview();
        return;
      }
      if (action === 'clear-text') {
        addActions(slots
          .filter((slot) => slot.capabilities.includes('text'))
          .map((slot) => ({ type: 'text.clear', slotKey: slot.key })));
      } else if (action === 'hide') {
        addActions(slots.map((slot) => ({ type: 'layer.hide', slotKey: slot.key })));
      } else if (action === 'transform') {
        syncBatchDraft();
        addActions(slots
          .filter((slot) => slot.capabilities.includes('transform'))
          .map((slot) => ({
            type: 'transform.update',
            slotKey: slot.key,
            move: {
              x: readBatchNumber('batchMoveX'),
              y: readBatchNumber('batchMoveY'),
            },
            scalePercent: readBatchNumber('batchScalePercent'),
            rotateDeg: readBatchNumber('batchRotateDeg'),
          })));
      }
    });
  });
}

function bindCanvasGuide() {
  const slot = getSelectedSlot();
  if (!slot) return;
  const guide = document.querySelector('[data-canvas-guide]');
  if (!guide) return;
  guide.addEventListener('click', (event) => event.stopPropagation());
  guide.querySelector('[data-guide-close]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    state.selectedSlotKey = null;
    renderSlots();
    renderSlotDetail();
    renderTemplatePreview();
  });
  guide.querySelectorAll('input, textarea, select').forEach((input) => {
    input.addEventListener('input', () => syncCanvasDraft(slot));
    input.addEventListener('change', () => syncCanvasDraft(slot));
  });
  guide.querySelectorAll('[data-guide-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const draft = syncCanvasDraft(slot);
      const action = button.dataset.guideAction;
      if (action === 'text-replace') {
        addAction({ type: 'text.replace', slotKey: slot.key, value: draft.text });
      } else if (action === 'text-clear') {
        addAction({ type: 'text.clear', slotKey: slot.key });
      } else if (action === 'image-local') {
        addAction({ type: 'image.replace.local', slotKey: slot.key, sourcePath: draft.imagePath.trim() });
      } else if (action === 'image-ai') {
        addAction({
          type: 'image.replace.ai',
          slotKey: slot.key,
          sourcePath: draft.aiOutputPath.trim(),
          prompt: draft.aiPrompt.trim(),
          modelId: draft.modelId.trim(),
        });
      } else if (action === 'transform') {
        addAction({
          type: 'transform.update',
          slotKey: slot.key,
          move: {
            x: readCanvasNumber('canvasMoveX'),
            y: readCanvasNumber('canvasMoveY'),
          },
          scalePercent: readCanvasNumber('canvasScalePercent'),
          rotateDeg: readCanvasNumber('canvasRotateDeg'),
        });
      } else if (action === 'hide') {
        addAction({ type: 'layer.hide', slotKey: slot.key });
      }
    });
  });
}

function filteredSlots() {
  const slots = state.inspection?.slots || [];
  const query = $('slotSearch').value.trim().toLowerCase();
  if (!query) return slots;
  return slots.filter((slot) => (
    slot.key.toLowerCase().includes(query)
    || slot.layerPath.toLowerCase().includes(query)
    || slot.capabilities.join(' ').toLowerCase().includes(query)
  ));
}

function renderSlots() {
  const slots = filteredSlots();
  const inspection = state.inspection;
  if (!inspection) {
    $('slotsBody').innerHTML = '<div class="empty-cell">尚未读取 manifest。</div>';
    $('slotStats').textContent = '尚未读取 manifest。';
    renderTemplatePreview();
    return;
  }
  $('slotStats').textContent = `${inspection.templateId || '未命名模板'} · text ${inspection.counts.text} / image ${inspection.counts.image} / transform ${inspection.counts.transform} / toggle ${inspection.counts.toggle}`;
  if (slots.length === 0) {
    $('slotsBody').innerHTML = '<div class="empty-cell">没有匹配的 slot。</div>';
    return;
  }
  $('slotsBody').innerHTML = slots.map((slot) => {
    const selected = slot.key === state.selectedSlotKey ? ' selected' : '';
    const batchSelected = isBatchSelected(slot.key) ? ' multi-selected' : '';
    return `
      <div class="slot-row${selected}${batchSelected}" data-slot-row="${escapeHtml(slot.key)}">
        <button type="button" class="slot-main" data-slot="${escapeHtml(slot.key)}">
          <span class="slot-row-top">
            <strong>${escapeHtml(slot.key)}</strong>
            <span class="pill-row">${slotTypePills(slot)}</span>
          </span>
          <span class="layer-path">${escapeHtml(slot.layerPath)}</span>
          <span class="mono">${slotMeasure(slot)}</span>
        </button>
        <button type="button" class="secondary small slot-action" data-slot="${escapeHtml(slot.key)}">操作</button>
      </div>
    `;
  }).join('');
  document.querySelectorAll('[data-slot]').forEach((el) => {
    el.addEventListener('click', () => selectSlot(el.dataset.slot));
  });
}

function setSourceCollapsed(collapsed) {
  state.sourceCollapsed = collapsed;
  $('sourcePanel')?.classList.toggle('is-collapsed', collapsed);
  if ($('sourceContent')) $('sourceContent').hidden = collapsed;
  if ($('toggleSourceBtn')) {
    $('toggleSourceBtn').textContent = collapsed ? '展开来源' : '隐藏来源';
    $('toggleSourceBtn').setAttribute('aria-expanded', String(!collapsed));
  }
}

function getSelectedSlot() {
  return (state.inspection?.slots || []).find((slot) => slot.key === state.selectedSlotKey) || null;
}

function renderSlotDetail() {
  const slot = getSelectedSlot();
  if (!slot) {
    $('slotDetail').innerHTML = '<div class="empty">选择一个真实 slot 后，这里会显示可执行操作。</div>';
    return;
  }
  const b = slot.bounds;
  const isText = slot.capabilities.includes('text');
  const isImage = slot.capabilities.includes('image');
  const isTransform = slot.capabilities.includes('transform');
  const boundsLabel = b ? `x ${b.left}, y ${b.top}` : '-';
  const sizeLabel = b ? `${b.width} × ${b.height}` : (slot.targetSize ? `${slot.targetSize.width} × ${slot.targetSize.height}` : '-');
  const sourceLabel = slot.boundsSource || slot.boundsUnavailableReason || '-';
  const primaryLabel = isText ? '文字图层' : isImage ? '图像图层' : isTransform ? '变换图层' : '图层';
  const properties = [
    ['Slot', slot.key],
    ['LayerPath', slot.layerPath],
    ['类型', primaryLabel],
    ['能力', slot.capabilities.join(' / ')],
    ['位置', boundsLabel],
    ['尺寸', sizeLabel],
    ['Bounds Source', sourceLabel],
    ['Max Chars', slot.maxChars ?? '-'],
  ];
  const model = (state.status?.models || []).find((item) => item.key === 'image');
  const modelOptions = model?.configured && model.primary
    ? `<option value="${escapeHtml(model.primary)}">${escapeHtml(model.primary)}</option>`
    : '<option value="">未配置</option>';
  const modelHint = model?.configured
    ? `主模型 ${model.primary}${model.fallback ? ` · 备选 ${model.fallback}` : ''}`
    : '未配置生图模型；AI 替换必须先生成真实文件后才能提交。';

  $('slotDetail').innerHTML = `
    <div class="slot-inspector">
      <div class="layer-summary">
        <div class="layer-icon ${escapeHtml(slot.primaryType || 'layer')}">${escapeHtml((slot.primaryType || 'L').slice(0, 1).toUpperCase())}</div>
        <div>
          <div class="slot-title">
            <h3>${escapeHtml(slot.key)}</h3>
            <div class="pill-row">${slotTypePills(slot)}</div>
          </div>
          <div class="layer-summary-meta">
            <span>${escapeHtml(primaryLabel)}</span>
            <span>${escapeHtml(sizeLabel)}</span>
            <span>${escapeHtml(sourceLabel)}</span>
          </div>
        </div>
      </div>

      <details class="inspector-group" open>
        <summary><span>图层属性</span><small>${escapeHtml(boundsLabel)}</small></summary>
        <dl class="props">
          ${properties.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
        </dl>
      </details>

      ${isText ? `
      <details class="inspector-group action-group" open>
        <summary><span>文本操作</span><small>replace_text / clear</small></summary>
        <label class="field">
          <span>替换文本</span>
          <textarea id="textValue" rows="3" placeholder="输入真实要写入的文本"></textarea>
        </label>
        <div class="button-row">
          <button id="addTextReplaceBtn" type="button">加入文本替换</button>
          <button id="addTextClearBtn" type="button" class="secondary">加入清空文本</button>
        </div>
      </details>
    ` : ''}

      ${isImage ? `
      <details class="inspector-group action-group" open>
        <summary><span>图片替换</span><small>local / AI file</small></summary>
        <label class="field">
          <span>本地/已生成图片路径</span>
          <input id="imageSourcePath" placeholder="/path/to/source.jpg">
        </label>
        <label class="field">
          <span>AI prompt</span>
          <textarea id="imagePrompt" rows="2" placeholder="用于生图记录；必须先生成真实文件再提交"></textarea>
        </label>
        <label class="field">
          <span>生图模型</span>
          <select id="imageModel">${modelOptions}</select>
        </label>
        <p class="hint">${escapeHtml(modelHint)}</p>
        <div class="button-row">
          <button id="addImageLocalBtn" type="button">加入本地替换</button>
          <button id="addImageAiBtn" type="button" class="secondary">加入 AI 生成替换</button>
        </div>
      </details>
    ` : ''}

      ${isTransform ? `
      <details class="inspector-group action-group"${isText || isImage ? '' : ' open'}>
        <summary><span>位置变换</span><small>transform_layer</small></summary>
        <div class="quad">
          <label class="field"><span>dx</span><input id="moveX" inputmode="decimal" placeholder="0"></label>
          <label class="field"><span>dy</span><input id="moveY" inputmode="decimal" placeholder="0"></label>
          <label class="field"><span>缩放 %</span><input id="scalePercent" inputmode="decimal" placeholder="100"></label>
          <label class="field"><span>旋转 °</span><input id="rotateDeg" inputmode="decimal" placeholder="0"></label>
        </div>
        <button id="addTransformBtn" type="button" class="secondary">加入位置变换</button>
      </details>
    ` : ''}

      <details class="inspector-group action-group danger-group">
        <summary><span>隐藏 / 删除语义</span><small>preflight gate</small></summary>
      <p class="hint">v1 不删除 PSD 图层。此动作会预检 manifest 是否有 toggle 能力；当前模板没有时会被拦截。</p>
      <button id="addHideBtn" type="button" class="danger">加入隐藏图层</button>
      </details>
    </div>
  `;

  $('addTextReplaceBtn')?.addEventListener('click', () => addAction({
    type: 'text.replace',
    slotKey: slot.key,
    value: $('textValue').value,
  }));
  $('addTextClearBtn')?.addEventListener('click', () => addAction({
    type: 'text.clear',
    slotKey: slot.key,
  }));
  $('addImageLocalBtn')?.addEventListener('click', () => addAction({
    type: 'image.replace.local',
    slotKey: slot.key,
    sourcePath: $('imageSourcePath').value.trim(),
  }));
  $('addImageAiBtn')?.addEventListener('click', () => addAction({
    type: 'image.replace.ai',
    slotKey: slot.key,
    sourcePath: $('imageSourcePath').value.trim(),
    prompt: $('imagePrompt').value.trim(),
    modelId: $('imageModel').value.trim(),
  }));
  $('addTransformBtn')?.addEventListener('click', () => addAction({
    type: 'transform.update',
    slotKey: slot.key,
    move: {
      x: readNumber('moveX'),
      y: readNumber('moveY'),
    },
    scalePercent: readNumber('scalePercent'),
    rotateDeg: readNumber('rotateDeg'),
  }));
  $('addHideBtn')?.addEventListener('click', () => addAction({
    type: 'layer.hide',
    slotKey: slot.key,
  }));
}

function readNumber(id) {
  const value = $(id)?.value?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function selectSlot(slotKey) {
  state.selectedSlotKey = slotKey;
  state.batchSlotKeys = [];
  renderSlots();
  renderSlotDetail();
  renderTemplatePreview();
}

function toggleBatchSlot(slotKey) {
  if (!slotKey) return;
  state.selectedSlotKey = slotKey;
  if (state.batchSlotKeys.includes(slotKey)) {
    state.batchSlotKeys = state.batchSlotKeys.filter((key) => key !== slotKey);
  } else {
    state.batchSlotKeys = [...state.batchSlotKeys, slotKey];
  }
  renderSlots();
  renderSlotDetail();
  renderTemplatePreview();
}

function describeAction(action) {
  if (action.type === 'text.replace') return `value="${action.value || ''}"`;
  if (action.type === 'text.clear') return 'value=""';
  if (action.type === 'image.replace.local') return action.sourcePath ? `source=${action.sourcePath}` : '缺少本地素材路径';
  if (action.type === 'image.replace.ai') return action.sourcePath ? `generated=${action.sourcePath}` : '缺少真实生成文件';
  if (action.type === 'transform.update') return [
    action.move?.x !== undefined ? `dx=${action.move.x}` : '',
    action.move?.y !== undefined ? `dy=${action.move.y}` : '',
    action.scalePercent !== undefined ? `scale=${action.scalePercent}%` : '',
    action.rotateDeg !== undefined ? `rotate=${action.rotateDeg}°` : '',
  ].filter(Boolean).join(' · ') || '未设置变换参数';
  if (action.type === 'layer.hide') return '隐藏图层 · 不删除';
  return '';
}

function addAction(action) {
  addActions([action]);
}

function addActions(actions) {
  const normalized = actions.filter(Boolean);
  if (normalized.length === 0) return;
  state.uiActions.push(...normalized.map((action) => ({
    id: crypto.randomUUID(),
    ...action,
  })));
  state.preflight = null;
  renderQueue();
  renderPreflight();
  void runPreflight();
}

function resetActionQueue() {
  state.uiActions = [];
  state.preflight = null;
  renderQueue();
  renderPreflight();
}

function removeAction(id) {
  state.uiActions = state.uiActions.filter((action) => action.id !== id);
  state.preflight = null;
  renderQueue();
  renderPreflight();
  if (state.uiActions.length > 0) void runPreflight();
}

function renderQueue() {
  $('queueStats').textContent = `${state.uiActions.length} 个 UI action。`;
  if (state.uiActions.length === 0) {
    $('queueList').innerHTML = '<div class="empty">还没有动作。请在 Slot 详情中加入操作。</div>';
    $('createJobBtn').disabled = true;
    return;
  }
  $('queueList').innerHTML = state.uiActions.map((action, index) => `
    <div class="queue-item">
      <div class="queue-index">${String(index + 1).padStart(2, '0')}</div>
      <div class="queue-main">
        <strong>${escapeHtml(action.slotKey)} · ${escapeHtml(action.type)}</strong>
        <span>${escapeHtml(describeAction(action))}</span>
      </div>
      <button type="button" class="secondary small remove-action" data-id="${escapeHtml(action.id)}">移除</button>
    </div>
  `).join('');
  document.querySelectorAll('.remove-action').forEach((button) => {
    button.addEventListener('click', () => removeAction(button.dataset.id));
  });
}

function presetSummary(preset) {
  const slots = Array.isArray(preset.slotKeys) ? preset.slotKeys : [];
  const template = preset.templateId || preset.templateDisplayName || '通用';
  return `${preset.actionCount || preset.uiActions?.length || 0} actions · ${slots.length} slots · ${template}`;
}

function presetCompatibility(presetId) {
  return (state.presetCompatibility || []).find((item) => item.presetId === presetId) || null;
}

function derivedTargetPresetExists(record) {
  const presetId = record?.targetPreset?.id || '';
  return Boolean(presetId && (state.presets || []).some((preset) => preset.id === presetId));
}

function derivedTargetSummary(record) {
  const target = record?.targetManifest || {};
  const preset = record?.targetPreset || {};
  const source = record?.sourcePreset || {};
  const loaded = record?.lastLoadedAt ? `上次载入 ${new Date(record.lastLoadedAt).toLocaleString('zh-CN')}` : '尚未载入';
  return {
    title: `${target.templateId || '目标模板'} · ${preset.name || '目标 preset'}`,
    subtitle: `${preset.actionCount || 0} actions · ${source.name || '源 preset'} -> ${preset.name || '目标 preset'}`,
    path: target.manifestPath || '',
    loaded,
  };
}

function renderDerivedTargets() {
  const el = $('derivedTargetsList');
  if (!el) return;
  const records = state.derivedTargets || [];
  if (records.length === 0) {
    el.innerHTML = '<div class="empty">暂无派生目标。生成目标 Preset 后会自动出现在这里。</div>';
    return;
  }
  el.innerHTML = records.map((record) => {
    const summary = derivedTargetSummary(record);
    const exists = derivedTargetPresetExists(record);
    const mappings = Array.isArray(record.appliedMappings) ? record.appliedMappings.length : 0;
    return `
      <div class="derived-target-card ${exists ? '' : 'stale'}">
        <div class="derived-target-main">
          <strong>${escapeHtml(summary.title)}</strong>
          <span>${escapeHtml(summary.subtitle)} · ${mappings} mappings</span>
          <small>${escapeHtml(summary.path)}</small>
          <small>${escapeHtml(summary.loaded)}</small>
        </div>
        ${exists ? '' : '<div class="issue warn"><b>preset_missing</b>目标 preset 不在本地列表中，只能载入模板，不能套用。</div>'}
        <div class="button-row stretch derived-target-buttons">
          <button type="button" class="secondary" data-derived-target-record-action="load" data-id="${escapeHtml(record.id)}">载入模板</button>
          <button type="button" data-derived-target-record-action="load-apply" data-id="${escapeHtml(record.id)}" ${exists ? '' : 'disabled'}>载入并套用</button>
          <button type="button" class="secondary" data-derived-target-record-action="delete" data-id="${escapeHtml(record.id)}">移除记录</button>
        </div>
      </div>
    `;
  }).join('');
}

async function refreshDerivedTargets() {
  const payload = await api('/api/derived-targets');
  state.derivedTargets = Array.isArray(payload.derivedTargets) ? payload.derivedTargets : [];
  renderDerivedTargets();
  return state.derivedTargets;
}

function compatibilityLabel(item) {
  if (!item) return '未检查';
  if (item.status === 'ready') return `可套用 · ${item.normalizedCount || 0} normalized`;
  if (item.status === 'warning') return `需注意 · ${item.normalizedCount || 0} normalized`;
  return `阻断 · ${item.rejectedCount || 0} issue`;
}

function compatibilityTone(item) {
  if (!item) return 'neutral';
  if (item.status === 'ready') return 'ready';
  if (item.status === 'warning') return 'warning';
  return 'blocked';
}

function renderCompatibilityIssue(label, values) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (list.length === 0) return '';
  return `<div class="compat-line"><b>${escapeHtml(label)}</b><span>${escapeHtml(list.join('、'))}</span></div>`;
}

function renderPresetCompatibility(preset, item) {
  if (!preset) return '';
  const tone = compatibilityTone(item);
  const rejected = (item?.rejectedActions || []).map((entry) => `
    <div class="issue err">
      <b>${escapeHtml(entry.code)}</b>${escapeHtml(entry.slotKey ? `${entry.slotKey} · ${entry.message}` : entry.message)}
    </div>
  `).join('');
  const findings = (item?.findings || []).map((entry) => `
    <div class="issue warn">
      <b>${escapeHtml(entry.code)}</b>${escapeHtml(entry.message)}
    </div>
  `).join('');
  return `
    <div class="preset-summary">
      <strong>${escapeHtml(preset.name)}</strong>
      <span>${escapeHtml(presetSummary(preset))}</span>
    </div>
    <div class="compat-card ${tone}">
      <div class="compat-head">
        <strong>${escapeHtml(compatibilityLabel(item))}</strong>
        <span>${item ? `${escapeHtml(item.actionCount)} actions` : '请先检查当前 Manifest'}</span>
      </div>
      ${item ? `
        <div class="compat-lines">
          ${renderCompatibilityIssue('缺失 slot', item.missingSlotKeys)}
          ${renderCompatibilityIssue('缺失素材', item.missingAssetSlotKeys)}
          ${renderCompatibilityIssue('模型未配置', item.modelIssueSlotKeys)}
          ${renderCompatibilityIssue('显隐能力缺失', item.toggleMissingSlotKeys)}
          ${renderCompatibilityIssue('不支持动作', item.unsupportedActionSlotKeys)}
        </div>
        ${(rejected || findings) ? `<div class="issue-list compact">${rejected}${findings}</div>` : ''}
      ` : '<div class="muted">读取真实 Manifest 后点击“检查兼容性”，再套用到动作队列。</div>'}
    </div>
  `;
}

function manifestCandidateLabel(item) {
  const templateId = item.templateId || item.manifestPath?.split('/').slice(-2, -1)[0] || '未知模板';
  const displayName = item.displayName || item.error || '真实 manifest';
  const counts = item.counts
    ? `text ${item.counts.text || 0} / image ${item.counts.image || 0}`
    : '无法读取';
  return `${templateId} · ${displayName} · ${counts}`;
}

function renderManifestCandidateList() {
  const select = $('manifestCandidateSelect');
  if (!select) return;
  const candidates = state.manifestCandidates || [];
  if (candidates.length === 0) {
    select.innerHTML = '<option value="">尚未发现候选</option>';
    return;
  }
  const currentManifest = $('manifestPath')?.value || '';
  select.innerHTML = candidates.map((item) => `
    <option value="${escapeHtml(item.manifestPath || '')}">${escapeHtml(manifestCandidateLabel(item))}</option>
  `).join('');
  const preferred = candidates.find((item) => item.manifestPath && item.manifestPath !== currentManifest && !item.error)
    || candidates.find((item) => item.manifestPath && !item.error)
    || candidates[0];
  if (preferred?.manifestPath) {
    select.value = preferred.manifestPath;
    if (!$('crossManifestPath').value.trim()) $('crossManifestPath').value = preferred.manifestPath;
  }
}

function renderMappingSuggestion(suggestion) {
  const candidates = Array.isArray(suggestion.candidates) ? suggestion.candidates : [];
  return `
    <div class="mapping-suggestion">
      <div>
        <strong>${escapeHtml(suggestion.sourceSlotKey)} · ${escapeHtml(suggestion.capability)}</strong>
        <span>${escapeHtml(suggestion.sourceLayerPath || '源模板未提供 layerPath')}</span>
      </div>
      ${candidates.length ? `
        <label class="field compact mapping-confirm-field">
          <span>确认映射到目标 slot</span>
          <select class="mapping-target-select" data-source-slot-key="${escapeHtml(suggestion.sourceSlotKey)}" data-capability="${escapeHtml(suggestion.capability)}">
            <option value="">不映射 / 手动处理</option>
            ${candidates.map((candidate) => `
              <option value="${escapeHtml(candidate.targetSlotKey)}">${escapeHtml(candidate.targetSlotKey)} · ${escapeHtml(candidate.confidence)} · ${escapeHtml(candidate.reason)}</option>
            `).join('')}
          </select>
        </label>
        <ul>
          ${candidates.map((candidate) => `
            <li>
              <b>${escapeHtml(candidate.targetSlotKey)}</b>
              <span>${escapeHtml(candidate.reason)} · ${escapeHtml(candidate.confidence)}</span>
              <small>${escapeHtml(candidate.targetLayerPath)}</small>
            </li>
          `).join('')}
        </ul>
      ` : '<p class="muted">目标模板没有同能力候选，需要人工处理。</p>'}
    </div>
  `;
}

function renderCrossTemplateResult(payload) {
  state.lastCrossTemplatePayload = payload || null;
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  if (rows.length === 0) {
    setMessage('crossTemplateResults', '<div class="empty">暂无跨模板验证结果。</div>', 'html');
    $('derivePresetBtn').disabled = true;
    return;
  }
  const firstManifest = rows[0]?.manifest || {};
  if (payload?.preset?.name && firstManifest.templateId && !$('derivedPresetName').value.trim()) {
    $('derivedPresetName').value = `${payload.preset.name} -> ${firstManifest.templateId}`;
  }
  $('derivePresetBtn').disabled = false;
  setMessage('crossTemplateResults', rows.map((row) => {
    const manifest = row.manifest || {};
    const mappings = (row.mappingSuggestions || []).map(renderMappingSuggestion).join('');
    const rejected = (row.rejectedActions || []).map((entry) => `
      <div class="issue err">
        <b>${escapeHtml(entry.code)}</b>${escapeHtml(entry.slotKey ? `${entry.slotKey} · ${entry.message}` : entry.message)}
      </div>
    `).join('');
    return `
      <div class="cross-result ${compatibilityTone(row)}">
        <div class="compat-head">
          <strong>${escapeHtml(manifest.templateId || '未知模板')}</strong>
          <span>${escapeHtml(compatibilityLabel(row))}</span>
        </div>
        <div class="cross-manifest-meta">
          <span>${escapeHtml(manifest.displayName || '未命名')}</span>
          <small>${escapeHtml(manifest.manifestPath || '')}</small>
        </div>
        <div class="compat-lines">
          ${renderCompatibilityIssue('缺失 slot', row.missingSlotKeys)}
          ${renderCompatibilityIssue('缺失素材', row.missingAssetSlotKeys)}
          ${renderCompatibilityIssue('模型未配置', row.modelIssueSlotKeys)}
          ${renderCompatibilityIssue('显隐能力缺失', row.toggleMissingSlotKeys)}
          ${renderCompatibilityIssue('不支持动作', row.unsupportedActionSlotKeys)}
        </div>
        ${mappings ? `<div class="mapping-list">${mappings}</div>` : '<div class="muted">没有缺失 slot，暂不需要映射。</div>'}
        ${rejected ? `<div class="issue-list compact">${rejected}</div>` : ''}
      </div>
    `;
  }).join(''), 'html');
}

function collectConfirmedMappings() {
  const mappings = [];
  document.querySelectorAll('.mapping-target-select').forEach((select) => {
    const targetSlotKey = select.value.trim();
    const sourceSlotKey = select.dataset.sourceSlotKey || '';
    const capability = select.dataset.capability || '';
    if (sourceSlotKey && capability && targetSlotKey) {
      mappings.push({ sourceSlotKey, capability, targetSlotKey });
    }
  });
  return mappings;
}

function renderDerivedPresetResult(payload) {
  state.lastDerivedPresetPayload = payload || null;
  const tone = payload?.saved ? 'ready' : 'blocked';
  const preset = payload?.preset || {};
  const target = payload?.targetManifest || {};
  const applied = (payload?.appliedMappings || []).map((item) => `
    <div class="compat-line">
      <b>${escapeHtml(item.capability)}</b>
      <span>${escapeHtml(item.sourceSlotKey)} -> ${escapeHtml(item.targetSlotKey)} · ${escapeHtml(item.targetLayerPath || '')}</span>
    </div>
  `).join('');
  const changes = (payload?.changes || []).map((item) => `
    <div class="issue ${item.mode === 'unmapped' ? 'err' : item.mode === 'mapped' ? 'ok' : 'warn'}">
      <b>${escapeHtml(item.mode)}</b>${escapeHtml(`${item.sourceSlotKey || '-'} -> ${item.targetSlotKey || '-'} · ${item.type || '-'}${item.capability ? ` · ${item.capability}` : ''}`)}
    </div>
  `).join('');
  const compatibility = payload?.compatibility
    ? renderPresetCompatibility({
      name: preset.name || payload?.compatibility?.name || '派生 preset 预览',
      actionCount: payload.compatibility.actionCount,
      slotKeys: payload.compatibility.slotKeys,
      templateId: target.templateId,
      templateDisplayName: target.displayName,
    }, payload.compatibility)
    : '';
  return `
    <div class="preflight-status ${tone}">
      <strong>${payload?.saved ? '目标 preset 已生成' : '目标 preset 未保存'}</strong>
      <span>${escapeHtml(payload?.reason || '')}</span>
    </div>
    ${payload?.saved ? `
      <div class="preset-summary">
        <strong>${escapeHtml(preset.name || '')}</strong>
        <span>${escapeHtml(target.templateId || '')} · ${escapeHtml(target.manifestPath || '')}</span>
      </div>
      <div class="button-row stretch derived-target-actions">
        <button type="button" class="secondary" data-derived-target-action="load">载入目标模板</button>
        <button type="button" data-derived-target-action="load-apply">载入并套用 Preset</button>
      </div>
      <p class="hint">切换目标模板会清空当前动作队列，避免源模板动作混入目标模板。</p>
    ` : ''}
    ${applied ? `<div class="compat-card ready"><div class="compat-lines">${applied}</div></div>` : ''}
    ${compatibility}
    ${changes ? `<div class="issue-list compact">${changes}</div>` : ''}
  `;
}

function renderPresetList() {
  const select = $('presetSelect');
  if (!select) return;
  const current = select.value;
  const presets = state.presets || [];
  if (presets.length === 0) {
    select.innerHTML = '<option value="">暂无 preset</option>';
    $('applyPresetBtn').disabled = true;
    $('checkPresetCompatibilityBtn').disabled = true;
    $('deletePresetBtn').disabled = true;
    return;
  }
  select.innerHTML = presets.map((preset) => (
    `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)} · ${escapeHtml(compatibilityLabel(presetCompatibility(preset.id)))}</option>`
  )).join('');
  if (presets.some((preset) => preset.id === current)) select.value = current;
  $('applyPresetBtn').disabled = false;
  $('checkPresetCompatibilityBtn').disabled = false;
  $('deletePresetBtn').disabled = false;
}

function selectedPreset() {
  const id = $('presetSelect')?.value || '';
  return (state.presets || []).find((preset) => preset.id === id) || null;
}

function actionForPreset(action) {
  const { id: _id, ...rest } = action;
  return rest;
}

function actionsForPreset() {
  return state.uiActions.map(actionForPreset);
}

async function refreshPresets() {
  const payload = await api('/api/presets');
  state.presets = Array.isArray(payload.presets) ? payload.presets : [];
  renderPresetList();
  renderDerivedTargets();
  return state.presets;
}

async function refreshPresetCompatibility(presetId = '') {
  if (!state.inspection) {
    setMessage('presetResults', '<div class="issue err"><b>manifest_missing</b>请先读取真实 Manifest。</div>', 'html');
    return [];
  }
  const payload = await api('/api/presets/compatibility', {
    method: 'POST',
    body: JSON.stringify({
      manifestPath: $('manifestPath').value,
      ...(presetId ? { presetId } : {}),
    }),
  });
  const next = Array.isArray(payload.compatibilities) ? payload.compatibilities : [];
  if (presetId) {
    state.presetCompatibility = [
      ...next,
      ...(state.presetCompatibility || []).filter((item) => item.presetId !== presetId),
    ];
  } else {
    state.presetCompatibility = next;
  }
  renderPresetList();
  return next;
}

async function discoverManifests() {
  setMessage('crossTemplateResults', '<div class="empty">正在发现本机真实 manifest...</div>', 'html');
  const payload = await api('/api/manifests/discover');
  state.manifestCandidates = Array.isArray(payload.manifests) ? payload.manifests : [];
  renderManifestCandidateList();
  setMessage('crossTemplateResults', `
    <div class="preflight-status ready">
      <strong>已发现 Manifest</strong>
      <span>${state.manifestCandidates.length} 个真实候选</span>
    </div>
  `, 'html');
  return state.manifestCandidates;
}

async function runCrossTemplateValidation() {
  const preset = selectedPreset();
  if (!preset) {
    setMessage('crossTemplateResults', '<div class="issue err"><b>preset_missing</b>请选择一个已保存 preset。</div>', 'html');
    return;
  }
  const manifestPath = $('crossManifestPath').value.trim();
  if (!manifestPath) {
    setMessage('crossTemplateResults', '<div class="issue err"><b>manifest_missing</b>请填写或发现第二个真实 manifest。</div>', 'html');
    return;
  }
  setMessage('crossTemplateResults', '<div class="empty">正在跨模板预检...</div>', 'html');
  const payload = await api('/api/presets/cross-template', {
    method: 'POST',
    body: JSON.stringify({
      presetId: preset.id,
      currentManifestPath: $('manifestPath').value,
      manifestPaths: [manifestPath],
    }),
  });
  renderCrossTemplateResult(payload);
  setMessage('derivePresetResults', '');
  return payload;
}

async function deriveCrossTemplatePreset() {
  const preset = selectedPreset();
  if (!preset) {
    setMessage('derivePresetResults', '<div class="issue err"><b>preset_missing</b>请选择一个已保存 preset。</div>', 'html');
    return;
  }
  const targetManifestPath = $('crossManifestPath').value.trim();
  if (!targetManifestPath) {
    setMessage('derivePresetResults', '<div class="issue err"><b>manifest_missing</b>请先填写第二 Manifest 路径。</div>', 'html');
    return;
  }
  const mappingSelects = document.querySelectorAll('.mapping-target-select');
  const mappings = collectConfirmedMappings();
  if (mappingSelects.length > 0 && mappings.length === 0) {
    setMessage('derivePresetResults', '<div class="issue err"><b>mapping_required</b>请至少选择一个候选映射；不确认时不会自动改写 slot。</div>', 'html');
    return;
  }
  setMessage('derivePresetResults', '<div class="empty">正在按确认映射派生目标 preset，并用目标 manifest 二次预检...</div>', 'html');
  const payload = await api('/api/presets/derive-cross-template', {
    method: 'POST',
    body: JSON.stringify({
      presetId: preset.id,
      targetManifestPath,
      name: $('derivedPresetName').value.trim(),
      mappings,
    }),
  });
  if (payload.saved && payload.preset?.id) {
    await refreshPresets();
    await refreshDerivedTargets();
    $('presetSelect').value = payload.preset.id;
    renderPresetList();
  }
  setMessage('derivePresetResults', renderDerivedPresetResult(payload), 'html');
  return payload;
}

async function saveCurrentPreset() {
  const name = $('presetName').value.trim();
  if (!name) {
    setMessage('presetResults', '<div class="issue err"><b>preset_name_missing</b>请先填写 preset 名称。</div>', 'html');
    return;
  }
  if (state.uiActions.length === 0) {
    setMessage('presetResults', '<div class="issue err"><b>preset_queue_empty</b>当前动作队列为空，不能保存。</div>', 'html');
    return;
  }
  const payload = await api('/api/presets', {
    method: 'POST',
    body: JSON.stringify({
      name,
      templateId: state.inspection?.templateId || null,
      templateDisplayName: state.inspection?.displayName || null,
      uiActions: actionsForPreset(),
    }),
  });
  await refreshPresets();
  $('presetSelect').value = payload.preset.id;
  if (state.inspection) {
    await refreshPresetCompatibility(payload.preset.id);
  }
  const compatibility = presetCompatibility(payload.preset.id);
  setMessage('presetResults', `
    <div class="preflight-status ready">
      <strong>Preset 已保存</strong>
      <span>${escapeHtml(presetSummary(payload.preset))}</span>
    </div>
    ${renderPresetCompatibility(payload.preset, compatibility)}
  `, 'html');
}

async function applySelectedPreset(options = {}) {
  const preset = options.preset || selectedPreset();
  const resultId = options.resultId || 'presetResults';
  const successTitle = options.successTitle || 'Preset 已套用';
  if (!preset) {
    setMessage(resultId, '<div class="issue err"><b>preset_missing</b>请选择一个已保存 preset。</div>', 'html');
    return;
  }
  if (!state.inspection) {
    setMessage(resultId, '<div class="issue err"><b>manifest_missing</b>请先读取真实 Manifest。</div>', 'html');
    return;
  }
  const compatibilities = await refreshPresetCompatibility(preset.id);
  const compatibility = compatibilities[0] || presetCompatibility(preset.id);
  if (!compatibility || compatibility.status === 'blocked') {
    setMessage(resultId, `
      <div class="preflight-status blocked">
        <strong>Preset 兼容性阻断</strong>
        <span>${escapeHtml(preset.name)}</span>
      </div>
      ${renderPresetCompatibility(preset, compatibility)}
    `, 'html');
    return;
  }
  if (options.replaceQueue) resetActionQueue();
  const actions = Array.isArray(preset.uiActions) ? preset.uiActions.map(actionForPreset) : [];
  addActions(actions);
  setMessage(resultId, `
    <div class="preflight-status ready">
      <strong>${escapeHtml(successTitle)}</strong>
      <span>${escapeHtml(preset.name)} · ${compatibility.normalizedCount || 0} 个 normalized action</span>
    </div>
    ${renderPresetCompatibility(preset, compatibility)}
  `, 'html');
}

function payloadFromDerivedTargetRecord(record) {
  if (!record) return null;
  const presetId = record.targetPreset?.id || '';
  const preset = (state.presets || []).find((item) => item.id === presetId) || {
    id: presetId,
    name: record.targetPreset?.name || '目标 preset',
    actionCount: record.targetPreset?.actionCount || 0,
    slotKeys: record.targetPreset?.slotKeys || [],
    uiActions: [],
  };
  return {
    saved: true,
    reason: '已从最近目标模板记录恢复。',
    preset,
    sourcePreset: record.sourcePreset,
    targetManifest: record.targetManifest,
    appliedMappings: record.appliedMappings || [],
    derivedTargetRecord: record,
  };
}

async function loadTargetTemplateFromPayload(payload, { applyPreset = false, resultId = 'derivePresetResults' } = {}) {
  if (!payload?.saved || !payload?.targetManifest?.manifestPath) {
    setMessage(resultId, '<div class="issue err"><b>derived_target_missing</b>请先生成已保存的目标模板 preset。</div>', 'html');
    return;
  }
  const target = payload.targetManifest;
  const presetId = payload.preset?.id || '';
  $('manifestPath').value = target.manifestPath || '';
  $('psdPath').value = target.psdPath || '';
  resetActionQueue();
  setMessage(resultId, '<div class="empty">正在载入目标模板真实 manifest...</div>', 'html');
  await loadManifest();
  await refreshPresets();
  if (presetId && (state.presets || []).some((preset) => preset.id === presetId)) {
    $('presetSelect').value = presetId;
    renderPresetList();
  }
  const recordId = payload.derivedTargetRecord?.id || payload.derivedTarget?.id || '';
  if (recordId) {
    await api(`/api/derived-targets/${encodeURIComponent(recordId)}/loaded`, { method: 'POST', body: '{}' });
    await refreshDerivedTargets();
  }
  if (applyPreset) {
    const preset = (state.presets || []).find((item) => item.id === presetId) || null;
    if (!preset) {
      setMessage(resultId, `
        <div class="preflight-status blocked">
          <strong>目标模板已载入，但 preset 缺失</strong>
          <span>${escapeHtml(payload.preset?.name || presetId || '未知 preset')}</span>
        </div>
      `, 'html');
      return;
    }
    await applySelectedPreset({
      preset,
      replaceQueue: true,
      resultId,
      successTitle: '目标模板已载入并套用 Preset',
    });
    return;
  }
  setMessage(resultId, `
    <div class="preflight-status ready">
      <strong>目标模板已载入</strong>
      <span>${escapeHtml(target.templateId || target.manifestPath)}</span>
    </div>
    ${renderDerivedPresetResult(payload)}
  `, 'html');
}

async function loadDerivedTargetTemplate({ applyPreset = false } = {}) {
  return loadTargetTemplateFromPayload(state.lastDerivedPresetPayload, {
    applyPreset,
    resultId: 'derivePresetResults',
  });
}

async function loadDerivedTargetRecord(record, { applyPreset = false } = {}) {
  const payload = payloadFromDerivedTargetRecord(record);
  return loadTargetTemplateFromPayload(payload, {
    applyPreset,
    resultId: 'presetResults',
  });
}

async function deleteSelectedPreset() {
  const preset = selectedPreset();
  if (!preset) return;
  await api(`/api/presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
  state.presetCompatibility = (state.presetCompatibility || []).filter((item) => item.presetId !== preset.id);
  await refreshPresets();
  setMessage('presetResults', `
    <div class="preflight-status blocked">
      <strong>Preset 已删除</strong>
      <span>${escapeHtml(preset.name)}</span>
    </div>
  `, 'html');
}

function renderPreflight() {
  const preflight = state.preflight;
  if (!preflight) {
    $('preflightResults').innerHTML = '<div class="empty">预检尚未运行。</div>';
    $('createJobBtn').disabled = true;
    return;
  }
  const ready = preflight.status === 'ready' && preflight.normalizedActions.length > 0;
  $('createJobBtn').disabled = !ready;
  const rejected = preflight.rejectedActions || [];
  const findings = preflight.findings || [];
  const normalized = preflight.normalizedActions || [];
  $('preflightResults').innerHTML = `
    <div class="preflight-status ${preflight.status}">
      <strong>${preflight.status === 'ready' ? '预检通过' : '预检阻断'}</strong>
      <span>${normalized.length} 个 normalized action · ${rejected.length} 个阻断</span>
    </div>
    ${rejected.length ? `
      <div class="issue-list">
        ${rejected.map((item) => `<div class="issue err"><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</div>`).join('')}
      </div>
    ` : ''}
    ${findings.length ? `
      <div class="issue-list">
        ${findings.map((item) => `<div class="issue warn"><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</div>`).join('')}
      </div>
    ` : ''}
    <pre>${escapeHtml(pretty(normalized))}</pre>
  `;
}

async function refresh() {
  const payload = await api('/api/status');
  renderStatus(payload);
  await refreshLatestFinalJob({ silent: true });
}

async function loadManifest() {
  setMessage('designResults', '正在读取真实 manifest...');
  const payload = await api('/api/manifest/inspect', {
    method: 'POST',
    body: JSON.stringify({ manifestPath: $('manifestPath').value, psdPath: $('psdPath').value }),
  });
  state.inspection = payload.inspection;
  state.previewImagePathOverride = null;
  const firstSlot = state.inspection.slots[0];
  state.selectedSlotKey = firstSlot ? firstSlot.key : null;
  state.preflight = null;
  renderSlots();
  renderSlotDetail();
  fitTemplatePreview();
  renderPreflight();
  if ((state.presets || []).length > 0) {
    await refreshPresetCompatibility();
  }
  setMessage('designResults', {
    templateId: state.inspection.templateId,
    displayName: state.inspection.displayName,
    manifestPath: state.inspection.manifestPath,
    document: state.inspection.document,
    previewImagePath: state.inspection.previewImagePath,
    layerDump: state.inspection.layerDump,
    counts: state.inspection.counts,
  });
}

async function runPreflight() {
  if (!state.inspection) {
    setMessage('preflightResults', '<div class="empty">请先读取 manifest。</div>', 'html');
    return;
  }
  try {
    const payload = await api('/api/jobs/preflight', {
      method: 'POST',
      body: JSON.stringify({
        manifestPath: $('manifestPath').value,
        uiActions: state.uiActions,
      }),
    });
    state.preflight = payload.preflight;
    renderPreflight();
  } catch (error) {
    state.preflight = error.payload?.details || null;
    renderPreflight();
    if (!state.preflight) setMessage('preflightResults', `<div class="issue err">${escapeHtml(error.message)}</div>`, 'html');
  }
}

function jobStatusTone(status) {
  if (status === 'preview_ready' || status === 'final_exported') return 'ready';
  if (status === 'failed' || status === 'error') return 'blocked';
  return 'running';
}

function artifactEntries(artifacts) {
  return Object.entries(artifacts || {}).filter(([, value]) => typeof value === 'string' && value.trim());
}

function syncFeishuArtifactFields(artifacts) {
  if (!artifacts || typeof artifacts !== 'object') return;
  if (artifacts.finalImagePath) $('finalImagePath').value = artifacts.finalImagePath;
  if (artifacts.editablePsdPath) $('finalFilePath').value = artifacts.editablePsdPath;
  if (artifacts.previewImagePath || artifacts.finalImagePath) {
    state.previewImagePathOverride = artifacts.previewImagePath || artifacts.finalImagePath;
    renderTemplatePreview();
  }
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return '-';
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function fileNameFromPath(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '-';
}

function formatLocalDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toLocaleString('zh-CN');
  return date.toLocaleString('zh-CN');
}

function feishuTargetLabel(target) {
  if (!target) return '未选择';
  const prefix = target.type === 'chat' ? '群聊' : '用户';
  const source = target.source === 'env' ? '默认配置' : '手动填写';
  return `${prefix}:${target.value} (${source})`;
}

function setFeishuBusy(busy, label = '发送中...') {
  const sendButton = $('sendFeishuBtn');
  if (sendButton) {
    sendButton.textContent = busy ? label : '发送 PNG 成品';
    sendButton.disabled = busy;
  }
  if ($('preflightFeishuBtn')) $('preflightFeishuBtn').disabled = busy;
  if ($('backfillLatestFinalBtn')) $('backfillLatestFinalBtn').disabled = busy;
  if ($('loadRecentAndSendBtn')) $('loadRecentAndSendBtn').disabled = busy;
  if (!busy) renderFeishuReadiness();
}

function activeFeishuTarget() {
  const chatId = $('feishuChatId')?.value?.trim() || '';
  const userId = $('feishuUserId')?.value?.trim() || '';
  const label = $('feishuTargetLabel')?.value?.trim() || '';
  if (chatId) return { type: 'chat', value: chatId, label };
  if (userId) return { type: 'user', value: userId, label };
  return null;
}

function hasDefaultFeishuTarget() {
  return Boolean(state.status?.feishu?.hasChatTarget || state.status?.feishu?.hasUserTarget);
}

function feishuReadiness() {
  const finalImagePath = $('finalImagePath')?.value?.trim() || '';
  const target = activeFeishuTarget();
  const defaultTargetReady = hasDefaultFeishuTarget();
  const targetReady = Boolean(target || defaultTargetReady);
  const targetLabel = target
    ? feishuTargetLabel({ ...target, source: 'body' })
    : defaultTargetReady
      ? '默认飞书目标'
      : '未选择飞书目标';
  return {
    ready: Boolean(finalImagePath && targetReady),
    finalImagePath,
    finalReady: Boolean(finalImagePath),
    targetReady,
    targetLabel,
  };
}

function renderFeishuReadiness() {
  const el = $('feishuReadinessStatus');
  if (!el) return feishuReadiness();
  const readiness = feishuReadiness();
  const missing = [
    readiness.targetReady ? '' : '缺少飞书目标',
    readiness.finalReady ? '' : '缺少 final.png 路径',
  ].filter(Boolean);
  el.innerHTML = `
    <div class="target-dot ${readiness.ready ? 'ok' : 'warn'}"></div>
    <span>${readiness.ready ? '发送条件已具备' : '发送条件未齐'}</span>
    <small>${escapeHtml(readiness.ready ? `${readiness.targetLabel} · ${fileNameFromPath(readiness.finalImagePath)}` : missing.join('；'))}</small>
  `;
  const sendButton = $('sendFeishuBtn');
  if (sendButton) {
    sendButton.disabled = !readiness.ready;
    sendButton.title = readiness.ready ? '发送当前 final.png 到飞书目标' : missing.join('；');
  }
  return readiness;
}

function renderFeishuReadinessBlock(readiness) {
  const missing = [
    readiness.targetReady ? '' : '缺少飞书目标',
    readiness.finalReady ? '' : '缺少 final.png 路径',
  ].filter(Boolean);
  setMessage('feishuResults', `
    <div class="job-status blocked">
      <strong>发送条件未齐</strong>
      <span>blocked</span>
    </div>
    <div class="issue err"><b>ready_gate</b>${escapeHtml(missing.join('；'))}</div>
    <div class="artifact-list">
      <div><strong>Target</strong><span>${escapeHtml(readiness.targetLabel)}</span></div>
      <div><strong>final.png</strong><span>${escapeHtml(readiness.finalImagePath || '-')}</span></div>
      <div><strong>PSD</strong><span>仅本地保存，不发送</span></div>
    </div>
  `, 'html');
}

function fillFeishuTarget(target) {
  if (!target) return;
  if (target.type === 'chat') {
    $('feishuChatId').value = target.value || '';
    $('feishuUserId').value = '';
  } else {
    $('feishuUserId').value = target.value || '';
    $('feishuChatId').value = '';
  }
  if ($('feishuTargetLabel')) $('feishuTargetLabel').value = target.label || '';
  setMessage('feishuResults', `
    <div class="job-status ready">
      <strong>已载入飞书目标</strong>
      <span>${escapeHtml(feishuTargetLabel({ ...target, source: 'body' }))}</span>
    </div>
    <div class="artifact-list">
      <div><strong>发送目标</strong><span>${escapeHtml(target.label || target.value || '-')}</span></div>
      <div><strong>PSD</strong><span>仅本地保存，不发送</span></div>
    </div>
  `, 'html');
  renderFeishuReadiness();
}

function newestFeishuTarget() {
  const targets = Array.isArray(state.feishuTargets) ? state.feishuTargets : [];
  return [...targets].sort((a, b) => {
    const aTime = Date.parse(a.lastUsedAt || a.updatedAt || a.createdAt || '') || 0;
    const bTime = Date.parse(b.lastUsedAt || b.updatedAt || b.createdAt || '') || 0;
    return bTime - aTime;
  })[0] || null;
}

function targetLastUsedLabel(target) {
  if (target.lastUsedAt) return `上次发送 ${formatLocalDateTime(target.lastUsedAt)}`;
  if (target.updatedAt) return `更新 ${formatLocalDateTime(target.updatedAt)}`;
  return '尚未发送';
}

function renderFeishuTargets() {
  const el = $('feishuTargetList');
  if (!el) return;
  const targets = state.feishuTargets || [];
  if (targets.length === 0) {
    el.innerHTML = '<div class="empty">暂无本地保存的飞书目标。</div>';
    return;
  }
  el.innerHTML = targets.map((target) => `
    <div class="feishu-target-card">
      <div class="feishu-target-main">
        <strong>${escapeHtml(target.label || (target.type === 'chat' ? '群聊目标' : '用户目标'))}</strong>
        <span>${escapeHtml(target.type === 'chat' ? `chat:${target.value}` : `user:${target.value}`)}</span>
        <small>${escapeHtml(targetLastUsedLabel(target))}</small>
      </div>
      <div class="button-row stretch feishu-target-buttons">
        <button type="button" data-feishu-target-action="use" data-id="${escapeHtml(target.id)}">使用</button>
        <button type="button" class="secondary" data-feishu-target-action="preflight" data-id="${escapeHtml(target.id)}">载入并预检</button>
        <button type="button" class="secondary" data-feishu-target-action="delete" data-id="${escapeHtml(target.id)}">删除</button>
      </div>
    </div>
  `).join('');
}

function sendHistoryTargetLabel(record) {
  const target = record?.target;
  if (!target?.value) return '未选择目标';
  return feishuTargetLabel(target);
}

function sendHistoryImageLabel(record) {
  const image = record?.finalImage || {};
  return [
    image.fileName || fileNameFromPath(image.path || ''),
    image.sizeBytes ? formatBytes(image.sizeBytes) : '',
    image.delivery || '',
  ].filter(Boolean).join(' · ') || '-';
}

function targetFromSendHistory(record) {
  const target = record?.target || {};
  if (!target.value || (target.type !== 'chat' && target.type !== 'user')) return null;
  return {
    type: target.type,
    value: target.value,
    label: `发送历史 · ${target.type === 'chat' ? '群聊' : '用户'}`,
  };
}

function fillFeishuFromHistoryRecord(record, { includeImage = false } = {}) {
  const target = targetFromSendHistory(record);
  if (!target) throw new Error('这条发送历史没有可复用的飞书目标。');
  fillFeishuTarget(target);
  if (includeImage && record?.finalImage?.path) {
    $('finalImagePath').value = record.finalImage.path;
  }
  renderFeishuReadiness();
  setMessage('feishuResults', `
    <div class="job-status ready">
      <strong>${includeImage ? '已复用历史目标与文件' : '已复用历史目标'}</strong>
      <span>${escapeHtml(feishuTargetLabel({ ...target, source: 'body' }))}</span>
    </div>
    <div class="artifact-list">
      <div><strong>final.png</strong><span>${escapeHtml(includeImage ? (record?.finalImage?.path || '-') : ($('finalImagePath').value.trim() || '-'))}</span></div>
      <div><strong>PSD</strong><span>仅本地保存，不发送</span></div>
    </div>
  `, 'html');
}

function renderFeishuSendHistory() {
  const el = $('feishuSendHistory');
  if (!el) return;
  const history = state.feishuSendHistory || [];
  if (history.length === 0) {
    el.innerHTML = '<div class="empty">暂无发送历史。下一次发送或发送失败会记录在这里。</div>';
    return;
  }
  el.innerHTML = history.slice(0, 8).map((record) => {
    const findings = Array.isArray(record.findings) && record.findings.length
      ? ` · ${record.findings.map((item) => item.code || item.message || '').filter(Boolean).join('、')}`
      : '';
    const canReuse = Boolean(targetFromSendHistory(record));
    return `
      <div class="send-history-card ${escapeHtml(record.status || 'failed')}">
        <strong>${escapeHtml(record.status === 'sent' ? '已发送' : '发送失败')} · ${escapeHtml(formatLocalDateTime(record.createdAt))}</strong>
        <span>${escapeHtml(sendHistoryTargetLabel(record))}</span>
        <small>${escapeHtml(sendHistoryImageLabel(record))}</small>
        <small>${escapeHtml(record.status === 'sent' ? `messages ${record.messageCount || 0} · PSD ${record.psdDelivery || 'local_only'}` : `${record.error || '未知错误'}${findings}`)}</small>
        ${canReuse ? `
          <div class="button-row stretch send-history-actions">
            <button type="button" class="secondary small" data-feishu-history-action="reuse-target" data-id="${escapeHtml(record.id)}">复用目标</button>
            <button type="button" class="secondary small" data-feishu-history-action="reuse-preflight" data-id="${escapeHtml(record.id)}">复用并预检</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function refreshFeishuSendHistory() {
  const payload = await api('/api/feishu/send-history');
  state.feishuSendHistory = Array.isArray(payload.history) ? payload.history : [];
  renderFeishuSendHistory();
  return state.feishuSendHistory;
}

async function refreshFeishuTargets() {
  const payload = await api('/api/feishu/targets');
  state.feishuTargets = Array.isArray(payload.targets) ? payload.targets : [];
  renderFeishuTargets();
  renderFeishuDefaultStatus(state.status?.feishu || {});
  renderFeishuReadiness();
  return state.feishuTargets;
}

async function saveCurrentFeishuTarget() {
  const target = activeFeishuTarget();
  if (!target) throw new Error('请先填写真实 Chat ID 或 User ID。');
  const payload = await api('/api/feishu/targets', {
    method: 'POST',
    body: JSON.stringify(target),
  });
  state.feishuTargets = Array.isArray(payload.targets) ? payload.targets : [];
  renderFeishuTargets();
  renderFeishuDefaultStatus(state.status?.feishu || {});
  renderFeishuReadiness();
  setMessage('feishuResults', `
    <div class="job-status ready">
      <strong>已保存飞书目标</strong>
      <span>${escapeHtml(feishuTargetLabel({ ...payload.target, source: 'body' }))}</span>
    </div>
    <div class="artifact-list">
      <div><strong>备注</strong><span>${escapeHtml(payload.target?.label || '-')}</span></div>
      <div><strong>发送</strong><span>未发送消息，仅保存本地目标</span></div>
    </div>
  `, 'html');
}

async function deleteFeishuTarget(id) {
  const payload = await api(`/api/feishu/targets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: '{}',
  });
  state.feishuTargets = Array.isArray(payload.targets) ? payload.targets : [];
  renderFeishuTargets();
  renderFeishuDefaultStatus(state.status?.feishu || {});
  renderFeishuReadiness();
}

function renderLatestFinalStatus(latest) {
  const el = $('latestFinalStatus');
  if (!el) return;
  if (!latest?.found) {
    el.innerHTML = `
      <div class="target-dot warn"></div>
      <span>暂无可回填的最终 PNG</span>
      <small>${escapeHtml(latest?.reason || '完成高清导出后会自动回填')}</small>
    `;
    return;
  }
  const sessionId = latest.session?.sessionId || '-';
  const finalSize = latest.files?.finalImage?.size;
  const resultStatus = latest.jobState?.result?.status || 'final_exported';
  const readiness = feishuReadiness();
  const sendHint = readiness.targetReady ? '可回填并发送' : '等待飞书目标';
  el.innerHTML = `
    <div class="target-dot ok"></div>
    <span>已发现最近最终 PNG</span>
    <small>${escapeHtml(sessionId)} · ${escapeHtml(resultStatus)} · ${escapeHtml(formatBytes(finalSize))} · ${escapeHtml(sendHint)}</small>
  `;
}

async function refreshLatestFinalJob(options = {}) {
  const payload = await api('/api/jobs/latest-final');
  const latest = payload.latestFinalJob || { found: false };
  state.latestFinalJob = latest;
  renderLatestFinalStatus(latest);
  if (!latest.found) return latest;
  const artifacts = latest.artifacts || {};
  const finalImagePath = String(artifacts.finalImagePath || '').trim();
  const currentFinalPath = $('finalImagePath').value.trim();
  const shouldFill = Boolean(finalImagePath) && (
    options.force
    || !currentFinalPath
    || currentFinalPath === state.lastAutoFinalImagePath
  );
  if (shouldFill) {
    syncFeishuArtifactFields(artifacts);
    state.lastAutoFinalImagePath = finalImagePath;
    renderFeishuReadiness();
    renderLatestFinalStatus(latest);
    if (!options.silent) {
      setMessage('feishuResults', `
        <div class="job-status ready">
          <strong>已回填最近成品</strong>
          <span>${escapeHtml(latest.session?.sessionId || '')}</span>
        </div>
        <div class="artifact-list">
          <div><strong>finalImagePath</strong><span>${escapeHtml(finalImagePath)}</span></div>
          <div><strong>editablePsdPath</strong><span>${escapeHtml(artifacts.editablePsdPath || 'PSD 仅本地保存')}</span></div>
        </div>
      `, 'html');
    }
  }
  return latest;
}

function renderJobStatus(payload, label = 'Photoshop job') {
  const session = payload.session || {};
  const jobState = payload.jobState || {};
  const result = jobState.result || {};
  const artifacts = result.artifacts || {};
  const status = result.status || jobState.status || session.status || 'queued';
  const sessionId = session.sessionId || state.lastSessionId || '-';
  const error = result.error || jobState.error || payload.error || '';
  syncFeishuArtifactFields(artifacts);
  renderFeishuReadiness();
  $('confirmFinalBtn').disabled = !(sessionId && status === 'preview_ready');

  const artifactList = artifactEntries(artifacts);
  setMessage('jobResults', `
    <div class="job-status ${jobStatusTone(status)}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(status)}</span>
    </div>
    <dl class="job-meta">
      <div><dt>Session</dt><dd>${escapeHtml(sessionId)}</dd></div>
      <div><dt>Session Status</dt><dd>${escapeHtml(session.status || '-')}</dd></div>
      <div><dt>Job Result</dt><dd>${escapeHtml(result.status || '-')}</dd></div>
    </dl>
    ${error ? `<div class="issue err"><b>error</b>${escapeHtml(error)}</div>` : ''}
    ${artifactList.length ? `
      <div class="artifact-list">
        ${artifactList.map(([key, value]) => `
          <div>
            <strong>${escapeHtml(key)}</strong>
            <span>${escapeHtml(value)}</span>
          </div>
        `).join('')}
      </div>
    ` : '<div class="muted">尚未生成产物路径。</div>'}
  `, 'html');
}

function feishuPayload() {
  return {
    chatId: $('feishuChatId').value.trim(),
    userId: $('feishuUserId').value.trim(),
    text: 'PS 自动化任务已完成，以下为最终 PNG 成品。PSD 已保存在本地，不随飞书发送。',
    imagePath: $('finalImagePath').value.trim(),
  };
}

function renderFeishuPreflight(preflight) {
  const target = feishuTargetLabel(preflight.target);
  const artifacts = (preflight.artifacts || []).map((item) => `
    <div>
      <strong>${escapeHtml(item.key)}</strong>
      <span>${escapeHtml(item.path || '-')} · ${item.exists ? '存在' : '未找到'}${item.required ? ' · 必填' : ''}${item.delivery ? ` · ${escapeHtml(item.delivery)}` : ''}</span>
    </div>
  `).join('');
  const findings = (preflight.findings || []).map((item) => (
    `<div class="issue err"><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</div>`
  )).join('');
  setMessage('feishuResults', `
    <div class="job-status ${preflight.status === 'ready' ? 'ready' : 'blocked'}">
      <strong>飞书发送预检</strong>
      <span>${escapeHtml(preflight.status)}</span>
    </div>
    <dl class="job-meta">
      <div><dt>Target</dt><dd>${escapeHtml(target)}</dd></div>
    </dl>
    ${findings}
    <div class="artifact-list">${artifacts}</div>
  `, 'html');
}

function renderFeishuProgress(title, detail = '') {
  setMessage('feishuResults', `
    <div class="job-status running">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail || 'running')}</span>
    </div>
    <div class="artifact-list">
      <div><strong>final.png</strong><span>${escapeHtml($('finalImagePath').value.trim() || '-')}</span></div>
      <div><strong>PSD</strong><span>仅本地保存，不发送</span></div>
    </div>
  `, 'html');
}

function renderFeishuSendReceipt(payload) {
  const receipt = payload?.receipt || {};
  const finalImage = receipt.finalImage || {};
  const preflightArtifact = (payload?.preflight?.artifacts || []).find((item) => item.key === 'imagePath') || {};
  const imagePath = finalImage.path || preflightArtifact.path || $('finalImagePath').value.trim();
  const fileName = finalImage.fileName || fileNameFromPath(imagePath);
  const sizeBytes = finalImage.sizeBytes ?? preflightArtifact.sizeBytes;
  const delivery = finalImage.delivery || preflightArtifact.delivery || '-';
  setMessage('feishuResults', `
    <div class="job-status ready">
      <strong>已发送 PNG 成品</strong>
      <span>${escapeHtml(formatLocalDateTime(receipt.sentAt))}</span>
    </div>
    <dl class="job-meta">
      <div><dt>Target</dt><dd>${escapeHtml(feishuTargetLabel(receipt.target || payload?.preflight?.target))}</dd></div>
      <div><dt>File</dt><dd>${escapeHtml(fileName)}</dd></div>
      <div><dt>Size</dt><dd>${escapeHtml(formatBytes(sizeBytes))}</dd></div>
      <div><dt>Delivery</dt><dd>${escapeHtml(delivery)}</dd></div>
      <div><dt>Messages</dt><dd>${escapeHtml(receipt.messageCount || '-')}</dd></div>
    </dl>
    <div class="artifact-list">
      <div><strong>final.png</strong><span>${escapeHtml(imagePath || '-')}</span></div>
      <div><strong>PSD</strong><span>仅本地保存，不发送</span></div>
    </div>
  `, 'html');
}

function renderFeishuSendError(error) {
  const payload = error?.payload || {};
  const details = payload.details;
  const findings = Array.isArray(details?.findings)
    ? details.findings.map((item) => `<div class="issue err"><b>${escapeHtml(item.code)}</b>${escapeHtml(item.message)}</div>`).join('')
    : '';
  setMessage('feishuResults', `
    <div class="job-status blocked">
      <strong>发送失败</strong>
      <span>${escapeHtml(formatLocalDateTime())}</span>
    </div>
    <div class="issue err"><b>error</b>${escapeHtml(payload.error || error.message || '未知错误')}</div>
    ${findings}
    <div class="artifact-list">
      <div><strong>final.png</strong><span>${escapeHtml($('finalImagePath').value.trim() || '-')}</span></div>
      <div><strong>PSD</strong><span>仅本地保存，不发送</span></div>
    </div>
    <div class="button-row stretch retry-actions">
      <button id="retryFeishuSendBtn" type="button">重试发送</button>
      <button id="retryFeishuPreflightBtn" type="button" class="secondary">重新预检</button>
    </div>
  `, 'html');
  $('retryFeishuSendBtn')?.addEventListener('click', () => void sendFeishuFinal());
  $('retryFeishuPreflightBtn')?.addEventListener('click', async () => {
    try {
      setFeishuBusy(true, '预检中...');
      renderFeishuProgress('发送前预检', 'checking');
      await preflightFeishu();
    } catch (retryError) {
      renderFeishuSendError(retryError);
    } finally {
      setFeishuBusy(false);
    }
  });
}

async function preflightFeishu() {
  const payload = await api('/api/feishu/preflight-final', {
    method: 'POST',
    body: JSON.stringify(feishuPayload()),
  });
  renderFeishuPreflight(payload.preflight);
  return payload.preflight;
}

async function sendFeishuFinal() {
  const readiness = renderFeishuReadiness();
  if (!readiness.ready) {
    renderFeishuReadinessBlock(readiness);
    return;
  }
  try {
    setFeishuBusy(true, '预检中...');
    renderFeishuProgress('发送前预检', 'checking');
    const preflight = await preflightFeishu();
    if (preflight.status !== 'ready') return;
    setFeishuBusy(true, '发送中...');
    renderFeishuProgress('正在发送 PNG 成品', feishuTargetLabel(preflight.target));
    const payload = await api('/api/feishu/send-final', {
      method: 'POST',
      body: JSON.stringify(feishuPayload()),
    });
    renderFeishuSendReceipt(payload);
    await refreshFeishuSendHistory().catch(() => {});
    await refreshFeishuTargets().catch(() => {});
  } catch (error) {
    renderFeishuSendError(error);
    await refreshFeishuSendHistory().catch(() => {});
  } finally {
    setFeishuBusy(false);
  }
}

async function loadRecentTargetAndLatestFinal({ send = false } = {}) {
  try {
    setFeishuBusy(true, send ? '准备发送...' : '准备中...');
    let target = activeFeishuTarget();
    if (!target) {
      if (!state.feishuTargets.length) await refreshFeishuTargets();
      target = newestFeishuTarget();
      if (!target) throw new Error('没有可复用的飞书目标，请先保存一个真实 Chat ID 或 User ID。');
      fillFeishuTarget(target);
    }
    renderFeishuProgress('正在回填最近目标与成品', target.label || target.value || 'recent target');
    await refreshLatestFinalJob({ force: true, silent: true });
    const readiness = renderFeishuReadiness();
    if (!readiness.ready) {
      renderFeishuReadinessBlock(readiness);
      return;
    }
    if (send) {
      await sendFeishuFinal();
    } else {
      await preflightFeishu();
    }
  } catch (error) {
    renderFeishuSendError(error);
  } finally {
    setFeishuBusy(false);
  }
}

async function fetchJobStatus(sessionId) {
  return api(`/api/jobs/${encodeURIComponent(sessionId)}`);
}

async function pollJobStatus(sessionId, targetStatuses, label) {
  const token = ++state.jobPollToken;
  const targets = new Set(targetStatuses);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const payload = await fetchJobStatus(sessionId);
    if (token !== state.jobPollToken) return payload;
    renderJobStatus(payload, label);
    const status = payload.jobState?.result?.status || payload.jobState?.status || payload.session?.status;
    if (targets.has(status) || status === 'failed' || status === 'error') return payload;
    await wait(1500);
  }
  const payload = await fetchJobStatus(sessionId);
  if (token === state.jobPollToken) renderJobStatus(payload, `${label} · 等待中`);
  return payload;
}

async function createJob() {
  try {
    setMessage('jobResults', '正在创建 Photoshop 预览任务...');
    const payload = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        manifestPath: $('manifestPath').value,
        originalPsdPath: $('psdPath').value,
        templateId: state.inspection?.templateId,
        templateDisplayName: state.inspection?.displayName,
        uiActions: state.uiActions,
      }),
    });
    state.lastSessionId = payload.session.sessionId;
    $('confirmFinalBtn').disabled = false;
    renderJobStatus(payload, '已创建 Photoshop 预览任务');
    await refresh();
    await pollJobStatus(state.lastSessionId, ['preview_ready'], 'Photoshop 预览任务');
  } catch (error) {
    setMessage('jobResults', error.payload || error.message);
  }
}

$('refreshBtn').addEventListener('click', () => refresh().catch((error) => setMessage('designResults', error.message)));
$('preflightTopBtn').addEventListener('click', () => runPreflight());
$('preflightBtn').addEventListener('click', () => runPreflight());
$('loadManifestBtn').addEventListener('click', () => loadManifest().catch((error) => setMessage('designResults', error.message)));
$('slotSearch').addEventListener('input', () => renderSlots());
$('previewImage').addEventListener('load', () => updatePreviewImageFit());
$('previewImage').addEventListener('error', () => {
  $('previewImage').classList.remove('usable');
  $('previewStatus').textContent = previewStatusText('预览图读取失败，保留坐标 overlay');
});
$('zoomOutBtn').addEventListener('click', () => {
  state.previewZoom = clamp(state.previewZoom * 0.85, 0.08, 1.4);
  renderTemplatePreview();
});
$('zoomInBtn').addEventListener('click', () => {
  state.previewZoom = clamp(state.previewZoom * 1.18, 0.08, 1.4);
  renderTemplatePreview();
});
$('zoomFitBtn').addEventListener('click', () => fitTemplatePreview());
$('toggleSourceBtn').addEventListener('click', () => setSourceCollapsed(!state.sourceCollapsed));
$('clearQueueBtn').addEventListener('click', () => resetActionQueue());
$('savePresetBtn').addEventListener('click', () => saveCurrentPreset().catch((error) => {
  setMessage('presetResults', error.payload || error.message);
}));
$('checkPresetCompatibilityBtn').addEventListener('click', async () => {
  try {
    const preset = selectedPreset();
    const compatibilities = await refreshPresetCompatibility(preset?.id || '');
    const selected = selectedPreset();
    const compatibility = selected
      ? (compatibilities.find((item) => item.presetId === selected.id) || presetCompatibility(selected.id))
      : null;
    setMessage('presetResults', selected
      ? renderPresetCompatibility(selected, compatibility)
      : '<div class="empty">暂无可检查的 preset。</div>', 'html');
  } catch (error) {
    setMessage('presetResults', error.payload || error.message);
  }
});
$('applyPresetBtn').addEventListener('click', () => applySelectedPreset().catch((error) => {
  if (error.payload?.details) {
    setMessage('presetResults', error.payload.details);
  } else {
    setMessage('presetResults', error.payload || error.message);
  }
}));
$('deletePresetBtn').addEventListener('click', () => deleteSelectedPreset().catch((error) => {
  setMessage('presetResults', error.payload || error.message);
}));
$('presetSelect').addEventListener('change', () => {
  const preset = selectedPreset();
  if (!preset) {
    setMessage('presetResults', '');
    return;
  }
  setMessage('presetResults', renderPresetCompatibility(preset, presetCompatibility(preset.id)), 'html');
});
$('discoverManifestsBtn').addEventListener('click', () => discoverManifests().catch((error) => {
  setMessage('crossTemplateResults', error.payload || error.message);
}));
$('manifestCandidateSelect').addEventListener('change', () => {
  const selected = $('manifestCandidateSelect').value;
  if (selected) $('crossManifestPath').value = selected;
});
$('runCrossTemplateBtn').addEventListener('click', () => runCrossTemplateValidation().catch((error) => {
  setMessage('crossTemplateResults', error.payload || error.message);
}));
$('derivePresetBtn').addEventListener('click', () => deriveCrossTemplatePreset().catch((error) => {
  setMessage('derivePresetResults', error.payload || error.message);
}));
$('refreshDerivedTargetsBtn').addEventListener('click', () => refreshDerivedTargets().catch((error) => {
  setMessage('presetResults', error.payload || error.message);
}));
document.addEventListener('click', (event) => {
  const recordButton = event.target.closest('[data-derived-target-record-action]');
  if (recordButton) {
    const id = recordButton.dataset.id || '';
    const action = recordButton.dataset.derivedTargetRecordAction || '';
    const record = (state.derivedTargets || []).find((item) => item.id === id);
    if (!record) {
      setMessage('presetResults', '<div class="issue err"><b>derived_record_missing</b>本地派生目标记录不存在。</div>', 'html');
      return;
    }
    if (action === 'delete') {
      api(`/api/derived-targets/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then(() => refreshDerivedTargets())
        .then(() => setMessage('presetResults', `
          <div class="preflight-status blocked">
            <strong>派生目标记录已移除</strong>
            <span>${escapeHtml(record.targetManifest?.templateId || record.targetManifest?.manifestPath || id)}</span>
          </div>
        `, 'html'))
        .catch((error) => setMessage('presetResults', error.payload || error.message));
      return;
    }
    loadDerivedTargetRecord(record, { applyPreset: action === 'load-apply' }).catch((error) => {
      setMessage('presetResults', error.payload || error.message);
    });
    return;
  }
  const button = event.target.closest('[data-derived-target-action]');
  if (!button) return;
  const action = button.dataset.derivedTargetAction || '';
  loadDerivedTargetTemplate({ applyPreset: action === 'load-apply' }).catch((error) => {
    setMessage('derivePresetResults', error.payload || error.message);
  });
});
$('createJobBtn').addEventListener('click', () => createJob());

$('resolveBtn').addEventListener('click', async () => {
  try {
    setMessage('designResults', '解析中...');
    const payload = await api('/api/design006/resolve', {
      method: 'POST',
      body: JSON.stringify({ url: $('designUrl').value }),
    });
    setMessage('designResults', payload);
    await refresh();
  } catch (error) {
    setMessage('designResults', error.message);
  }
});

$('downloadBtn').addEventListener('click', async () => {
  try {
    setMessage('designResults', '下载处理中...');
    const payload = await api('/api/design006/download', {
      method: 'POST',
      body: JSON.stringify({ url: $('designUrl').value }),
    });
    if (payload.requiresLogin) {
      state.pendingId = payload.pendingId;
      $('continueLoginBtn').disabled = false;
      $('cancelLoginBtn').disabled = false;
    }
    setMessage('designResults', payload);
    await refresh();
  } catch (error) {
    setMessage('designResults', error.message);
  }
});

$('continueLoginBtn').addEventListener('click', async () => {
  try {
    setMessage('designResults', '继续挂起任务...');
    const payload = await api('/api/design006/login/continue', {
      method: 'POST',
      body: JSON.stringify({ pendingId: state.pendingId }),
    });
    state.pendingId = null;
    $('continueLoginBtn').disabled = true;
    $('cancelLoginBtn').disabled = true;
    setMessage('designResults', payload);
    await refresh();
  } catch (error) {
    setMessage('designResults', error.message);
  }
});

$('cancelLoginBtn').addEventListener('click', async () => {
  try {
    const payload = await api('/api/design006/login/cancel', { method: 'POST', body: '{}' });
    state.pendingId = null;
    $('continueLoginBtn').disabled = true;
    $('cancelLoginBtn').disabled = true;
    setMessage('designResults', payload);
    await refresh();
  } catch (error) {
    setMessage('designResults', error.message);
  }
});

$('confirmFinalBtn').addEventListener('click', async () => {
  try {
    if (!state.lastSessionId) throw new Error('当前页面还没有 sessionId，请先创建预览任务。');
    $('confirmFinalBtn').disabled = true;
    const payload = await api(`/api/jobs/${encodeURIComponent(state.lastSessionId)}/confirm-final`, {
      method: 'POST',
      body: '{}',
    });
    renderJobStatus(payload, '已创建高清导出任务');
    await refresh();
    await pollJobStatus(state.lastSessionId, ['final_exported'], 'Photoshop 高清导出');
  } catch (error) {
    setMessage('jobResults', error.message);
  }
});

$('feishuChatId').addEventListener('input', () => {
  if ($('feishuChatId').value.trim()) $('feishuUserId').value = '';
  renderFeishuReadiness();
});

$('feishuUserId').addEventListener('input', () => {
  if ($('feishuUserId').value.trim()) $('feishuChatId').value = '';
  renderFeishuReadiness();
});

$('finalImagePath').addEventListener('input', () => {
  renderFeishuReadiness();
});

$('saveFeishuTargetBtn').addEventListener('click', async () => {
  try {
    await saveCurrentFeishuTarget();
  } catch (error) {
    setMessage('feishuResults', error.payload || error.message);
  }
});

$('clearFeishuTargetBtn').addEventListener('click', () => {
  $('feishuChatId').value = '';
  $('feishuUserId').value = '';
  $('feishuTargetLabel').value = '';
  renderFeishuReadiness();
  setMessage('feishuResults', '已清空当前飞书目标。');
});

$('refreshFeishuTargetsBtn').addEventListener('click', async () => {
  try {
    await refreshFeishuTargets();
    setMessage('feishuResults', '已刷新本地最近飞书目标。');
  } catch (error) {
    setMessage('feishuResults', error.payload || error.message);
  }
});

$('feishuTargetList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-feishu-target-action]');
  if (!button) return;
  const target = state.feishuTargets.find((item) => item.id === button.dataset.id);
  if (!target && button.dataset.feishuTargetAction !== 'delete') return;
  try {
    if (button.dataset.feishuTargetAction === 'use') {
      fillFeishuTarget(target);
    } else if (button.dataset.feishuTargetAction === 'preflight') {
      fillFeishuTarget(target);
      await preflightFeishu();
    } else if (button.dataset.feishuTargetAction === 'delete') {
      await deleteFeishuTarget(button.dataset.id);
      setMessage('feishuResults', '已删除本地飞书目标。');
    }
  } catch (error) {
    setMessage('feishuResults', error.payload || error.message);
  }
});

$('refreshSendHistoryBtn').addEventListener('click', async () => {
  try {
    await refreshFeishuSendHistory();
    setMessage('feishuResults', '已刷新本地发送历史。');
  } catch (error) {
    setMessage('feishuResults', error.payload || error.message);
  }
});

$('feishuSendHistory').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-feishu-history-action]');
  if (!button) return;
  const record = state.feishuSendHistory.find((item) => item.id === button.dataset.id);
  if (!record) return;
  try {
    const includeImage = button.dataset.feishuHistoryAction === 'reuse-preflight';
    fillFeishuFromHistoryRecord(record, { includeImage });
    if (includeImage) await preflightFeishu();
  } catch (error) {
    setMessage('feishuResults', error.payload || error.message);
  }
});

$('preflightFeishuBtn').addEventListener('click', async () => {
  try {
    setMessage('feishuResults', '正在进行发送前预检...');
    await preflightFeishu();
  } catch (error) {
    setMessage('feishuResults', error.payload || error.message);
  }
});

$('backfillLatestFinalBtn').addEventListener('click', async () => {
  try {
    setMessage('feishuResults', '正在回填最近 Photoshop 最终成品...');
    await refreshLatestFinalJob({ force: true });
  } catch (error) {
    setMessage('feishuResults', error.payload || error.message);
  }
});

$('loadRecentAndSendBtn').addEventListener('click', async () => {
  await loadRecentTargetAndLatestFinal({ send: true });
});

$('sendFeishuBtn').addEventListener('click', async () => {
  await sendFeishuFinal();
});

applyInitialDefaults(await loadLocalDefaults());
setSourceCollapsed(true);
renderSlots();
renderSlotDetail();
renderTemplatePreview();
renderQueue();
renderPreflight();
renderPresetList();
renderDerivedTargets();
renderFeishuTargets();
renderFeishuReadiness();
renderFeishuSendHistory();
renderManifestCandidateList();
$('derivePresetBtn').disabled = true;
await refresh().catch((error) => setMessage('designResults', error.message));
if ($('manifestPath').value.trim()) {
  await loadManifest().catch((error) => setMessage('designResults', error.message));
} else {
  setMessage('designResults', '请填写真实 Manifest 路径，或复制 public/local-defaults.example.json 为 public/local-defaults.json 后配置本机路径。');
}
