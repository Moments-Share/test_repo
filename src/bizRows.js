// 進行中事業の入力行：データ形式・旧形式からの移行・頻度の換算・CSV入出力
import Papa from "papaparse";

/* ---------- 選択肢 ---------- */
// ステージ＝時系列（どこまで進めたか）。検証状況＝顧客の証拠の強さ。両者は独立に動くので分けて持つ
export const STAGES = ["アイデア", "検証", "立ち上げ", "運用"];
export const EVIDENCE = [
  { label: "未確認", desc: "まだ顧客に聞いていない" },
  { label: "話を聞いた", desc: "顧客にヒアリングした" },
  { label: "価格を提示", desc: "価格を提示した" },
  { label: "商談・見積", desc: "見積・商談まで進んだ" },
  { label: "受注あり", desc: "有償で売れた（受注あり）" },
];
export const BIZ_TYPES = ["BtoB", "BtoC"];
export const FREQ_TYPES = [
  { id: "once", label: "単発" },
  { id: "monthly", label: "月額" },
  { id: "yearly", label: "年額" },
  { id: "perYear", label: "年◯回" },
];

/* ---------- 表記ゆれの吸収 ---------- */
function norm(v) {
  return String(v == null ? "" : v).normalize("NFKC").trim();
}
function key(v) {
  return norm(v).toLowerCase().replace(/[\s・_\-]/g, "");
}

export function parseBizType(v) {
  const k = key(v);
  if (!k) return null;
  if (/^(btob|b2b|bb|法人|法人向け|企業向け)$/.test(k)) return "BtoB";
  if (/^(btoc|b2c|bc|個人|個人向け|消費者|消費者向け)$/.test(k)) return "BtoC";
  return null;
}

const STAGE_ALIASES = [
  ["アイデア", ["アイデア", "アイディア", "構想", "企画", "idea"]],
  ["検証", ["検証", "実証", "poc", "テスト", "試験"]],
  ["立ち上げ", ["立ち上げ", "立上げ", "立ちあげ", "立上", "ローンチ", "launch", "開始"]],
  ["運用", ["運用", "拡大", "本格展開", "展開", "成長", "scale", "運営"]],
];
export function parseStage(v) {
  const k = key(v);
  if (!k) return null;
  for (const [stage, aliases] of STAGE_ALIASES) if (aliases.some((a) => k === key(a))) return stage;
  return null;
}

export function parseEvidence(v) {
  const k = key(v);
  if (!k) return "";
  if (/^[1-5]$/.test(k)) return EVIDENCE[Number(k) - 1].label;
  for (const e of EVIDENCE) if (k === key(e.label) || k === key(e.desc)) return e.label;
  if (/受注|有償|売れた|販売実績/.test(k)) return "受注あり";
  if (/商談|見積/.test(k)) return "商談・見積";
  if (/価格|提示/.test(k)) return "価格を提示";
  if (/ヒアリング|話を聞|聞いた/.test(k)) return "話を聞いた";
  if (/未確認|まだ|聞いていない|なし/.test(k)) return "未確認";
  return null;
}
export function evidenceDesc(label) {
  const e = EVIDENCE.find((x) => x.label === label);
  return e ? e.label + "（" + e.desc + "）" : "未確認";
}

// 数値：「300,000」「300000円」「¥300,000」なども受け付ける。空欄は ""、読めなければ NaN
export function parseNum(v) {
  const s = norm(v).replace(/[,，\s円¥￥]/g, "").replace(/人日.*$/, "").replace(/%$/, "");
  if (s === "") return "";
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

// 頻度種別。「年4回」のように回数入りなら count も返す
export function parseFreq(typeVal, countVal) {
  const k = key(typeVal);
  const count = parseNum(countVal);
  if (!k) return null;
  if (/^(単発|一回|1回|都度|once|onetime|スポット)$/.test(k)) return { freqType: "once", freqCount: "" };
  if (/^(月額|毎月|月|月次|サブスク|monthly|month)$/.test(k)) return { freqType: "monthly", freqCount: "" };
  if (/^(年額|年間|年1|年契約|yearly|annual|year)$/.test(k)) return { freqType: "yearly", freqCount: "" };
  const m = k.match(/^年(\d+(?:\.\d+)?)回$/);
  if (m) return { freqType: "perYear", freqCount: Number(m[1]) };
  if (/^(年◯回|年○回|年n回|年回|回数|peryear|times)$/.test(k)) {
    return typeof count === "number" && count > 0 ? { freqType: "perYear", freqCount: count } : { freqType: "perYear", freqCount: NaN };
  }
  // 旧形式：頻度に回数の数字だけが入っている
  return legacyFreq(parseNum(typeVal));
}
// 旧形式の「回/年」の数値を種別に（1→単発、12→月額、それ以外→年◯回）
function legacyFreq(n) {
  if (!(typeof n === "number" && n > 0)) return null;
  if (n === 1) return { freqType: "once", freqCount: "" };
  if (n === 12) return { freqType: "monthly", freqCount: "" };
  return { freqType: "perYear", freqCount: n };
}

/* ---------- 行の形と計算 ---------- */
export function perYear(r) {
  if (r.freqType === "monthly") return 12;
  if (r.freqType === "once" || r.freqType === "yearly") return 1;
  const n = Number(r.freqCount);
  return n > 0 ? n : 1;
}
export function freqText(r) {
  const t = FREQ_TYPES.find((f) => f.id === r.freqType);
  if (!t) return perYear(r) + "回/年";
  if (r.freqType === "perYear") return "年" + perYear(r) + "回";
  return t.label + "（年" + perYear(r) + "回換算）";
}
export function marginOf(r) {
  const p = Number(r.price), c = Number(r.unitCost);
  if (!(p > 0) || r.unitCost === "" || r.unitCost == null) return null;
  return Math.round(((p - c) / p) * 100);
}
export function hasDetail(r) {
  return !!(norm(r.memo) || r.vstatus || norm(r.note) || (r.resource !== "" && r.resource != null) || Number(r.passion) !== 3);
}
export function isBlank(r) {
  return !norm(r.name) && !norm(r.memo) && !norm(r.note) && r.price === "" && r.unitCost === "";
}
// 必須（事業名・形態・売価・原価・頻度・ステージ）の未入力を返す
export function missingRequired(r) {
  const miss = [];
  if (!norm(r.name)) miss.push("事業名");
  if (!BIZ_TYPES.includes(r.bizType)) miss.push("形態");
  if (r.price === "" || r.price == null || isNaN(Number(r.price))) miss.push("売価");
  if (r.unitCost === "" || r.unitCost == null || isNaN(Number(r.unitCost))) miss.push("原価");
  if (!FREQ_TYPES.some((f) => f.id === r.freqType) || (r.freqType === "perYear" && !(Number(r.freqCount) > 0))) miss.push("頻度");
  if (!STAGES.includes(r.stage)) miss.push("ステージ");
  return miss;
}

export function nextId(rows) {
  let max = 0;
  rows.forEach((r) => { const m = String(r.id || "").match(/^B(\d+)$/); if (m) max = Math.max(max, Number(m[1])); });
  return "B" + String(max + 1).padStart(3, "0");
}
export function newRow(id) {
  return { id, name: "", bizType: "BtoB", price: "", unitCost: "", freqType: "once", freqCount: "", stage: "検証", vstatus: "", passion: 3, resource: "", memo: "", note: "" };
}

// 旧形式（数字以外の価値 / 補足 / 推進体制 を別々に持つ、頻度は回/年の数値、旧ステージ名・旧検証状況）を新形式へ
export function normalizeRow(r, id) {
  const legacy = [r.value, r.evidence, r.team].map(norm).filter(Boolean);
  const note = [norm(r.note), ...legacy].filter(Boolean).join("\n");
  let freq = r.freqType ? { freqType: r.freqType, freqCount: r.freqType === "perYear" ? r.freqCount : "" } : null;
  if (!freq) {
    freq = legacyFreq(Number(r.freq) || 1);
  }
  const price = r.price === "" || r.price == null ? "" : Number(r.price);
  const unitCost = r.unitCost === "" || r.unitCost == null ? "" : Number(r.unitCost);
  return {
    id: r.id || id,
    name: norm(r.name),
    bizType: parseBizType(r.bizType) || "BtoB",
    price: isNaN(price) ? "" : price,
    unitCost: isNaN(unitCost) ? "" : unitCost,
    ...freq,
    stage: parseStage(r.stage) || "検証",
    vstatus: parseEvidence(r.vstatus) || "",
    passion: Math.min(5, Math.max(1, Number(r.passion) || 3)),
    resource: r.resource === "" || r.resource == null || isNaN(Number(r.resource)) ? "" : Number(r.resource),
    memo: norm(r.memo),
    note,
  };
}

/* ---------- CSV ---------- */
export const CSV_HEADERS = ["ID", "事業名", "形態", "売価", "原価", "頻度種別", "頻度回数", "ステージ", "検証状況", "熱量", "リソース_人日月", "概要", "メモ", "粗利率"];
const REQUIRED_COLS = [["name", "事業名"], ["bizType", "形態"], ["price", "売価"], ["unitCost", "原価"], ["freqType", "頻度"], ["stage", "ステージ"]];

function rowToCells(r) {
  const m = marginOf(r);
  const ft = FREQ_TYPES.find((f) => f.id === r.freqType);
  return [r.id, r.name, r.bizType, r.price, r.unitCost, ft ? ft.label : "", perYear(r), r.stage, r.vstatus, r.passion, r.resource, r.memo, r.note, m == null ? "" : m + "%"];
}
function toCsv(rows) {
  return "﻿" + Papa.unparse({ fields: CSV_HEADERS, data: rows.map(rowToCells) }, { newline: "\r\n" });
}
export function exportCsv(rows) {
  return toCsv(rows.filter((r) => norm(r.name)));
}
export function templateCsv() {
  return toCsv([{
    id: "", name: "（例）試作品の短納期サービス", bizType: "BtoB", price: 300000, unitCost: 180000, freqType: "perYear", freqCount: 4,
    stage: "検証", vstatus: "商談・見積", passion: 4, resource: 4, memo: "既存の加工設備で他業種の試作を最短3日で",
    note: "設備稼働率の向上。既存顧客3社から引き合い。営業部長が兼任で推進",
  }]);
}

// 見出しの表記ゆれ：括弧や「_」以降を落として比較（例：リソース（人日/月）→リソース）
const COL_ALIASES = {
  id: ["id"], name: ["事業名", "名前", "name"], bizType: ["形態", "提供形態", "type"],
  price: ["売価", "単価", "価格", "price"], unitCost: ["原価", "コスト", "cost"],
  freqType: ["頻度種別", "頻度", "freq"], freqCount: ["頻度回数", "回数"],
  stage: ["ステージ", "段階", "stage"], vstatus: ["検証状況", "検証レベル"], passion: ["熱量", "passion"],
  resource: ["リソース", "工数", "resource"], memo: ["概要", "説明", "memo"], note: ["メモ", "備考", "note"],
  legacyValue: ["数字以外の価値", "価値"], legacyEvidence: ["補足", "手応え"], legacyTeam: ["推進体制", "体制"],
  margin: ["粗利率"],
};
function headerKey(h) {
  return key(norm(h).replace(/[（(].*$/, "").replace(/_.*$/, ""));
}
function mapHeaders(header) {
  const idx = {};
  header.forEach((h, i) => {
    const k = headerKey(h);
    for (const [field, aliases] of Object.entries(COL_ALIASES)) {
      if (idx[field] == null && aliases.some((a) => key(a) === k)) { idx[field] = i; break; }
    }
  });
  return idx;
}

// 2次元配列（1行目が見出し）を検証して行データに。line は元ファイルの行番号（見出し=1）
export function rowsFromTable(table, lineNumbers) {
  const header = (table[0] || []).map(norm);
  const idx = mapHeaders(header);
  const missingCols = REQUIRED_COLS.filter(([f]) => idx[f] == null).map(([, label]) => label);
  if (missingCols.length) return { rows: [], errors: [{ line: 1, reason: "必須の列がありません：" + missingCols.join("・") }], warnings: [] };
  const rows = [], errors = [], warnings = [];
  for (let t = 1; t < table.length; t++) {
    const cells = table[t] || [];
    const line = lineNumbers ? lineNumbers[t] : t + 1;
    const get = (f) => (idx[f] == null ? "" : norm(cells[idx[f]]));
    if (cells.every((c) => !norm(c))) continue;
    const reasons = [];
    const name = get("name");
    if (!name) reasons.push("事業名が空です");
    const bizRaw = get("bizType"), bizType = parseBizType(bizRaw);
    if (!bizRaw) reasons.push("形態が空です");
    else if (!bizType) reasons.push("形態「" + bizRaw + "」を判別できません（BtoB / BtoC）");
    const num = (f, label) => {
      const raw = get(f), n = parseNum(raw);
      if (raw === "") reasons.push(label + "が空です");
      else if (typeof n !== "number" || isNaN(n)) reasons.push(label + "「" + raw + "」が数値ではありません");
      return n;
    };
    const price = num("price", "売価"), unitCost = num("unitCost", "原価");
    const fRaw = get("freqType"), freq = parseFreq(fRaw, get("freqCount"));
    if (!fRaw) reasons.push("頻度が空です");
    else if (!freq) reasons.push("頻度「" + fRaw + "」を判別できません（単発 / 月額 / 年額 / 年◯回）");
    else if (freq.freqType === "perYear" && !(freq.freqCount > 0)) reasons.push("年◯回の場合は頻度回数が必要です");
    const stRaw = get("stage"), stage = parseStage(stRaw);
    if (!stRaw) reasons.push("ステージが空です");
    else if (!stage) reasons.push("ステージ「" + stRaw + "」を判別できません（" + STAGES.join(" / ") + "）");
    if (reasons.length) { errors.push({ line, name, reason: reasons.join("、") }); continue; }

    // 任意項目：読めない値は空欄にして取り込み、警告を出す
    const evRaw = get("vstatus"), ev = parseEvidence(evRaw);
    if (ev == null) warnings.push({ line, name, reason: "検証状況「" + evRaw + "」を判別できないため空欄にしました" });
    const paRaw = get("passion"), pa = parseNum(paRaw);
    let passion = 3;
    if (paRaw !== "") { if (pa >= 1 && pa <= 5) passion = Math.round(pa); else warnings.push({ line, name, reason: "熱量「" + paRaw + "」は1〜5ではないため3にしました" }); }
    const reRaw = get("resource"), re = parseNum(reRaw);
    if (reRaw !== "" && (typeof re !== "number" || isNaN(re))) warnings.push({ line, name, reason: "リソース「" + reRaw + "」が数値ではないため空欄にしました" });
    const note = [get("note"), get("legacyValue"), get("legacyEvidence"), get("legacyTeam")].filter(Boolean).join("\n");
    rows.push({
      id: get("id"), name, bizType, price, unitCost, freqType: freq.freqType, freqCount: freq.freqType === "perYear" ? freq.freqCount : "",
      stage, vstatus: ev || "", passion, resource: typeof re === "number" && !isNaN(re) ? re : "", memo: get("memo"), note,
    });
  }
  return { rows, errors, warnings };
}

// UTF-8（BOMあり/なし）と Shift_JIS を自動判別
export function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  } catch (e) {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}
export function parseCsvText(text) {
  const res = Papa.parse(text, { skipEmptyLines: false });
  // 各レコードの開始行番号（セル内改行を考慮）を数える
  const table = [], lines = [];
  let line = 1;
  res.data.forEach((rec) => {
    const start = line;
    line += 1 + rec.reduce((s, c) => s + (String(c).match(/\n/g) || []).length, 0);
    if (rec.length === 1 && rec[0] === "") return;
    table.push(rec); lines.push(start);
  });
  return rowsFromTable(table, lines);
}

// 取り込み：ID一致は上書き、ID空欄・未登録は追加。空の行は取り除く
export function mergeRows(existing, imported) {
  const out = existing.filter((r) => !isBlank(r));
  let added = 0, updated = 0;
  imported.forEach((r) => {
    const i = r.id ? out.findIndex((x) => x.id === r.id) : -1;
    if (i >= 0) { out[i] = { ...r }; updated++; }
    else { out.push({ ...r, id: r.id || nextId(out) }); added++; }
  });
  return { rows: out, added, updated };
}
