import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

/* =====================================================================
 * 常數與全域狀態
 * ===================================================================== */
const DATA_URL = "./data/GDMScatalog.csv";
const GEOJSON_URL = "./data/twCounty2010.geo.json";

// 詳細資料面板的欄位說明：[key, 欄位名稱, 說明]
const FIELD_INFO = [
  ["date", "Date", "發生日期（年、月、日）"],
  ["time", "Time", "發生時間（時、分、秒）"],
  ["lat", "Lat.", "北緯度（度）"],
  ["lon", "Lon.", "東經度（度）"],
  ["depth", "Depth", "震源深度（公里）"],
  ["ML", "ML", "芮氏規模"],
  ["nstn", "nstn", "定位時使用的測站數量"],
  ["dmin", "Dmin", "最近測站至震央的距離"],
  ["gap", "Gap", "相鄰測站的最大間隙角度"],
  ["trms", "RMS / trms", "時間殘值的方均根誤差值"],
  ["ERH", "ERH", "震央水平標準差（公里）"],
  ["ERZ", "ERZ", "震源深度垂直標準差（公里）"],
  ["fixed", "Fixed", "深度控制：F 未限制、X 限制深度"],
  ["nph", "nph", "到時相位數量"],
  ["quality", "Quality", "地震定位品質"]
];

// 三個維度的完整範圍（縮放/平移的邊界）與目前可視範圍（三張圖共用 → 連動）
const DEFAULT_DOMAINS = { lon: [118, 126], lat: [20, 26], depth: [0, 400] };
const activeDomains = {
  lon: [...DEFAULT_DOMAINS.lon],
  lat: [...DEFAULT_DOMAINS.lat],
  depth: [...DEFAULT_DOMAINS.depth]
};

const state = {
  allData: [],
  filteredData: [],
  selectedIds: new Set(),
  selectedEvent: null,   // 已點選 / Enter 選取的地震（詳細資料面板顯示）
  focusEvent: null,      // 鍵盤逐點瀏覽目前停在的地震（三張圖同步畫焦點環）
  filters: { minML: 4, maxML: 8, minDepth: 0, maxDepth: 400 }
};

// 圖表內部座標系：固定 600x600，由 viewBox / 百分比定位自動縮放到實際尺寸
const SIZE = 600;
const M = { top: 20, right: 25, bottom: 50, left: 60 };
const INNER_W = SIZE - M.left - M.right;
const INNER_H = SIZE - M.top - M.bottom;
const TAU = Math.PI * 2;

// ML 以 0.1 為單位分成 101 個 bin；顏色與半徑只和 ML 有關，所以預先算好
// → 繪圖時同一 bin 的點可合併成一條 path，只 fill/stroke 一次（效能關鍵）
let colorScale = d3.scaleSequential(d3.interpolateViridis).domain([state.filters.minML, state.filters.maxML]).clamp(true);
let BIN_COLORS = [];
let BIN_RADIUS = [];

// bin（0–100）→ 圓點半徑。圖表與圖例共用這個函式，兩者才會一致
const binRadius = (bin) => 2 + Math.sqrt(bin / 5);
// ML → bin：以「目前篩選的 ML 範圍」做相對縮放（min==max 時避免除以 0）
function binOf(ml) {
  const { minML, maxML } = state.filters;
  const t = maxML > minML ? (ml - minML) / (maxML - minML) : 0;
  return Math.round(Math.min(1, Math.max(0, t)) * 100);
}

const $ = (selector) => document.querySelector(selector);
const tooltip = $("#tooltip");
const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

// 螢幕閱讀器專用的即時播報區（視覺上隱藏，但會被唸出來）
const srStatus = document.createElement("div");
srStatus.setAttribute("role", "status");
srStatus.setAttribute("aria-live", "polite");
Object.assign(srStatus.style, {
  position: "absolute", width: "1px", height: "1px", overflow: "hidden",
  clip: "rect(0 0 0 0)", whiteSpace: "nowrap"
});
document.body.append(srStatus);
const announce = (message) => { srStatus.textContent = message; };

/* =====================================================================
 * 資料解析
 * ===================================================================== */
const normalizedKey = (key) => String(key ?? "").trim().toLowerCase().replace(/[\s._-]/g, "");

// 以「忽略大小寫與符號」的方式找欄位
function getField(row, aliases) {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const target = normalizedKey(alias);
    const key = keys.find((k) => normalizedKey(k) === target);
    if (key !== undefined) return row[key];
  }
  return "";
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function isInDateWindow(dateText) {
  const digits = String(dateText).replace(/\D/g, "");
  if (digits.length < 8) return true;
  const ymd = Number(digits.slice(0, 8));
  return ymd >= 20250101 && ymd <= 20251231;
}

function parseRows(rows) {
  const parsed = rows.map((row, index) => ({
    id: index,
    date: String(getField(row, ["date"])).trim(),
    time: String(getField(row, ["time"])).trim(),
    lat: numberOrNull(getField(row, ["lat", "latitude"])),
    lon: numberOrNull(getField(row, ["lon", "long", "longitude"])),
    depth: numberOrNull(getField(row, ["depth"])),
    ML: numberOrNull(getField(row, ["ML", "magnitude"])),
    nstn: numberOrNull(getField(row, ["nstn"])),
    dmin: numberOrNull(getField(row, ["dmin"])),
    gap: numberOrNull(getField(row, ["gap"])),
    trms: numberOrNull(getField(row, ["trms", "rms"])),
    ERH: numberOrNull(getField(row, ["ERH"])),
    ERZ: numberOrNull(getField(row, ["ERZ"])),
    fixed: String(getField(row, ["fixed"])).trim(),
    nph: numberOrNull(getField(row, ["nph"])),
    quality: String(getField(row, ["quality"])).trim()
  }));

  const valid = parsed.filter((d) =>
    d.lat !== null && d.lon !== null && d.depth !== null && d.ML !== null &&
    d.lat >= 20 && d.lat <= 26 && d.lon >= 118 && d.lon <= 126 &&
    d.depth >= 0 && d.depth <= 400 && d.ML >= 0 && d.ML <= 10 &&
    isInDateWindow(d.date)
  );
  return valid;
}

/* =====================================================================
 * 格式化 / 摘要 / 詳細資料 / Tooltip
 * ===================================================================== */
const fmt = (v, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(digits);

const escapeHTML = (value) =>
  String(value ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function updateSummary() {
  const data = state.filteredData;
  $("#total-count").textContent = data.length.toLocaleString();
  $("#avg-ml").textContent = fmt(data.length ? d3.mean(data, (d) => d.ML) : null, 2);
  $("#avg-depth").textContent = fmt(data.length ? d3.mean(data, (d) => d.depth) : null, 1);
  $("#max-ml").textContent = fmt(data.length ? d3.max(data, (d) => d.ML) : null, 1);
}

function renderDetails() {
  const d = state.selectedEvent;
  const placeholder = $("#detail-placeholder");
  const content = $("#detail-content");
  if (!d) {
    placeholder.hidden = false;
    content.hidden = true;
    content.innerHTML = "";
    return;
  }
  placeholder.hidden = true;
  content.hidden = false;
  const values = {
    date: d.date, time: d.time, lat: `${fmt(d.lat, 4)}°N`, lon: `${fmt(d.lon, 4)}°E`,
    depth: `${fmt(d.depth, 1)} km`, ML: fmt(d.ML, 1), nstn: d.nstn, dmin: d.dmin, gap: d.gap,
    trms: d.trms, ERH: d.ERH, ERZ: d.ERZ, fixed: d.fixed, nph: d.nph, quality: d.quality
  };
  content.innerHTML = `<table class="detail-table"><tbody>${FIELD_INFO.map(([key, label, meaning]) =>
    `<tr><th>${escapeHTML(label)}<br><span class="muted">${escapeHTML(key)}</span></th>
       <td>${escapeHTML(meaning)}</td><td>${escapeHTML(values[key] ?? "—")}</td></tr>`
  ).join("")}</tbody></table>`;
}

function moveTooltip(event) {
  const pad = 14;
  tooltip.style.left = `${Math.min(event.clientX + pad, window.innerWidth - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${Math.min(event.clientY + pad, window.innerHeight - tooltip.offsetHeight - 8)}px`;
}
function showTooltip(event, d) {
  tooltip.hidden = false;
  tooltip.innerHTML = `<b>${escapeHTML(d.date)} ${escapeHTML(d.time)}</b><br>
    ML ${fmt(d.ML, 1)} · 深度 ${fmt(d.depth, 1)} km<br>
    ${fmt(d.lat, 3)}°N, ${fmt(d.lon, 3)}°E<br><span>點擊或按 Enter 查看完整資料</span>`;
  moveTooltip(event);
}
const hideTooltip = () => { tooltip.hidden = true; };

/* =====================================================================
 * 篩選、選取與重繪排程
 * ===================================================================== */
// 目前可視範圍內的資料（三張圖共用，每個 frame 只算一次）
function getVisibleData() {
  const { lon, lat, depth } = activeDomains;
  return state.filteredData.filter((d) =>
    d.lon >= lon[0] && d.lon <= lon[1] &&
    d.lat >= lat[0] && d.lat <= lat[1] &&
    d.depth >= depth[0] && d.depth <= depth[1]
  );
}

let rafId = 0;
const charts = []; // 所有圖表實例

// 座標範圍的文字描述（給 aria-label / 播報用）
const DIM_UNIT = { lon: "°E", lat: "°N", depth: " km" };
const fmtRange = (key) => {
  const digits = key === "depth" ? 0 : 2;
  return `${fmt(activeDomains[key][0], digits)}–${fmt(activeDomains[key][1], digits)}${DIM_UNIT[key]}`;
};
const viewSummary = (n) =>
  `目前顯示 ${n.toLocaleString()} 筆地震；經度 ${fmtRange("lon")}，緯度 ${fmtRange("lat")}，深度 ${fmtRange("depth")}`;

let visibleData = [];     // 目前可視範圍內的資料（三張圖與鍵盤逐點瀏覽共用）
let navSorted = null;     // 逐點瀏覽用的排序快取（ML 大 → 小），資料變動時清掉
let announceView = false; // 這一輪重繪後是否要播報目前視圖

// 以 requestAnimationFrame 合併多次重繪請求（滾輪/拖曳時不會一個 frame 畫多次）
function updateCharts({ announce: say = false } = {}) {
  announceView ||= say;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    visibleData = getVisibleData();
    navSorted = null;
    charts.forEach((c) => c.render(visibleData));
    if (announceView) { announceView = false; announce(viewSummary(visibleData.length)); }
  });
}
const clearAllBrushes = () => charts.forEach((c) => c.clearBrush());

function applyFilters() {
  const f = state.filters;

  colorScale = d3.scaleSequential(d3.interpolateViridis).domain([f.minML, f.maxML]).clamp(true);
  BIN_COLORS = Array.from({ length: 101 }, (_, i) => colorScale(f.minML + (i / 100) * (f.maxML - f.minML)));
  BIN_RADIUS = Array.from({ length: 101 }, (_, i) => binRadius(i));
  drawMLLegend(".ml-legend");

  state.filteredData = state.allData.filter((d) =>
    d.ML >= f.minML && d.ML <= f.maxML && d.depth >= f.minDepth && d.depth <= f.maxDepth
  );
  state.filteredData.forEach((d) => { d.bin = binOf(d.ML); });

  const validIds = new Set(state.filteredData.map((d) => d.id));
  state.selectedIds = new Set([...state.selectedIds].filter((id) => validIds.has(id)));
  if (state.focusEvent && !validIds.has(state.focusEvent.id)) clearFocusEvent();
  if (state.selectedEvent && !validIds.has(state.selectedEvent.id)) {
    state.selectedEvent = null;
    renderDetails();
  }
  updateSummary();
  updateCharts();
  $("#filter-status").textContent =
    `目前顯示 ${state.filteredData.length.toLocaleString()} / ${state.allData.length.toLocaleString()} 筆符合資料範圍的地震。`;
  $("#ml-range-label").textContent = `${f.minML} — ${f.maxML}`;
  $("#depth-range-label").textContent = `${f.minDepth} — ${f.maxDepth} km`;
}

function setSelected(ids) {
  state.selectedIds = new Set(ids);
  updateCharts();
}
function selectEvent(d) {
  state.selectedEvent = d;
  renderDetails();
  updateCharts();
}

/* =====================================================================
 * 鍵盤逐點瀏覽：不用滑鼠也能取得 tooltip 與詳細資料
 * ===================================================================== */
const describeEvent = (d) =>
  `${d.date} ${d.time}，芮氏規模 ${fmt(d.ML, 1)}，深度 ${fmt(d.depth, 1)} 公里，北緯 ${fmt(d.lat, 3)} 度，東經 ${fmt(d.lon, 3)} 度`;

// 可視範圍內的地震，依 ML 由大到小排序（規模大的先看到）
const getNavList = () => (navSorted ??= [...visibleData].sort((a, b) => b.ML - a.ML || a.id - b.id));

function clearFocusEvent() {
  if (!state.focusEvent) return;
  state.focusEvent = null;
  hideTooltip();
  updateCharts();
}

// mode: "step"（相對移動 amount 筆）、"first"、"last"
function moveFocus(chart, mode, amount = 1) {
  const list = getNavList();
  if (!list.length) { announce("目前可視範圍內沒有地震資料，請放寬篩選或重置縮放"); return; }
  const cur = state.focusEvent ? list.indexOf(state.focusEvent) : -1;
  let next;
  if (mode === "first") next = 0;
  else if (mode === "last") next = list.length - 1;
  else if (cur < 0) next = amount > 0 ? 0 : list.length - 1;
  else next = Math.min(list.length - 1, Math.max(0, cur + amount));

  const d = list[next];
  state.focusEvent = d;
  updateCharts();
  showTooltip(chart.clientPos(d), d); // 鍵盤焦點也會顯示 tooltip
  announce(`第 ${next + 1} 筆，共 ${list.length} 筆。${describeEvent(d)}`);
}

/* =====================================================================
 * 範圍（domain）工具：縮放 / 平移共用
 * ===================================================================== */
// 保持長度不變，把區間夾回 full 範圍內
function clampDomain([a, b], full) {
  const len = Math.min(b - a, full[1] - full[0]);
  a = Math.max(full[0], Math.min(full[1] - len, a));
  return [a, a + len];
}
// 以 anchor 為不動點縮放；k > 1 放大、k < 1 縮小
function zoomDomain(dom, full, anchor, k) {
  const fullLen = full[1] - full[0];
  const len = Math.max(fullLen * 0.005, Math.min(fullLen, (dom[1] - dom[0]) / k));
  const r = len / (dom[1] - dom[0]);
  return clampDomain([anchor - (anchor - dom[0]) * r, anchor + (dom[1] - anchor) * r], full);
}

/* =====================================================================
 * 圖表工廠：地圖與兩張剖面圖共用同一套邏輯
 *   層級（由下到上）：canvas（格線 → 底圖 → 資料點） → svg（座標軸、brush、互動）
 *   cfg: { container, svg, canvas, xDim, yDim, title, xLabel, yLabel, base? }
 * ===================================================================== */
function createChart(cfg) {
  const { xDim, yDim } = cfg;
  const box = $(cfg.container);
  const canvas = $(cfg.canvas);
  const ctx = canvas.getContext("2d");
  const svg = d3.select(cfg.svg);
  canvas.setAttribute("aria-hidden", "true"); // canvas 只是視覺，替代文字放在 svg 的 aria-label

  // 深度軸向下增加 → y 範圍反向
  const yInverted = yDim === "depth";
  const x = d3.scaleLinear().range([0, INNER_W]);
  const y = d3.scaleLinear().range(yInverted ? [0, INNER_H] : [INNER_H, 0]);

  // --- SVG：座標軸 + 標籤 + brush（不再放地圖，避免遮擋資料點） ---
  svg.attr("viewBox", `0 0 ${SIZE} ${SIZE}`).selectAll("*").remove();
  const root = svg.append("g").attr("transform", `translate(${M.left},${M.top})`);
  const xAxisG = root.append("g").attr("transform", `translate(0,${INNER_H})`);
  const yAxisG = root.append("g");
  const brushG = root.append("g").attr("class", "brush");
  root.append("text").attr("class", "axis-label").attr("x", INNER_W / 2).attr("y", INNER_H + 38)
    .attr("text-anchor", "middle").text(cfg.xLabel);
  root.append("text").attr("class", "axis-label").attr("transform", "rotate(-90)")
    .attr("x", -INNER_H / 2).attr("y", -45).attr("text-anchor", "middle").text(cfg.yLabel);

  // --- Canvas：以百分比貼齊 SVG 的繪圖區（修正位置/大小與 svg 不一致） ---
  const pct = (v) => `${(v / SIZE) * 100}%`;
  Object.assign(canvas.style, { left: pct(M.left), top: pct(M.top), width: pct(INNER_W), height: pct(INNER_H) });

  // 依實際顯示尺寸 × devicePixelRatio 設定解析度，座標仍使用 600x600 的邏輯單位
  function resizeCanvas() {
    const cssScale = box.clientWidth / SIZE;
    if (!cssScale) return false;
    const s = cssScale * (window.devicePixelRatio || 1);
    canvas.width = Math.round(INNER_W * s);
    canvas.height = Math.round(INNER_H * s);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    return true;
  }

  let lastVisible = [];
  let quadtree = null; // lazy initialization

  /* ---- 繪製 ---- */
  function drawGrid() {
    ctx.save();
    ctx.strokeStyle = "#000000";
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    for (const t of x.ticks(6)) { const px = x(t); ctx.moveTo(px, 0); ctx.lineTo(px, INNER_H); }
    for (const t of y.ticks(6)) { const py = y(t); ctx.moveTo(0, py); ctx.lineTo(INNER_W, py); }
    ctx.stroke();
    ctx.restore();
  }

  function drawPoints(data) {
    const selected = new Set(state.selectedIds);
    if (state.selectedEvent) selected.add(state.selectedEvent.id);

    // 依 ML bin 分組（ML 小的先畫、大的蓋在上面）
    const buckets = [];
    const highlighted = [];
    for (const d of data) {
      if (selected.has(d.id)) highlighted.push(d);
      else (buckets[d.bin] ??= []).push(d);
    }

    // canvas 的 lineWidth 設為 0 會被忽略（沿用上一次的值，造成外框粗細不一），要用明確的小數值。
    // 細深色外框讓淺色（黃）的點在白色底圖上仍有足夠對比（WCAG 1.4.11 非文字對比 ≥ 3:1）。
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
    buckets.forEach((arr, bin) => { // forEach 會略過空的 bin
      const r = BIN_RADIUS[bin];
      ctx.beginPath();
      for (const d of arr) {
        const px = x(d[xDim]), py = y(d[yDim]);
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, TAU);
      }
      ctx.fillStyle = BIN_COLORS[bin];
      ctx.fill();
      ctx.stroke();
    });

    // 選取的點最後畫、加粗外框，確保在最上層
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "#ff0000";
    for (const d of highlighted) {
      ctx.beginPath();
      ctx.arc(x(d[xDim]), y(d[yDim]), BIN_RADIUS[d.bin] + 1.8, 0, TAU);
      ctx.fillStyle = BIN_COLORS[d.bin];
      ctx.fill();
      ctx.stroke();
    }
  }

  // 鍵盤焦點環：黑色粗環 + 白色細環，在任何底色上都看得見（不只靠顏色）
  function drawFocusRing() {
    const d = state.focusEvent;
    if (!d) return;
    const px = x(d[xDim]), py = y(d[yDim]);
    if (px < 0 || px > INNER_W || py < 0 || py > INNER_H) return;
    ctx.beginPath();
    ctx.arc(px, py, BIN_RADIUS[d.bin] + 4, 0, TAU);
    ctx.lineWidth = 3.5; ctx.strokeStyle = "#000000"; ctx.stroke();
    ctx.lineWidth = 1.2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
  }

  function render(visible) {
    lastVisible = visible;
    quadtree = null;
    x.domain(activeDomains[xDim]);
    y.domain(activeDomains[yDim]);

    // 替代文字隨篩選 / 縮放動態更新，讓螢幕閱讀器讀到「目前」的圖
    svg.attr("aria-label",
      `${cfg.title}：目前顯示 ${visible.length.toLocaleString()} 筆地震。` +
      `橫軸 ${cfg.xLabel}，範圍 ${fmtRange(xDim)}；縱軸 ${cfg.yLabel}，範圍 ${fmtRange(yDim)}。` +
      `圓點的顏色與大小都代表芮氏規模。`);

    xAxisG.call(d3.axisBottom(x).ticks(6));
    yAxisG.call(d3.axisLeft(y).ticks(6));

    ctx.clearRect(0, 0, INNER_W, INNER_H);
    drawGrid();
    cfg.base?.(ctx, x, y); // 底圖（地圖輪廓）→ 一定先畫，資料點才不會被蓋住
    drawPoints(visible);
    drawFocusRing();
  }

  /* ---- 互動：tooltip / 點選 ---- */
  const getQuadtree = () =>
  (quadtree ??= d3.quadtree().x((d) => x(d[xDim])).y((d) => y(d[yDim])).addAll(lastVisible));

  let pan = null;          // 平移狀態
  let suppressClick = false; // 平移結束後不要觸發點選

  // 重點：事件名稱加上命名空間（.tip / .pan / .pick / .zoom）。
  // 原本 tooltip 與平移都用 "mousemove"，後註冊的會把先註冊的覆蓋掉，tooltip 因此失效。
  svg.on("mousemove.tip", (event) => {
    if (pan) return; // 平移中不顯示 tooltip
    const [mx, my] = d3.pointer(event, root.node());
    if (mx < 0 || my < 0 || mx > INNER_W || my > INNER_H) return hideTooltip();
    const hit = getQuadtree().find(mx, my, 12);
    hit ? showTooltip(event, hit) : hideTooltip();
  });
  svg.on("mouseleave.tip", hideTooltip);
  svg.on("click.pick", (event) => {
    if (suppressClick) { suppressClick = false; return; }
    const [mx, my] = d3.pointer(event, root.node());
    const hit = getQuadtree().find(mx, my, 12);
    if (hit) selectEvent(hit);
  });

  /* ---- 互動：Brush 框選 ---- */
  const brush = d3.brush()
    .extent([[0, 0], [INNER_W, INNER_H]])
    .filter((event) => !event.shiftKey && event.button === 0) // Shift 保留給平移
    .on("start", clearAllBrushes)
    .on("end", (event) => {
      if (!event.selection) { if (event.sourceEvent) setSelected([]); return; }
      const [[x0, y0], [x1, y1]] = event.selection;
      setSelected(lastVisible.filter((d) => {
        const px = x(d[xDim]), py = y(d[yDim]);
        return px >= x0 && px <= x1 && py >= y0 && py <= y1;
      }).map((d) => d.id));
    });
  brushG.call(brush);

  /* ---- 互動：Shift + 拖曳平移 ---- */
  svg.on("mousedown.pan", (event) => {
    if (event.button !== 0 || !event.shiftKey) return;
    pan = {
      p0: d3.pointer(event, root.node()),
      xd: [...activeDomains[xDim]],
      yd: [...activeDomains[yDim]],
      moved: false
    };
    hideTooltip();
    clearAllBrushes();
  });
  svg.on("mousemove.pan", (event) => {
    if (!pan) return;
    const [px, py] = d3.pointer(event, root.node());
    // 內容跟著滑鼠走 → domain 往反方向位移；y 軸方向視是否反向而定
    const dx = ((px - pan.p0[0]) / INNER_W) * (pan.xd[1] - pan.xd[0]);
    const dy = ((py - pan.p0[1]) / INNER_H) * (pan.yd[1] - pan.yd[0]) * (yInverted ? -1 : 1);
    pan.moved = true;
    activeDomains[xDim] = clampDomain([pan.xd[0] - dx, pan.xd[1] - dx], DEFAULT_DOMAINS[xDim]);
    activeDomains[yDim] = clampDomain([pan.yd[0] + dy, pan.yd[1] + dy], DEFAULT_DOMAINS[yDim]);
    updateCharts();
  });
  const stopPan = () => { if (pan?.moved) suppressClick = true; pan = null; };
  svg.on("mouseup.pan", stopPan).on("mouseleave.pan", stopPan);

  /* ---- 互動：滾輪縮放（Ctrl 僅 X、Shift 僅 Y、無按鍵雙軸） ---- */
  svg.on("wheel.zoom", (event) => {
    event.preventDefault();
    const [mx, my] = d3.pointer(event, root.node());
    const k = (event.deltaY || event.deltaX) < 0 ? 1.15 : 1 / 1.15;
    const zoomX = event.ctrlKey || !event.shiftKey;
    const zoomY = event.shiftKey || !event.ctrlKey;
    x.domain(activeDomains[xDim]);
    y.domain(activeDomains[yDim]);
    if (zoomX) activeDomains[xDim] = zoomDomain(activeDomains[xDim], DEFAULT_DOMAINS[xDim], x.invert(mx), k);
    if (zoomY) activeDomains[yDim] = zoomDomain(activeDomains[yDim], DEFAULT_DOMAINS[yDim], y.invert(my), k);
    clearAllBrushes();
    updateCharts();
  }, { passive: false });

  /* ---- 尺寸變動時重設 canvas 解析度並重畫 ---- */
  new ResizeObserver(() => { if (resizeCanvas()) render(lastVisible); }).observe(box);
  resizeCanvas();

  // 焦點離開圖表就清掉逐點瀏覽的焦點環與 tooltip
  box.addEventListener("focusout", (e) => { if (!box.contains(e.relatedTarget)) clearFocusEvent(); });

  return {
    cfg,
    render,
    clearBrush: () => brushG.call(brush.move, null),
    // 資料點在螢幕上的位置（讓鍵盤焦點的 tooltip 能貼在點旁邊）
    clientPos(d) {
      const r = svg.node().getBoundingClientRect();
      const k = r.width / SIZE;
      return { clientX: r.left + (M.left + x(d[xDim])) * k, clientY: r.top + (M.top + y(d[yDim])) * k };
    }
  };
}

/* =====================================================================
 * 地圖底圖（畫在 canvas 上，位於資料點之下）
 * ===================================================================== */
function fallbackTaiwanGeoJSON() {
  const ring = [
    [121.55, 25.30], [121.95, 25.05], [121.85, 24.70], [121.95, 24.35], [121.75, 24.05],
    [121.80, 23.75], [121.55, 23.45], [121.45, 23.15], [121.25, 22.85], [120.95, 22.55],
    [120.85, 22.25], [120.65, 22.05], [120.35, 21.95], [120.10, 22.10], [120.05, 22.45],
    [120.15, 22.75], [120.15, 23.05], [120.25, 23.35], [120.35, 23.65], [120.45, 23.95],
    [120.55, 24.25], [120.65, 24.55], [120.75, 24.85], [120.95, 25.05], [121.25, 25.20],
    [121.55, 25.30]
  ];
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { name: "Taiwan (simplified)" }, geometry: { type: "Polygon", coordinates: [ring] } }]
  };
}
async function loadGeoJSON() {
  try { return await d3.json(GEOJSON_URL); } catch { return fallbackTaiwanGeoJSON(); }
}

function makeLandPainter(geojson) {
  return (ctx, x, y) => {
    // geoTransform：把經緯度直接用目前的 x/y scale 轉成畫布座標（不做投影）
    const path = d3.geoPath(d3.geoTransform({ point(lon, lat) { this.stream.point(x(lon), y(lat)); } }), ctx);
    ctx.beginPath();
    for (const f of geojson.features ?? []) path(f);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "#000000";
    ctx.stroke();
  };
}

/* =====================================================================
 * 圖例
 * ===================================================================== */
function drawMLLegend(selector) {
  const width = 320, height = 112;
  const svg = d3.select(selector).attr("width", width).attr("height", height)
    .attr("role", "img").attr("aria-hidden", null);
  svg.selectAll("*").remove();

  const [lo, hi] = colorScale.domain();
  svg.attr("aria-label",
    `圖例：圓點的顏色與大小都代表芮氏規模 ML，範圍 ${lo} 到 ${hi}。顏色由深紫到亮黃、圓點由小到大，表示規模由小到大。`);

  const x = d3.scaleLinear().domain([lo, hi]).range([14, width - 24]);
  const ticks = d3.ticks(lo, hi, 5);
  const label = (t) => String(+t.toFixed(1));

  // 1) 顏色：漸層色條 + 刻度
  const gradient = svg.append("defs").append("linearGradient").attr("id", "ml-gradient");
  gradient.selectAll("stop").data(d3.range(0, 1.001, 0.05)).join("stop")
    .attr("offset", (t) => `${t * 100}%`)
    .attr("stop-color", (t) => colorScale(lo + t * (hi - lo)));
  svg.append("text").attr("class", "axis-label").attr("x", 10).attr("y", 12).text("顏色 Color：芮氏規模 ML");
  svg.append("rect").attr("x", x(lo)).attr("y", 18).attr("width", Math.max(1, x(hi) - x(lo))).attr("height", 12)
    .attr("rx", 3).attr("fill", "url(#ml-gradient)");
  svg.append("g").attr("class", "axis").attr("transform", "translate(0,30)")
    .call(d3.axisBottom(x).tickValues(ticks).tickFormat(label).tickSize(4));

  // 2) 大小：同樣的 ML 刻度各畫一顆圓。半徑與圖表使用同一個 binRadius，
  //    再乘上圖表目前的縮放比例（圖表以 600 為邏輯尺寸縮放到實際寬度），所以大小與圖上一致
  const chartBox = $("#map-container");
  const k = (chartBox?.clientWidth || SIZE) / SIZE;
  svg.append("text").attr("class", "axis-label").attr("x", 10).attr("y", 66).text("大小 Size：同樣代表 ML");
  svg.append("g").selectAll("circle").data(ticks).join("circle")
    .attr("cx", x).attr("cy", 86)
    .attr("r", (t) => binRadius(binOf(t)) * k)
    .attr("fill", colorScale).attr("stroke", "rgba(0,0,0,0.5)").attr("stroke-width", 0.6);
  svg.append("g").attr("class", "axis").selectAll("text").data(ticks).join("text")
    .attr("x", x).attr("y", 106).attr("text-anchor", "middle").text(label);
}

/* =====================================================================
 * 鍵盤操作：Ctrl 切換縮放模式、+/- 縮放、方向鍵平移、Alt 加速
 * ===================================================================== */
let keyboardZoomMode = 0;
const modeNames = ["雙軸同步縮放", "僅橫軸縮放", "僅縱軸縮放"];

function updateKeyboardHints() {
  const text = `目前縮放模式：${modeNames[keyboardZoomMode]} (M 切換，+ / - 縮放，方向鍵平移，[ ] 逐點瀏覽，Enter 選取）`;
  ["#hint-map", "#hint-lat", "#hint-lon"].forEach((s) => { $(s).textContent = text; });
}

function setupKeyboardNavigation() {
  window.addEventListener("keydown", (event) => {
    const chart = charts.find((c) => $(c.cfg.container).contains(document.activeElement));
    if (!chart) return;
    const { xDim, yDim } = chart.cfg;

    // 切換縮放模式：M
    const isModeKey = (event.key === "m" || event.key === "M") && !event.ctrlKey && !event.metaKey;
    if (isModeKey) {
      event.preventDefault();
      if (event.repeat) return;
      keyboardZoomMode = (keyboardZoomMode + 1) % 3;
      updateKeyboardHints();
      announce(`縮放模式：${modeNames[keyboardZoomMode]}`);
      return;
    }

    // 逐點瀏覽：] / [ 前後一筆、PageDown / PageUp 前後十筆、Home / End 最大 / 最小規模
    const navKeys = {
      BracketRight: ["step", 1], BracketLeft: ["step", -1],
      PageDown: ["step", 10], PageUp: ["step", -10], Home: ["first"], End: ["last"]
    };
    const nav = navKeys[event.code];
    if (nav && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      moveFocus(chart, nav[0], nav[1]);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && state.focusEvent) {
      event.preventDefault();
      selectEvent(state.focusEvent);
      announce(`已選取：${describeEvent(state.focusEvent)}。完整資料顯示在「地震詳細資料」面板。`);
      return;
    }
    if (event.key === "Escape" && state.focusEvent) {
      clearFocusEvent();
      announce("已離開逐點瀏覽");
      return;
    }

    const boost = event.altKey ? 5 : 1;
    const xd = activeDomains[xDim], yd = activeDomains[yDim];
    const xLen = xd[1] - xd[0], yLen = yd[1] - yd[0];
    const yDir = yDim === "depth" ? -1 : 1; // 深度軸向下增加，「上」= 數值變小

    if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") {
      event.preventDefault();
      const k = (event.key === "+" || event.key === "=") ? 1.15 ** boost : 1 / 1.15 ** boost;
      if (keyboardZoomMode !== 2) activeDomains[xDim] = zoomDomain(xd, DEFAULT_DOMAINS[xDim], (xd[0] + xd[1]) / 2, k);
      if (keyboardZoomMode !== 1) activeDomains[yDim] = zoomDomain(yd, DEFAULT_DOMAINS[yDim], (yd[0] + yd[1]) / 2, k);
    } else {
      const step = 0.05 * boost;
      const move = {
        ArrowLeft: [-xLen * step, 0], ArrowRight: [xLen * step, 0],
        ArrowUp: [0, yLen * step * yDir], ArrowDown: [0, -yLen * step * yDir]
      }[event.key];
      if (!move) return;
      event.preventDefault();
      activeDomains[xDim] = clampDomain([xd[0] + move[0], xd[1] + move[0]], DEFAULT_DOMAINS[xDim]);
      activeDomains[yDim] = clampDomain([yd[0] + move[1], yd[1] + move[1]], DEFAULT_DOMAINS[yDim]);
    }
    clearAllBrushes();
    updateCharts({ announce: true }); // 縮放 / 平移後播報目前視圖範圍
  });
}

/* =====================================================================
 * 篩選面板 / 按鈕
 * ===================================================================== */

function setupFilters() {
  [["ml-min", "minML", 0, 10], ["ml-max", "maxML", 0, 10],
  ["depth-min", "minDepth", 0, 400], ["depth-max", "maxDepth", 0, 400]
  ].forEach(([id, key, min, max]) => {
    $("#" + id).addEventListener("change", (event) => {
      let value = Number(event.target.value);
      if (!Number.isFinite(value)) value = min;
      const f = state.filters;
      f[key] = Math.max(min, Math.min(max, value));
      if (f.minML > f.maxML) [f.minML, f.maxML] = [f.maxML, f.minML];
      if (f.minDepth > f.maxDepth) [f.minDepth, f.maxDepth] = [f.maxDepth, f.minDepth];
      syncFilterInputs();
      applyFilters();
    });
  });

  $("#reset-charts").addEventListener("click", () => {
    for (const k of Object.keys(DEFAULT_DOMAINS)) activeDomains[k] = [...DEFAULT_DOMAINS[k]];
    state.selectedIds.clear();
    state.selectedEvent = null;
    renderDetails();
    clearAllBrushes();
    applyFilters();
  });

  $("#reset-filters").addEventListener("click", () => {
    state.filters = { minML: 4, maxML: 8, minDepth: 0, maxDepth: 400 };
    syncFilterInputs();
    state.selectedIds.clear();
    state.selectedEvent = null;
    renderDetails();
    clearAllBrushes();
    applyFilters();
  });

  $("#clear-selection").addEventListener("click", () => {
    state.selectedIds.clear();
    state.selectedEvent = null;
    renderDetails();
    clearAllBrushes();
    updateCharts();
  });
}

/* =====================================================================
 * 初始化
 * ===================================================================== */
async function init() {
  setupFilters();
  setupKeyboardNavigation();
  updateKeyboardHints();
  try {
    const [rows, geojson] = await Promise.all([d3.csv(DATA_URL), loadGeoJSON()]);
    state.allData = parseRows(rows);
    if (!state.allData.length) throw new Error("沒有可用資料。");

    charts.push(
      createChart({ // View 01：經度 × 緯度（含地圖底圖）
        container: "#map-container", svg: "#map-chart", canvas: "#map-canvas",
        xDim: "lon", yDim: "lat",
        title: "View 01 震央空間分布圖（經度 × 緯度，含台灣地圖）",
        xLabel: "經度 Longitude (°E)", yLabel: "緯度 Latitude (°N)",
        base: makeLandPainter(geojson)
      }),
      createChart({ // View 02：經度 × 深度
        container: "#lon-depth-container", svg: "#lon-depth-chart", canvas: "#lon-depth-canvas",
        xDim: "lon", yDim: "depth",
        title: "View 02 經度與震源深度剖面圖",
        xLabel: "經度 Longitude (°E)", yLabel: "震源深度 Depth (km)"
      }),
      createChart({ // View 03：深度 × 緯度
        container: "#lat-depth-container", svg: "#lat-depth-chart", canvas: "#lat-depth-canvas",
        xDim: "depth", yDim: "lat",
        title: "View 03 震源深度與緯度剖面圖",
        xLabel: "震源深度 Depth (km)", yLabel: "緯度 Latitude (°N)"
      })
    );

    // 圖表尺寸改變時，圖例的圓點大小也要跟著縮放
    new ResizeObserver(() => drawMLLegend(".ml-legend")).observe($("#map-container"));

    applyFilters(); // 同時更新摘要與圖表
  } catch (error) {
    console.error(error);
    $("#filter-status").textContent = `載入失敗：${error.message}`;
  }
}

init();
