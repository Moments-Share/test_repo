import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import * as XLSX from "xlsx";

/* =========================================================================
   事業性検証スタジオ  ―  "いいね"で終わらせない。数字で語れる事業案を半日で。
   種を入れる → 3案を比較 → 事業性検証(6ステップ) → 3分ピッチ + その場決裁
   ========================================================================= */

// モデルはサーバー側(api/claude.js)の既定を使う。上書きしたい場合のみ指定。
const MODEL = "";

/* ---------- API（サーバー経由でAPIキーを隠す） ---------- */
// サーバーに APP_PASSCODE が設定されている場合だけ、初回に合言葉を聞いてこのブラウザに覚える
function getPasscode() { try { return localStorage.getItem("vs-passcode") || ""; } catch (e) { return ""; } }
function setPasscode(v) { try { localStorage.setItem("vs-passcode", v); } catch (e) {} }
async function callClaude(system, user, maxTokens, retried) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-passcode": getPasscode() },
    body: JSON.stringify({ model: MODEL || undefined, max_tokens: maxTokens || 1500, system, messages: [{ role: "user", content: user }] }),
  });
  if (res.status === 401 && !retried) {
    const code = window.prompt("合言葉を入力してください（管理者から共有されたもの）");
    if (code) { setPasscode(code.trim()); return callClaude(system, user, maxTokens, true); }
  }
  if (!res.ok) {
    let msg = "API応答エラー (" + res.status + ")";
    try { const e = await res.json(); if (e && e.error) msg += "：" + (e.error.message || JSON.stringify(e.error)); } catch (x) {}
    throw new Error(msg);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function parseJSON(text) {
  let t = (text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

/* ---------- format ---------- */
function yen(n) {
  if (n == null || isNaN(n)) return "—";
  n = Number(n); const neg = n < 0; n = Math.abs(n);
  let s;
  if (n >= 1e8) s = (n / 1e8).toFixed(n >= 1e9 ? 0 : n >= 1e8 ? 2 : 1).replace(/\.?0+$/, "") + "億円";
  else if (n >= 1e4) s = Math.round(n / 1e4).toLocaleString() + "万円";
  else s = Math.round(n).toLocaleString() + "円";
  return (neg ? "-" : "") + s;
}
function num(n) { return n == null || isNaN(n) ? "—" : Number(n).toLocaleString(); }

const SCORE_AXES = [
  { key: "market", label: "市場性" }, { key: "feasibility", label: "実現性" },
  { key: "uniqueness", label: "独自性" }, { key: "profitability", label: "収益性" },
  { key: "speed", label: "スピード" },
];
function composite(c) {
  const s = c.scores || {};
  const v = SCORE_AXES.map((a) => Number(s[a.key]) || 0);
  return Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 10) / 10;
}

const THEMES = [
  { id: "asset", label: "強み・技術を生かす", best: true,
    question: "うちの技術・設備・商品を、まだ取引のない“誰に・どう売れば”1億円になるか？",
    note: "加工・試作・設計など、今ある強みを新しい市場や売り方で。最短で1億に届きやすい本命。" },
  { id: "internal", label: "困りごとを商品にする",
    question: "自社が困っていることを、同じく困る他社にも売れる商品にできないか？",
    note: "業務のムダ・非効率を、外にも売れる仕組みやサービスへ。" },
  { id: "seed", label: "新しい種から",
    question: "3年で1億円になる、まったく新しい収益の柱は何か？",
    note: "既存に縛られず、新市場・新事業を探す。" },
];
const TARGETS = [
  { id: "100m", label: "1億円以上 / 3年", amount: 100000000 },
  { id: "300m", label: "3億円 / 3年", amount: 300000000 },
];

/* ---------- prompts ---------- */
function candSys(themeLabel, targetLabel, question) {
  return (
    "あなたは日本市場に精通した新規事業開発の専門家であり、製造業など既存事業を持つ企業の新規事業開発にも詳しいベンチャーキャピタリストです。" +
    "今回のお題（問い）：『" + (question || themeLabel) + "』。この問いに答える形で、テーマ『" + themeLabel + "』に沿った、方向性の異なる新規事業アイデアを必ず3つ生成します。" +
    "特に自社の既存の強み・技術・設備・商品・顧客基盤を起点に、まだ取引のない相手や新しい売り方で1億円に届く道を優先的に考えてください。" +
    "各案は現実的で、3年目の想定年商が『" + targetLabel + "』規模に届きうる事業に。金額はすべて日本円の整数(単位なし)、スコアは1〜5の整数。" +
    "出力はJSONのみ。前置き・説明・マークダウン・コードフェンス(```)は絶対に含めないでください。" +
    '形式:{"candidates":[{"name":"事業名","catch":"一言キャッチ","problem":"解決する課題(1-2文)","customer":"ターゲット顧客",' +
    '"solution":"ソリューション概要(1-2文)","revenueModel":"収益モデル","estRevenueY3":3年目想定年商_円,"estInitialCost":初期投資目安_円,' +
    '"grossMarginPct":想定粗利率_数値,"scores":{"market":1-5,"feasibility":1-5,"uniqueness":1-5,"profitability":1-5,"speed":1-5},' +
    '"why":"推しポイント(1文)","risk":"最大のリスク(1文)"}]}'
  );
}
const V_SYS = {
  market:
    "あなたは市場アナリストです。日本市場を前提に市場規模TAM/SAM/SOMを金額(円・整数)で算出し、各根拠と前提、市場の成長性を示します。過度に楽観的にしないこと。" +
    "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
    '形式:{"tam":円,"tamNote":"根拠","sam":円,"samNote":"根拠","som":円,"somNote":"根拠","assumptions":["前提1","前提2","前提3"],"growth":"市場の成長性(1文)"}',
  custcomp:
    "あなたは顧客・競合分析の専門家です。ターゲット顧客のペルソナと片付けたい用事(JTBD)、主要な競合・代替、差別化のポジショニングを示します。" +
    "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
    '形式:{"persona":{"name":"ペルソナ名","profile":"属性","context":"状況"},"jobs":[{"job":"用事","pain":"痛み","gain":"成果"}],' +
    '"competitors":[{"name":"競合/代替","strength":"強み","weakness":"弱み","ourEdge":"我々の優位"}],' +
    '"positioning":{"axisX":"横軸の対立概念","axisY":"縦軸の対立概念","ourPosition":"我々の位置(1文)"},"insight":"顧客インサイト(1文)"}',
  revstruct:
    "あなたはビジネスモデル設計の専門家です。『誰に・何を・いくらで』の収益構造と、価格設計、収益源、主要コスト構造、想定粗利率を具体的に示します。金額は円・整数。" +
    "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
    '形式:{"who":"誰に(顧客セグメント)","what":"何を(提供物)","pricing":"いくらで(価格設計の考え方1-2文)",' +
    '"revenueStreams":[{"name":"収益源","detail":"内容"}],"costStructure":[{"name":"主要コスト","detail":"内容"}],"grossMarginNote":"粗利率の見立て(1文)"}',
  forecast:
    "あなたは新規事業の財務モデラーです。『顧客数×単価×頻度』で売上を積み上げるための初期パラメータを、現実的な仮定で提案します。金額は円・整数、率は数値(例:70)。" +
    "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
    '形式:{"customersY1":1年目想定顧客数,"price":単価_円,"freqPerYear":年間購入頻度_回,"growthY2Pct":2年目顧客成長率_数値,"growthY3Pct":3年目顧客成長率_数値,' +
    '"grossMarginPct":粗利率_数値,"fixedCostAnnual":年間固定費_円,"initialInvest":初期投資_円,"rationale":"この数値の根拠(1-2文)","notes":["前提メモ1","前提メモ2"]}',
  execkpi:
    "あなたは新規事業の実行責任者です。売上KPI・行動KPI、そして『誰が・どの予算で・いつまでに』の実行計画、主要マイルストーンを示します。KPIには目標値を付けること。" +
    "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
    '形式:{"salesKpis":[{"name":"売上KPI","target":"目標値"}],"actionKpis":[{"name":"行動KPI","target":"目標値"}],' +
    '"plan":[{"when":"時期","who":"担当","budget":"予算","what":"やること"}],"milestones":[{"when":"時期","what":"達成事項"}]}',
};
const SYS_DECK =
  "あなたはピッチ資料の構成作家です。事業案と検証結果をもとに、経営層向け『3分ピッチ』の骨子を返します。スライドは9枚以内、各スライドはタイトル・サブタイトル・要点(2-3個・簡潔)・話すポイント。数字で語れる構成にすること。" +
  "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
  '形式:{"slides":[{"no":1,"title":"...","subtitle":"...","bullets":["...","..."],"speaker":"話すポイント"}]}';

/* ---------- 進行中事業の整理モード ---------- */
const PF_STAGES = ["構想", "検証", "立上げ", "拡大"];
// 顧客にどこまで確かめたか（Evidenceの核）。選ぶだけで良いように段階化
const EVIDENCE_LEVELS = [
  "まだ顧客に聞いていない",
  "顧客にヒアリングした",
  "価格を提示した",
  "見積・商談まで進んだ",
  "有償で売れた（受注あり）",
];
const PF_SYS =
  "あなたは複数の新規事業を売上1億円規模まで育ててきた、経験豊富な事業家であり投資家です。市場起点で厳しく評価し、『作れるから作る』『原価を積み上げただけ』の楽観や思い込みを排します。同時に、まだ売上が立っていない検証段階の芽を、可能性で正しく見極めます。" +
  "『成功』の定義は、3年で売上1億円以上に到達できること。現在赤字・売上ゼロでも、1億円に届く現実的な道筋（十分な市場・妥当な価格・獲得の勝ち筋）が描けるなら前向きに、描けないなら畳む、という判断をします。" +
  "各事業を次の4項目で1〜5点で採点（総合スコアとA〜Eランク＝継続/撤退の根拠）：marketSize=市場規模(1億円を狙えるだけの市場・ニーズがあるか)、profitability=利益率(原価と市場が払う価格から見て儲かる構造か)、barrier=参入障壁(真似されにくさ・堀)、uniqueness=独自性(自社ならではの強みか)。" +
  "さらに市場規模とニーズから売上予測を出します：som=現実的に獲得しうる市場規模(円)、low3/base3/high3=3年後の到達売上の3シナリオ(悲観/普通/楽観, 円, 顧客数×単価×頻度や獲得率で概算)、fcBasis=その予測根拠(1文, 例『客数◯×単価◯×年◯回、獲得率◯%』)。base3(普通)を現実的な本命値とすること。" +
  "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
  '形式:{"businesses":[{"name":"事業名","marketSize":1-5,"profitability":1-5,"barrier":1-5,"uniqueness":1-5,"som":獲得可能市場_円,"low3":保守_円,"base3":標準_円,"high3":強気_円,"fcBasis":"予測根拠(1文)","pathToTarget":"1億に届く条件(1文)","sellability":1-5,"strategicValue":1-5,"growth":1-5,"marketReality":"原価と市場評価/売れる構造の一言","otherValue":"数字に出ない価値・残す理由(なければ空文字)","reason":"プロとしての評価の要点(1文)"}],' +
  '"portfolio":{"diagnosis":"プロ視点の全体診断(2-3文)。1億到達の可能性・売れる構造・リソース分散の観点で。","reallocation":[{"from":"減らす/畳む事業","to":"寄せる先の事業","detail":"動かすリソースと理由(1文)"}],' +
  '"validations":[{"business":"実証する事業","hypothesis":"確かめたい仮説","experiment":"最小の実験(小さく試す方法)","criteria":"続ける/やめるを分ける判断基準","period":"期間の目安"}],' +
  '"nonFinancial":"数字に出ない価値をステークホルダーにどう見せるかの方針(1-2文)",' +
  '"execLogic":["経営者への説明を5ステップで。1:現状(何がいくつ、多くは未収益)","2:全部は続けられない(リソースの現実)","3:だから1億到達の可能性で仕分ける","4:可能性はあるが未検証のものは実証(仮説→小さく試す→ダメなら早くやめる)","5:結論としてこのリソース配分にする"]}}';

function emptyRows() {
  return [0, 1, 2].map(() => ({ name: "", memo: "", value: "", vstatus: "", evidence: "", bizType: "BtoB", price: "", unitCost: "", freq: 1, team: "", resource: "", passion: 3, stage: "検証" }));
}
const PF_SAMPLE = [
  // 架空の部品メーカーの例（実在の企業・事業とは無関係）
  { name: "工場見学ツアー", team: "総務が兼任。現場は協力的だが本業を圧迫", memo: "工場見学＋ものづくり体験。単価UPの余地あり", value: "認知・採用・ファン化", vstatus: "有償で売れた（受注あり）", evidence: "リピート来訪あり・満足度高い。受入枠が少ない", bizType: "BtoC", price: 3000, unitCost: 1000, freq: 1, resource: 3, passion: 4, stage: "拡大" },
  { name: "試作品の短納期サービス", team: "営業部長が兼任。製造部の協力あり", memo: "既存の加工設備で他業種の試作を最短3日で", value: "設備稼働率の向上", vstatus: "見積・商談まで進んだ", evidence: "既存顧客3社から引き合い。価格は未確定", bizType: "BtoB", price: 300000, unitCost: 180000, freq: 4, resource: 4, passion: 4, stage: "検証" },
  { name: "自社ブランドのアウトドア用品", team: "担当未定", memo: "自社素材で高級ギア。原価が高く市場評価と乖離", value: "ブランド・話題性", vstatus: "価格を提示した", evidence: "バイヤー評価は想定の1/3の価格。誰に売るか未定", bizType: "BtoC", price: 30000, unitCost: 15000, freq: 1, resource: 1, passion: 2, stage: "構想" },
  { name: "設備の予防保全IoT", team: "技術者1名が空き時間で開発", memo: "自社工場で使っているセンサー監視を外販", value: "自社の技術蓄積", vstatus: "顧客にヒアリングした", evidence: "同業5社に聞き、2社が関心。まだ販売前", bizType: "BtoB", price: 50000, unitCost: 15000, freq: 12, resource: 2, passion: 3, stage: "検証" },
  { name: "地域コラボ記念品", team: "広報が兼任。自治体の窓口は社長", memo: "自治体と組んだ記念グッズ。原価割れで販売中", value: "地域貢献・自治体連携", vstatus: "有償で売れた（受注あり）", evidence: "原価割れ・リピート弱い", bizType: "BtoC", price: 5500, unitCost: 7000, freq: 1, resource: 2, passion: 2, stage: "拡大" },
];
function marginPct(rev, cost) {
  rev = Number(rev) || 0; cost = Number(cost) || 0;
  if (rev <= 0) return 0;
  return Math.round(((rev - cost) / rev) * 100);
}
function marginTo5(m) { return m >= 40 ? 5 : m >= 30 ? 4 : m >= 20 ? 3 : m >= 8 ? 2 : 1; }
// 目標(1億等)への到達見込み。売上がまだ無くても「可能性」で測る
function reachScore(b, targetAmount) {
  if (targetAmount && Number(b.realY3) > 0) {
    const r = b.realY3 / targetAmount;
    return r >= 1 ? 5 : r >= 0.7 ? 4 : r >= 0.4 ? 3 : r >= 0.15 ? 2 : 1;
  }
  return Number(b.potential) || 3; // 見積り売上が無ければAIの可能性スコア(1-5)
}
function reachMark(s) { return s >= 5 ? "◎" : s >= 4 ? "○" : s >= 3 ? "△" : "×"; }

// ===== 事業評価スコアカード（1億＝成功を前提に4項目で採点）=====
// 各1〜5、重み付きで100点満点 → A〜Eランク → 継続/撤退の判定
const EVAL_AXES = [
  { key: "marketSize", label: "市場規模", weight: 30, hint: "1億を狙える市場があるか" },
  { key: "profitability", label: "利益率", weight: 25, hint: "儲かる構造か（原価と価格）" },
  { key: "barrier", label: "参入障壁", weight: 20, hint: "真似されにくいか・堀" },
  { key: "uniqueness", label: "独自性", weight: 25, hint: "自社ならではの強みか" },
];
function evalScore(b) {
  let sum = 0, wsum = 0;
  EVAL_AXES.forEach((a) => { const v = Number(b[a.key]) || 3; sum += (v / 5) * a.weight; wsum += a.weight; });
  return Math.round((sum / wsum) * 100); // 0-100
}
function rankFromScore(pct) {
  return pct >= 80 ? "A" : pct >= 65 ? "B" : pct >= 50 ? "C" : pct >= 35 ? "D" : "E";
}
const RANK_META = {
  A: { mark: "◎", decision: "集中", note: "最優先で継続・リソースを寄せる", cls: "rA" },
  B: { mark: "○", decision: "継続", note: "継続。伸ばし方を詰める", cls: "rB" },
  C: { mark: "△", decision: "実証", note: "条件つき。小さく検証して見極め", cls: "rC" },
  D: { mark: "▲", decision: "縮小", note: "縮小・見直し候補", cls: "rD" },
  E: { mark: "×", decision: "撤退", note: "撤退を検討。資源を解放", cls: "rE" },
};
// 各指標の1〜5点をA〜Eランクに変換（5=A,4=B,3=C,2=D,1=E）
function axisRank(v) { v = Number(v) || 0; return v >= 4.5 ? "A" : v >= 3.5 ? "B" : v >= 2.5 ? "C" : v >= 1.5 ? "D" : "E"; }

/* ===================================================================
   1億円到達可能性スコア（100点＝6大項目×26小項目、各0〜5。大項目の配点 max で重み付け）
   専門家フレーム対応：需要=Desirability+Traction(+Timing) / 市場=Market / 売上モデル・収益性=Viability /
   勝てる理由=Moat+Strategic fit+Adaptability / 実行・推進体制=Feasibility+Team
   AIは各小項目に {score,status,evidence,reason,missingEvidence,source} を返し、
   合計・カバレッジ・Evidence Levelはアプリが機械計算する。
   =================================================================== */
const SCORE_MODEL = [
  { id: "demand", label: "顧客課題・需要", max: 20, items: [
    { id: "problemStrength", label: "課題の強さ", rubric: ["誰の課題か不明", "あったら便利", "明確な不便がある", "時間/コスト/売上への影響", "既に対策にお金/時間を使用", "緊急性高く予算化・購入理由が明確"] },
    { id: "customerValidation", label: "顧客検証", rubric: ["顧客と話していない", "身内・社内の意見のみ", "1〜4顧客に確認", "5〜9顧客に確認", "10顧客以上+複数から同一課題", "複数セグメントで再現性を確認"] },
    { id: "willingnessToPay", label: "支払意思", rubric: ["未確認", "「欲しい」と言われた", "価格提示して前向き", "見積・予約・具体商談", "有償PoC・初回購入", "複数顧客が実価格で購入"] },
    { id: "traction", label: "実績・継続性", rubric: ["実績なし", "問い合わせ等あり", "初回取引あり", "複数顧客へ販売", "リピート・継続利用", "複数顧客で継続・紹介・追加購入"] },
    { id: "whyNow", label: "なぜ今か", rubric: ["今やる理由がない", "漠然とした追い風", "市場・技術・規制の変化を指摘できる", "変化がデータで確認できる", "変化で顧客の購買行動が既に動いている", "今を逃すと参入できない明確な窓"] },
  ] },
  { id: "market", label: "市場・顧客母数", max: 15, items: [
    { id: "marketHeadroom", label: "1億への市場余力", rubric: ["現実的獲得市場<1億", "1〜1.5億", "1.5〜3億", "3〜5億", "5〜10億", "10億以上"] },
    { id: "customerClarity", label: "顧客像の明確さ", rubric: ["不明", "業種のみ", "業種+規模", "業種+規模+地域", "部門/担当まで具体", "具体ターゲットが明確"] },
    { id: "customerAccess", label: "顧客アクセス", rubric: ["接触方法不明", "広告/営業すれば届く", "チャネル仮説あり", "実際に接触可能", "既存顧客/販売網/パートナー", "既存チャネルから継続商談/購入"] },
  ] },
  { id: "model", label: "1億円売上モデル", max: 20, items: [
    { id: "mathViability", label: "数学的成立性", rubric: ["成立しない", "必要数が母数に肉薄", "やや厳しい", "妥当", "余裕あり", "十分な余裕"] },
    { id: "acquisitionRealism", label: "獲得現実性", rubric: ["ファネル不明", "非現実的", "仮説のみ", "一部実績", "実績とほぼ整合", "既存実績で到達可能"] },
    { id: "priceValidity", label: "単価妥当性", rubric: ["根拠なし", "原価から決めただけ", "競合価格を参考", "顧客ヒアリングで確認", "見積・予約で確認", "実価格で複数販売"] },
    { id: "growthRepeatability", label: "成長再現性", rubric: ["再現性なし", "人脈で1社のみ", "限定的", "一部仕組み化", "反復獲得の兆し", "仕組みで反復獲得"] },
  ] },
  { id: "profit", label: "収益性", max: 15, items: [
    { id: "grossMargin", label: "粗利構造", rubric: ["0%以下", "1〜19%", "20〜29%", "30〜39%", "40〜49%", "50%以上"] },
    { id: "unitEconomics", label: "獲得後利益", rubric: ["赤字", "ほぼ残らない", "わずかに残る", "一定利益が残る", "十分な利益", "高利益"] },
    { id: "paybackViability", label: "投資回収性", rubric: ["回収不能", "3年で未回収", "ぎりぎり", "3年内で回収", "早期回収", "初期投資小で即回収"] },
  ] },
  { id: "win", label: "勝てる理由", max: 15, items: [
    { id: "customerDifference", label: "顧客価値の差", rubric: ["差がない", "わずかな差", "一定の差", "明確な差", "強い差", "圧倒的な差"] },
    { id: "companyAdvantage", label: "自社優位性", rubric: ["なし", "弱い", "一部あり", "明確にあり", "強い", "独占的な資産"] },
    { id: "defensibility", label: "模倣困難性", rubric: ["誰でもすぐできる", "容易に模倣可能", "一定ノウハウ必要", "技術/顧客基盤が必要", "複数の参入障壁", "長期資産/特許/NW"] },
    { id: "strategicFit", label: "自社資産の活用（Strategic fit）", rubric: ["既存の技術・設備・販路と無関係", "間接的に関係", "一部の技術・設備を流用", "主要な技術・設備を活用", "技術・設備に加え販路・顧客基盤も活用", "本業とも相互に強め合うシナジー"] },
    { id: "competitiveResponse", label: "競合・代替への備え", rubric: ["競合・代替を把握していない", "名前を挙げられる程度", "主要競合と代替手段を把握", "比較して優位点を説明できる", "顧客が競合でなく自社を選んだ事例あり", "競合の反撃・環境変化にも打ち手を用意"] },
  ] },
  { id: "exec", label: "実行・推進体制", max: 15, items: [
    { id: "salesCapability", label: "販売体制", rubric: ["未定", "仮説のみ", "一部決定", "担当決定", "既存営業網あり", "代理店含め確立"] },
    { id: "supplyCapability", label: "生産・提供能力", rubric: ["大幅不足", "不足", "やや不足", "概ね対応可", "余裕あり", "十分な能力"] },
    { id: "feasibility3yr", label: "3年以内の実現性", rubric: ["5年超", "4〜5年", "3年ぎりぎり", "3年で可能", "1〜2年で可能", "即時に可能"] },
    { id: "ownerCommitment", label: "推進オーナー（熱量×権限）", rubric: ["責任者が決まっていない", "名目上の担当のみ", "担当はいるが熱量か権限が弱い", "熱量ある担当が予算・人の一部を動かせる", "熱量と権限を持つオーナーが経営に直結", "経営が自ら推進し、意思決定が即日"] },
    { id: "dedicatedCapacity", label: "投入工数の確保", rubric: ["誰も時間を割けていない", "空き時間のみ（月数日未満）", "兼任で一定時間を確保", "兼任だが業務として工数を確保", "専任1名以上", "専任チーム＋必要な外部人材"] },
    { id: "stakeholderBuyIn", label: "巻き込み力（他部署・経営）", rubric: ["社内の協力が得られていない", "個人的な好意頼み", "一部部署が協力的", "関係部署の協力が業務として合意済み", "経営が後押しし複数部署が動く", "全社の優先事項として位置づけ"] },
  ] },
];
const ALL_SUBITEMS = SCORE_MODEL.flatMap((c) => c.items.map((it) => ({ ...it, cat: c.id, catLabel: c.label })));

// 機械計算：確定項目のみで暫定100点・カバレッジ・カテゴリ内訳
function computeScore(items) {
  items = items || {};
  let evalCount = 0;
  ALL_SUBITEMS.forEach((it) => { if ((items[it.id] || {}).status !== "unverified") evalCount++; });
  const coverage = Math.round(evalCount / ALL_SUBITEMS.length * 100);
  // 大項目ごとに「評価済み小項目の得点率 × 配点(max)」→ 評価済み大項目の配点で正規化して100点に
  let wEarned = 0, wMax = 0;
  const cats = SCORE_MODEL.map((c) => {
    let e = 0, m = 0; c.items.forEach((it) => { const s = items[it.id] || {}; if (s.status !== "unverified") { e += Math.max(0, Math.min(5, Number(s.score) || 0)); m += 5; } });
    if (m > 0) { wEarned += e / m * c.max; wMax += c.max; }
    // 表示用：未検証を0点とみなして配点に換算
    return { id: c.id, label: c.label, pts: Math.round(e / (c.items.length * 5) * c.max * 10) / 10, of: c.max, evalPts: m, pct: m ? Math.round(e / m * 100) : 0 };
  });
  const total = wMax > 0 ? Math.round(wEarned / wMax * 100) : 0;
  return { total, coverage, evalCount, of: ALL_SUBITEMS.length, cats };
}
// Evidence Level（0〜5）：支払意思・実績を重く、顧客検証・単価妥当性を加味
function evidenceLevel(items) {
  items = items || {};
  const key = [["willingnessToPay", 3], ["traction", 3], ["customerValidation", 2], ["priceValidity", 1], ["customerAccess", 1]];
  let w = 0, tot = 0;
  key.forEach(([id, wt]) => { const s = items[id]; if (s && s.status !== "unverified") { w += (Number(s.score) || 0) * wt; tot += 5 * wt; } });
  if (tot === 0) return 0;
  return Math.max(1, Math.min(5, Math.round(w / tot * 5)));
}
const SOURCE_META = {
  "実績": { cls: "src-fact", label: "実績" },
  "顧客証拠": { cls: "src-cust", label: "顧客証拠" },
  "市場データ": { cls: "src-mkt", label: "市場データ" },
  "AI推定": { cls: "src-ai", label: "AI推定" },
};

const EVAL_SYS =
  "あなたは複数の新規事業を売上1億円規模まで育ててきた事業家・投資家です。1つの事業について『3年で年商1億円に到達する可能性』を評価します。" +
  "重要な原則：あなたは点数を主観で決めません。入力された事実・証拠から、各小項目を下の基準表に厳密に照らして0〜5で判定し、根拠と不足証拠を必ず添えます。" +
  "『欲しい』と『買った』を区別し、社会的重要性ではなく顧客行動で判定。分からない項目は0点にせず status を 'unverified' にすること（未検証は減点でなくEvidence不足として扱う）。" +
  "入力の『顧客の検証状況』は支払意思(willingnessToPay)・顧客検証(customerValidation)・実績(traction)の判定根拠として重視：まだ聞いていない=低、ヒアリング=中、価格提示/見積=やや上、有償受注あり=高。" +
  "実行・推進体制のうち推進オーナー・投入工数・巻き込み力は、入力の『推進体制』『投入リソース』『熱量』から判定し、記載がなければ unverified にする（製品より先に人を見る）。" +
  "自社資産の活用(strategicFit)は、事業が自社の既存の技術・設備・販路・顧客基盤をどれだけ活かすかで判定する。" +
  "各小項目の source は 実績/顧客証拠/市場データ/AI推定 のいずれか（入力に無くAIが推定した値は必ず AI推定）。" +
  "\n【評価する" + ALL_SUBITEMS.length + "小項目と0〜5基準】\n" +
  SCORE_MODEL.map((c) => c.label + "：" + c.items.map((it) => it.id + "(" + it.label + ")=" + it.rubric.map((r, i) => i + ":" + r).join(" / ")).join(" ／ ")).join("\n") +
  "\n出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。evidence/reason/missingEvidenceは簡潔に。" +
  '\n形式:{"businessType":"BtoB|BtoC","conclusion":"結論を1文（例:市場規模は十分だが販売チャネルが弱く3年での1億到達は営業力が不足）",' +
  '"equation":{"target":100000000,"unitPrice":想定単価_円,"frequency":年間購入頻度,"neededCustomers":必要顧客数,"note":"1億円への方程式の説明1文"},' +
  '"bottleneck":"最大ボトルネック(1文)","criticalAssumption":"崩れたら終わる前提(1文)",' +
  '"nextExperiment":{"hypothesis":"検証仮説","method":"最小の実験","criteria":"続ける/やめるの判断基準","period":"期間"},' +
  '"scoreImprovement":{"itemLabel":"改善すべき最弱項目名","action":"何を証明すれば上がるか(1文)","gain":"想定上昇点(例:+8)"},' +
  '"strategicValue":"数字に出ない価値(なければ空文字)",' +
  '"items":{' + ALL_SUBITEMS.map((it) => '"' + it.id + '":{"score":0-5,"status":"evaluated|unverified","evidence":["根拠"],"reason":"判定理由(1文)","missingEvidence":"不足している証拠","source":"実績|顧客証拠|市場データ|AI推定"}').join(",") + "}}";

// 壁打ち（AIヒアリング）：未検証・弱点の中から、1億判断に効く順に3〜5問だけ生成
const INTERVIEW_SYS =
  "あなたは新規事業の評価に長けた事業家です。引き継がれた・まだ売上や予測が無い事業が多く、評価に必要な情報が不足しています。" +
  "与えられた事業情報と現在の評価（未検証/低スコアの項目）をふまえ、『3年で1億円に届くか』の判断を最も前進させる質問を3〜5問だけ選んで出します。欲張らず、決裁に効く順に厳選。" +
  "各質問には、選びやすい選択肢（証拠の強さが上がる順）と、なぜ聞くのか（『売れそう』と『実際に払う』は別の証拠、等）を添えます。回答は選択肢またはフリー記述。" +
  "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
  '形式:{"questions":[{"id":"q1","itemId":"対応する評価項目id","topic":"確認テーマ(例:価格)","question":"質問文","whyAsk":"なぜ確認するか(1文)","options":["選択肢1","選択肢2","選択肢3","選択肢4"],"allowFree":true}]}';


/* ===================================================================
   撤退ライン ＆ 成功確率
   始める前に「いつ・何が・いくつ未満なら畳むか」を数字で合意しておく。
   AIは成功確率・打ち手・ステージゲート案を出し、判定はアプリが機械計算する。
   =================================================================== */
const EXIT_SYS =
  "あなたは数多くの新規事業の立ち上げと撤退判断に関わってきた事業家・投資家です。サンクコストに引きずられず、早く小さく失敗して資源を次に回すことを重視します。" +
  "与えられた事業について、(1)3年で目標年商に到達する成功確率、(2)その確率を上げる打ち手、(3)始める前に合意しておく『撤退ライン』を設計します。" +
  "成功確率は、新規事業一般の成功率が低い（概ね1〜3割）ことを前提に、顧客の支払意思・実績・市場余力・勝てる理由・実行体制の証拠の強さで補正し、楽観しないこと。" +
  "撤退ラインは3〜4個のステージゲート（例:3ヶ月・6ヶ月・12ヶ月・24ヶ月）で構成し、各ゲートは『測れる1つの数値指標』と、継続(go)と撤退(kill)の2つの閾値を持つ。kill〜goの間はピボット/再検証。" +
  "指標は売上・有償顧客数・継続率・粗利率・商談数など顧客行動で測れるものにし、『いいね』や社内評価は使わない。値が大きいほど良い指標は direction=up、小さいほど良い指標（獲得単価等）は direction=down。" +
  "さらに、ゲートに関係なく撤退する上限（累計投資額・期間・投入工数）を決める。levers の gain は成功確率の上昇ポイント（整数）。金額は円・整数。" +
  "出力はJSONのみ。前置き・マークダウン・コードフェンス禁止。" +
  '形式:{"successProbability":成功確率_0-100整数,"probabilityBasis":"この確率の根拠(1-2文)","baseRate":"一般的な新規事業の成功率との比較(1文)",' +
  '"drivers":[{"factor":"確率を下げている要因","impact":"-10"}],' +
  '"levers":[{"action":"成功確率を上げる具体的な打ち手","gain":上昇ポイント_整数,"cost":"必要な工数・費用","when":"いつまでに"}],' +
  '"premortem":[{"scenario":"3年後に失敗していたとしたら、その理由","earlySignal":"早期に現れる警報サイン","prevention":"予防策"}],' +
  '"hardLimits":{"maxInvestment":累計投資上限_円,"deadlineMonths":最終判断までの月数,"maxPeopleMonths":投入工数上限_人月,"note":"この上限の考え方(1文)"},' +
  '"gates":[{"month":経過月,"name":"ゲート名(例:課題検証)","metric":"測る指標","unit":"単位","direction":"up|down","go":継続ライン_数値,"kill":撤退ライン_数値,"why":"この閾値の理由(1文)","pivot":"中間だった場合のピボット案(1文)"}],' +
  '"exitPlan":"撤退する場合の顧客・資産・人の扱い(1-2文)","decisionOwner":"撤退判断を下す人・場の推奨(1文)"}';

// ゲート判定：実績値と閾値から機械判定（up=大きいほど良い / down=小さいほど良い）
function gateVerdict(g, actual) {
  if (actual === "" || actual == null || isNaN(Number(actual))) return null;
  const a = Number(actual), go = Number(g.go), kill = Number(g.kill);
  const down = g.direction === "down";
  if (down ? a <= go : a >= go) return "go";
  if (down ? a >= kill : a <= kill) return "kill";
  return "pivot";
}
const GATE_META = {
  go: { label: "継続", cls: "g-go", note: "次のゲートへ進む" },
  pivot: { label: "ピボット", cls: "g-pivot", note: "1回だけ打ち手を変えて再検証" },
  kill: { label: "撤退", cls: "g-kill", note: "合意どおり畳む" },
};
// 全体判定：上限超過は即撤退 → 到来済みゲートの最新判定 → ピボット連続は撤退
function overallExit(el) {
  const lim = el.limits || {}, st = el.status || {};
  const reasons = [];
  if (Number(lim.maxInvestment) > 0 && Number(st.spent) >= Number(lim.maxInvestment)) reasons.push("累計投資が上限 " + yen(lim.maxInvestment) + " に到達");
  if (Number(lim.maxPeopleMonths) > 0 && Number(st.peopleMonths) >= Number(lim.maxPeopleMonths)) reasons.push("投入工数が上限 " + num(lim.maxPeopleMonths) + "人月に到達");
  const due = (el.gates || []).map((g, i) => ({ g, i, v: gateVerdict(g, (el.actuals || {})[i]) })).filter((x) => x.v);
  const last = due[due.length - 1];
  if (Number(lim.deadlineMonths) > 0 && Number(st.elapsed) >= Number(lim.deadlineMonths) && !(last && last.v === "go" && last.i === el.gates.length - 1))
    reasons.push("期限 " + lim.deadlineMonths + "ヶ月を過ぎても最終ゲートを通過していない");
  if (reasons.length) return { v: "kill", reasons };
  if (!last) return { v: null, reasons: ["まだ実績が入力されていません"] };
  const pivots = due.filter((x) => x.v === "pivot").length;
  if (last.v === "pivot" && pivots >= 2) return { v: "kill", reasons: ["ピボット判定が" + pivots + "回続いた（再検証は1回まで）"] };
  return { v: last.v, reasons: ["ゲート" + (last.i + 1) + "「" + last.g.name + "」：" + last.g.metric + " " + num((el.actuals || {})[last.i]) + (last.g.unit || "")] };
}
function exitProbability(el) {
  const base = Number(el.data.successProbability) || 0;
  const add = (el.data.levers || []).reduce((s, l, i) => s + ((el.checked || {})[i] ? (parseInt(String(l.gain).replace(/[^0-9]/g, "")) || 0) : 0), 0);
  return { base, add, now: Math.min(95, base + add) };
}
function exitStoreKey(name) { return "vs-exitline:" + (name || ""); }
function loadExitLine(name) {
  try { const s = localStorage.getItem(exitStoreKey(name)); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function saveExitLine(el) {
  try { localStorage.setItem(exitStoreKey(el.name), JSON.stringify(el)); } catch (e) {}
}

function pfComposite(b) {
  // 現在の利益ではなく「可能性」を主軸に：到達見込み(2倍) + 成長 + 戦略適合 + 熱量 + 売れる見込み
  const reach = Number(b._reach) || 3;
  const vals = [reach, reach, Number(b.growth) || 3, Number(b.fit) || 3, Number(b.passion) || 3, Number(b.sellability) || 3];
  return Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 10) / 10;
}
const PF_AXES = [
  { key: "reach", label: "1億到達見込み", get: (b) => Number(b._reach) || 3, min: 1, max: 5, unit: "" },
  { key: "realY3", label: "3年後売上見込み", get: (b) => Number(b.realY3) || 0, min: 0, max: null, unit: "" },
  { key: "resource", label: "投入リソース", get: (b) => Number(b.resource) || 0, min: 0, max: null, unit: "" },
  { key: "passion", label: "熱量", get: (b) => b.passion, min: 1, max: 5, unit: "" },
  { key: "growth", label: "成長性", get: (b) => b.growth, min: 1, max: 5, unit: "" },
  { key: "sellability", label: "売れる見込み", get: (b) => Number(b.sellability) || 3, min: 1, max: 5, unit: "" },
  { key: "margin", label: "利益率(現状)", get: (b) => b.margin, min: -20, max: 60, unit: "%" },
  { key: "revenue", label: "現在売上", get: (b) => b.revenue, min: 0, max: null, unit: "" },
];
function bizToCandidate(b) {
  return {
    name: b.name, catch: b.memo || "進行中の事業", problem: "", customer: "",
    solution: b.memo || "", revenueModel: "", estRevenueY3: b.realY3 || b.revenue || 0, estInitialCost: 0,
    grossMarginPct: b.margin, scores: {}, why: b.pathToTarget || b.evidence || "", risk: "",
  };
}

const SAMPLE = {
  problem: "創業50年の部品加工メーカー（架空の例）。本業の市場が縮小し、新たな収益の柱がない。担当は兼任で本業に追われ、新規事業の種は「いいね」で終わり決裁に上がらない。",
  customer: "自社の加工技術を必要とする、まだ取引のない中小メーカーや異業種",
  strength: "50年の精密加工技術、少量多品種の対応力、熟練の現場ノウハウ",
  domain: "製造業 / 部品加工 / BtoB",
  constraint: "新規事業室3名・兼任中心。3年で3億の収益の柱を目指したい。",
  materials: "",
};

/* ========================================================================= */
export default function App() {
  const [step, setStep] = useState("intro"); // intro|input|candidates|verify|pitch
  const [input, setInput] = useState({ problem: "", customer: "", strength: "", domain: "", constraint: "", materials: "" });
  const [theme, setTheme] = useState("asset");
  const [target, setTarget] = useState("100m");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState(null);

  const [candidates, setCandidates] = useState(null);
  const [sortKey, setSortKey] = useState("composite");
  const [selectedIdx, setSelectedIdx] = useState(null);

  const [results, setResults] = useState({}); // stationId -> data
  const [status, setStatus] = useState({});
  const [sim, setSim] = useState(null);        // 売上シミュレーター state
  const [deck, setDeck] = useState(null);
  const [deckLoading, setDeckLoading] = useState(false);
  const [verdict, setVerdict] = useState(null); // GO|continue|hold
  const [verdictMemo, setVerdictMemo] = useState("");

  const [mode, setMode] = useState("new"); // new | portfolio
  const [portfolio, setPortfolio] = useState(emptyRows()); // 進行中事業の入力
  const [pfResult, setPfResult] = useState(null); // {businesses, portfolio}
  const [pfSort, setPfSort] = useState("reach");
  const [pfAxis, setPfAxis] = useState({ x: "resource", y: "reach" });
  const [deepEval, setDeepEval] = useState(null); // { biz, data(AI), score, ev, coverage, addedFacts }
  const [deepLoading, setDeepLoading] = useState(false);
  const [interview, setInterview] = useState(null); // { questions, answers }
  const [interviewLoading, setInterviewLoading] = useState(false);
  const [exitLine, setExitLine] = useState(null); // { name, data(AI), gates, limits, actuals, status, checked, owner, agreedAt }
  const [exitLoading, setExitLoading] = useState(false);
  const [exitBack, setExitBack] = useState("verify");

  const targetAmount = (TARGETS.find((t) => t.id === target) || TARGETS[0]).amount;

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap";
    document.head.appendChild(l);
    return () => { try { document.head.removeChild(l); } catch (e) {} };
  }, []);

  async function generateCandidates() {
    setError(null); setLoading(true); setLoadingMsg("3つの事業案を鍛造しています…");
    try {
      const themeObj = THEMES.find((t) => t.id === theme) || THEMES[0];
      const themeLabel = themeObj.label, question = themeObj.question;
      const targetLabel = (TARGETS.find((t) => t.id === target) || TARGETS[0]).label;
      const user =
        "【お題（問い）】" + question + "\n【テーマ】" + themeLabel + "\n【目標規模】" + targetLabel + "\n\n" +
        "【解決したい課題・気づき】\n" + (input.problem || "（未記入）") + "\n\n" +
        "【ターゲット顧客】\n" + (input.customer || "（未記入）") + "\n\n" +
        "【自社の強み・資産（技術/設備/商品/顧客）】\n" + (input.strength || "（未記入）") + "\n\n" +
        "【業界・ドメイン】\n" + (input.domain || "（指定なし）") + "\n\n" +
        "【制約・前提】\n" + (input.constraint || "（特になし）") + "\n\n" +
        (input.materials ? "【アップロード資料】\n" + input.materials + "\n" : "");
      const j = parseJSON(await callClaude(candSys(themeLabel, targetLabel, question), user));
      const list = (j.candidates || []).slice(0, 3);
      if (!list.length) throw new Error("案を生成できませんでした");
      setCandidates(list); setSelectedIdx(null);
      setResults({}); setStatus({}); setSim(null); setDeck(null); setVerdict(null);
      setStep("candidates");
    } catch (e) { setError("生成に失敗しました：" + e.message + "（もう一度お試しください）"); }
    finally { setLoading(false); }
  }

  function baseContext() {
    const c = candidates[selectedIdx];
    let ctx = "【事業案】\n事業名: " + c.name + " / " + c.catch + "\n課題: " + c.problem +
      "\n顧客: " + c.customer + "\nソリューション: " + c.solution + "\n収益モデル: " + c.revenueModel +
      "\n目標規模: " + (TARGETS.find((t) => t.id === target) || TARGETS[0]).label + "\n";
    const acc = [];
    if (results.market) acc.push("市場SOM: " + yen(results.market.som));
    if (results.custcomp) acc.push("主要顧客: " + (results.custcomp.persona?.name || ""));
    if (results.revstruct) acc.push("収益構造: " + results.revstruct.who + "に" + results.revstruct.what);
    if (acc.length) ctx += "\n【これまでの分析】\n" + acc.join("\n") + "\n";
    return ctx;
  }

  async function generateStation(id) {
    setStatus((s) => ({ ...s, [id]: "loading" })); setError(null);
    try {
      const j = parseJSON(await callClaude(V_SYS[id], baseContext()));
      setResults((r) => ({ ...r, [id]: j }));
      setStatus((s) => ({ ...s, [id]: "done" }));
      if (id === "forecast") seedSim(j);
      return true;
    } catch (e) { setStatus((s) => ({ ...s, [id]: "error" })); return false; }
  }
  function seedSim(f) {
    setSim({
      customersY1: Number(f.customersY1) || 100,
      price: Number(f.price) || 10000,
      freq: Number(f.freqPerYear) || 1,
      g2: Number(f.growthY2Pct) || 50,
      g3: Number(f.growthY3Pct) || 40,
      margin: Number(f.grossMarginPct) || 50,
      fixedCost: Number(f.fixedCostAnnual) || 10000000,
      invest: Number(f.initialInvest) || 10000000,
    });
  }
  async function generateAll() {
    for (const st of STATIONS.filter((s) => s.ai)) {
      if (status[st.id] === "done") continue;
      const ok = await generateStation(st.id);
      if (!ok) setError("ステップの生成に失敗：" + st.label + "（個別に再生成できます）");
    }
  }
  function selectCandidate(idx) {
    setSelectedIdx(idx); setResults({}); setStatus({}); setSim(null); setDeck(null); setVerdict(null);
    setStep("verify"); setError(null);
  }

  async function generateDeck() {
    if (selectedIdx == null) return;
    setDeckLoading(true); setError(null);
    const c = candidates[selectedIdx];
    const simR = sim ? computeSim(sim) : null;
    let ctx = "事業名: " + c.name + " / " + c.catch + "\n課題: " + c.problem + "\n顧客: " + c.customer +
      "\nソリューション: " + c.solution + "\n収益モデル: " + c.revenueModel + "\n";
    if (results.market) ctx += "市場 TAM/SOM: " + yen(results.market.tam) + " / " + yen(results.market.som) + "\n";
    if (results.custcomp?.positioning) ctx += "差別化: " + results.custcomp.positioning.ourPosition + "\n";
    if (simR) ctx += "3年目売上: " + yen(simR.years[2].revenue) + " / 3年目粗利: " + yen(simR.years[2].gross) +
      " / 初期投資: " + yen(sim.invest) + " / 回収: " + (simR.breakEven || "3年内未達") + "\n";
    ctx += "目標: " + (TARGETS.find((t) => t.id === target) || TARGETS[0]).label + "\n";
    if (exitLine && exitLine.name === c.name) {
      ctx += "成功確率: " + exitProbability(exitLine).now + "%\n撤退ライン: " + exitLine.gates.map((g) => g.month + "ヶ月目 " + g.metric + " 継続" + g.go + (g.unit || "") + "/撤退" + g.kill + (g.unit || "")).join("、") +
        "／累計投資上限 " + yen(exitLine.limits.maxInvestment) + "\n（撤退ラインを1枚のスライドに入れること）\n";
    }
    if (results.execkpi?.salesKpis) ctx += "売上KPI: " + results.execkpi.salesKpis.map((k) => k.name + "=" + k.target).join(", ") + "\n";
    try { setDeck(parseJSON(await callClaude(SYS_DECK, ctx))); setStep("pitch"); }
    catch (e) { setError("資料生成に失敗しました：" + e.message); }
    finally { setDeckLoading(false); }
  }

  async function analyzePortfolio() {
    const rows = portfolio.filter((r) => r.name && String(r.name).trim());
    if (!rows.length) { setError("事業を1つ以上入力してください。"); return; }
    setError(null); setLoading(true); setLoadingMsg("進行中の事業を多角的に整理しています…");
    try {
      const targetAmount = 100000000, targetLabel = "1億円"; // 成功ライン(固定)
      const user = "以下は現在並走している事業です。新規事業の成功＝3年で売上1億円以上、を念頭に、市場規模とニーズから多角的に評価し、選択と集中を判断してください。\n\n" +
        rows.map((r, i) => (i + 1) + ". " + r.name + "｜" + (r.memo || "") +
          (r.value ? "｜数字以外の価値:" + r.value : "") +
          (r.vstatus ? "｜検証状況:" + r.vstatus : "") + (r.evidence ? "（補足:" + r.evidence + "）" : "") +
          (r.team ? "｜推進体制:" + r.team : "") +
          "｜形態:" + (r.bizType || "BtoB") + "｜売価:" + (Number(r.price) > 0 ? yen(r.price) : "未定") + "｜原価:" + (Number(r.unitCost) > 0 ? yen(r.unitCost) : "未定") +
          "｜粗利率:" + (Number(r.price) > 0 ? marginPct(r.price, r.unitCost) + "%" : "—") + "｜頻度:" + (r.freq || 1) + "回/年" +
          "｜投入リソース:" + (r.resource || "?") + "人日/月｜熱量:" + r.passion + "/5｜ステージ:" + r.stage).join("\n");
      const j = parseJSON(await callClaude(PF_SYS, user));
      const aiMap = {};
      (j.businesses || []).forEach((b) => { aiMap[b.name] = b; });
      const merged = rows.map((r) => {
        const ai = aiMap[r.name] || {};
        const margin = marginPct(r.price, r.unitCost);
        const preRevenue = (r.stage === "構想" || r.stage === "検証");
        const base3 = Number(ai.base3) || Number(ai.realY3) || 0;
        const b = {
          name: r.name, memo: r.memo, value: r.value || "", vstatus: r.vstatus || "", evidence: r.evidence || "", team: r.team || "",
          bizType: r.bizType || "BtoB", price: Number(r.price) || 0, unitCost: Number(r.unitCost) || 0, freq: Number(r.freq) || 1,
          revenue: 0, cost: 0, profit: 0, margin, preRevenue,
          resource: Number(r.resource) || 0, passion: Number(r.passion) || 3, stage: r.stage,
          marketSize: Number(ai.marketSize) || 3, profitability: Number(ai.profitability) || (margin >= 40 ? 5 : margin >= 30 ? 4 : margin >= 20 ? 3 : margin >= 1 ? 2 : 1),
          barrier: Number(ai.barrier) || 3, uniqueness: Number(ai.uniqueness) || 3,
          som: Number(ai.som) || 0, low3: Number(ai.low3) || 0, base3, high3: Number(ai.high3) || 0, fcBasis: ai.fcBasis || "",
          growth: Number(ai.growth) || 3, fit: Number(ai.fit) || 3, resourceEfficiency: Number(ai.resourceEfficiency) || 3,
          sellability: Number(ai.sellability) || 3, strategicValue: Number(ai.strategicValue) || (r.value ? 4 : 2),
          potential: Number(ai.potential) || 3, realY3: base3, pathToTarget: ai.pathToTarget || "",
          marketReality: ai.marketReality || "", otherValue: ai.otherValue || r.value || "",
          reason: ai.reason || "",
        };
        b._reach = reachScore(b, targetAmount);
        b.targetFit = targetAmount && b.realY3 ? b.realY3 / targetAmount : 0;
        b.hitsTarget = targetAmount ? base3 >= targetAmount : false;
        b.evalPct = evalScore(b);
        b.rank = rankFromScore(b.evalPct);
        b.verdict = RANK_META[b.rank].decision;
        b.composite = pfComposite(b);
        return b;
      });
      setPfResult({ businesses: merged, portfolio: j.portfolio || {}, targetAmount, targetLabel });
      setStep("pfboard");
    } catch (e) { setError("整理に失敗しました：" + e.message + "（もう一度お試しください）"); }
    finally { setLoading(false); }
  }

  function selectPortfolioBiz(b) {
    setCandidates([bizToCandidate(b)]); setSelectedIdx(0);
    setResults({}); setStatus({}); setSim(null); setDeck(null); setVerdict(null);
    setStep("verify"); setError(null);
  }

  async function runDeepEval(b, addedFacts) {
    setDeepEval(null); setDeepLoading(true); setError(null); setStep("deepeval");
    const base =
      "事業名: " + b.name + "\n概要: " + (b.memo || "") +
      "\n提供形態: " + (b.bizType || "BtoB") +
      "\n売価: " + (Number(b.price) > 0 ? yen(b.price) : "未定") + " / 原価: " + (Number(b.unitCost) > 0 ? yen(b.unitCost) : "未定") +
      " / 粗利率: " + (Number(b.price) > 0 ? b.margin + "%" : "—") + " / 購入頻度: " + (b.freq || 1) + "回/年" +
      "\n顧客の検証状況: " + (b.vstatus || "未確認") + (b.evidence ? "（補足: " + b.evidence + "）" : "") +
      "\n数字以外の価値: " + (b.value || "（なし）") +
      "\nステージ: " + (b.stage || "") + " / 投入リソース: " + (b.resource || "?") + "人日/月" + " / 推進者の熱量: " + (b.passion || "?") + "/5" +
      "\n推進体制: " + (b.team || "（未記入）");
    const prevFacts = (deepEval && deepEval.addedFacts) || [];
    const allFacts = prevFacts.concat(addedFacts || []);
    const user = base + (allFacts.length ? "\n\n【壁打ちで追加で判明した事実】\n" + allFacts.map((f) => "・" + f).join("\n") : "");
    try {
      const data = parseJSON(await callClaude(EVAL_SYS, user, 4000));
      const items = data.items || {};
      const score = computeScore(items);
      setDeepEval({ biz: b, data, items, score, ev: evidenceLevel(items), addedFacts: allFacts });
    } catch (e) { setError("詳細評価に失敗しました：" + e.message + "（もう一度お試しください）"); setStep("pfboard"); }
    finally { setDeepLoading(false); }
  }
  function deepEvalToSim() { if (deepEval) selectPortfolioBiz(deepEval.biz); }

  async function startInterview() {
    if (!deepEval) return;
    setInterviewLoading(true); setError(null);
    const b = deepEval.biz, items = deepEval.items || {};
    const weak = ALL_SUBITEMS.filter((it) => { const s = items[it.id] || {}; return s.status === "unverified" || (Number(s.score) || 0) <= 2; })
      .map((it) => it.catLabel + "／" + it.label + "（不足：" + ((items[it.id] || {}).missingEvidence || "情報なし") + "）");
    const user = "事業名: " + b.name + " / " + (b.memo || "") + " / 形態:" + (b.bizType || "BtoB") +
      "\n現在のスコア: " + deepEval.score.total + "点・カバレッジ" + deepEval.score.coverage + "%・Evidence Lv." + deepEval.ev +
      "\n【未検証・弱点の項目】\n" + (weak.length ? weak.join("\n") : "（主要項目は概ね評価済み）") +
      "\nこの中から、1億到達の判断を最も前進させる質問を3〜5問。";
    try {
      const j = parseJSON(await callClaude(INTERVIEW_SYS, user, 1500));
      const qs = (j.questions || []).slice(0, 5);
      if (!qs.length) throw new Error("質問を生成できませんでした");
      setInterview({ questions: qs, answers: {} });
      setStep("interview");
    } catch (e) { setError("壁打ちの準備に失敗しました：" + e.message); }
    finally { setInterviewLoading(false); }
  }
  async function submitInterview() {
    if (!interview) return;
    const facts = interview.questions.map((q) => {
      const a = interview.answers[q.id];
      return a && String(a).trim() ? (q.topic + "：" + a) : null;
    }).filter(Boolean);
    setInterview(null);
    await runDeepEval(deepEval.biz, facts);
  }

  // 撤退ラインの材料：新規案なら検証結果＋シミュレーター、進行中事業なら詳細評価
  function exitContext(from) {
    if (from === "deepeval" && deepEval) {
      const b = deepEval.biz, d = deepEval.data || {};
      return {
        name: b.name,
        text: "事業名: " + b.name + "\n概要: " + (b.memo || "") + "\nステージ: " + (b.stage || "") + " / 形態: " + (b.bizType || "") +
          "\n売価: " + (Number(b.price) > 0 ? yen(b.price) : "未定") + " / 粗利率: " + (Number(b.price) > 0 ? b.margin + "%" : "—") +
          "\n顧客の検証状況: " + (b.vstatus || "未確認") + (b.evidence ? "（" + b.evidence + "）" : "") +
          "\n1億到達可能性スコア: " + deepEval.score.total + "/100（カバレッジ" + deepEval.score.coverage + "%・Evidence Lv." + deepEval.ev + "）" +
          (d.conclusion ? "\n結論: " + d.conclusion : "") + (d.bottleneck ? "\n最大ボトルネック: " + d.bottleneck : "") +
          (d.criticalAssumption ? "\n崩れたら終わる前提: " + d.criticalAssumption : "") +
          (d.equation ? "\n1億の方程式: 単価" + yen(d.equation.unitPrice) + "×頻度" + (d.equation.frequency || 1) + " → 必要顧客数" + num(d.equation.neededCustomers) : "") +
          (deepEval.addedFacts && deepEval.addedFacts.length ? "\n追加で判明した事実: " + deepEval.addedFacts.join(" / ") : "") +
          "\n目標: 3年で年商1億円",
      };
    }
    const c = candidates[selectedIdx];
    let text = baseContext();
    if (results.market) text += "市場 TAM/SAM/SOM: " + yen(results.market.tam) + " / " + yen(results.market.sam) + " / " + yen(results.market.som) + "\n";
    if (results.custcomp && results.custcomp.insight) text += "顧客インサイト: " + results.custcomp.insight + "\n";
    if (c.risk) text += "想定される最大リスク: " + c.risk + "\n";
    if (sim) {
      const r = computeSim(sim);
      text += "事業計画: 1年目顧客" + num(sim.customersY1) + "・単価" + yen(sim.price) + "・頻度" + sim.freq + "回/年・粗利率" + sim.margin + "%・年間固定費" + yen(sim.fixedCost) +
        "・初期投資" + yen(sim.invest) + "\n売上推移: " + r.years.map((y) => y.label + " " + yen(y.revenue)).join(" / ") + "・回収: " + (r.breakEven || "3年内未達") + "\n";
    }
    return { name: c.name, text };
  }
  async function openExitLine(from, regenerate) {
    const ctx = exitContext(from);
    setExitBack(from); setError(null);
    const saved = !regenerate && loadExitLine(ctx.name);
    if (saved) { setExitLine(saved); setStep("exitline"); return; }
    setExitLine(null); setExitLoading(true); setStep("exitline");
    try {
      const j = parseJSON(await callClaude(EXIT_SYS, ctx.text, 3500));
      const gates = (j.gates || []).slice(0, 4).map((g) => ({ ...g, direction: g.direction === "down" ? "down" : "up" }));
      if (!gates.length) throw new Error("撤退ラインを生成できませんでした");
      const el = {
        name: ctx.name, data: j, gates, limits: { ...(j.hardLimits || {}) },
        actuals: {}, status: { spent: "", elapsed: "", peopleMonths: "" }, checked: {}, owner: "", agreedAt: "",
        createdAt: new Date().toISOString().slice(0, 10),
      };
      setExitLine(el); saveExitLine(el);
    } catch (e) { setError("撤退ラインの設計に失敗しました：" + e.message + "（もう一度お試しください）"); setStep(from); }
    finally { setExitLoading(false); }
  }
  function updateExitLine(next) { setExitLine(next); saveExitLine(next); }

  function restart() {
    setExitLine(null);
    setStep("intro"); setCandidates(null); setSelectedIdx(null);
    setResults({}); setStatus({}); setSim(null); setDeck(null); setVerdict(null); setVerdictMemo(""); setError(null);
    setPfResult(null); setPortfolio(emptyRows()); setDeepEval(null); setInterview(null);
  }

  const ranked = useMemo(() => {
    if (!candidates) return [];
    const meta = candidates.map((c, i) => ({ c, i, comp: composite(c) }));
    const sorted = [...meta].sort((a, b) => {
      if (sortKey === "revenue") return (b.c.estRevenueY3 || 0) - (a.c.estRevenueY3 || 0);
      if (sortKey === "cost") return (a.c.estInitialCost || 0) - (b.c.estInitialCost || 0);
      return b.comp - a.comp;
    });
    return sorted.map((x, r) => ({ ...x, rank: r + 1 }));
  }, [candidates, sortKey]);

  const selected = selectedIdx != null && candidates ? candidates[selectedIdx] : null;
  const doneCount = STATIONS.filter((s) => s.ai && status[s.id] === "done").length + (sim ? 0 : 0);

  return (
    <div className="bp-root">
      <style>{CSS}</style>
      <Header step={step} onHome={restart} />
      {step !== "intro" && <StepBar step={step} mode={mode} status={status} sim={sim} />}

      {error && (
        <div className="bp-error" role="alert">{error}<button className="bp-errclose" onClick={() => setError(null)}>×</button></div>
      )}

      <main className="bp-main">
        {step === "intro" && <Intro onPick={(m) => { setMode(m); setStep(m === "portfolio" ? "pfinput" : "input"); }} />}
        {step === "input" && (
          <InputScreen value={input} onChange={setInput} theme={theme} setTheme={setTheme} target={target} setTarget={setTarget}
            onSubmit={generateCandidates} loading={loading} />
        )}
        {step === "candidates" && candidates && (
          <Candidates ranked={ranked} sortKey={sortKey} setSortKey={setSortKey} targetAmount={targetAmount}
            onSelect={selectCandidate} onBack={() => setStep("input")} />
        )}
        {step === "pfinput" && (
          <PortfolioInput rows={portfolio} setRows={setPortfolio} target={target} setTarget={setTarget} onSubmit={analyzePortfolio} loading={loading} onBack={() => setStep("intro")} />
        )}
        {step === "pfboard" && pfResult && (
          <PortfolioBoard result={pfResult} sortKey={pfSort} setSortKey={setPfSort} axis={pfAxis} setAxis={setPfAxis}
            onSelect={runDeepEval} onSim={selectPortfolioBiz} onBack={() => setStep("pfinput")} />
        )}
        {step === "deepeval" && (
          <DeepEval de={deepEval} loading={deepLoading} onBack={() => setStep("pfboard")} onSim={deepEvalToSim}
            onInterview={startInterview} interviewLoading={interviewLoading} onExit={() => openExitLine("deepeval")} />
        )}
        {step === "interview" && interview && (
          <Interview biz={deepEval && deepEval.biz} iv={interview} setIv={setInterview}
            onSubmit={submitInterview} onBack={() => setStep("deepeval")} />
        )}
        {step === "verify" && selected && (
          <Verify c={selected} results={results} status={status} sim={sim} setSim={setSim}
            targetAmount={targetAmount} onGenerate={generateStation} onGenerateAll={generateAll}
            onReseed={() => results.forecast && seedSim(results.forecast)}
            onBack={() => setStep(mode === "portfolio" ? "pfboard" : "candidates")} onDeck={generateDeck} deckLoading={deckLoading}
            onExit={() => openExitLine("verify")} />
        )}
        {step === "exitline" && (
          <ExitLine el={exitLine} loading={exitLoading} onChange={updateExitLine}
            onRegenerate={() => openExitLine(exitBack, true)} onBack={() => setStep(exitBack)}
            onDeck={exitBack === "verify" ? generateDeck : null} deckLoading={deckLoading} />
        )}
        {step === "pitch" && deck && selected && (
          <Pitch deck={deck} c={selected} results={results} sim={sim} targetAmount={targetAmount}
            exitLine={exitLine && exitLine.name === selected.name ? exitLine : null}
            verdict={verdict} setVerdict={setVerdict} memo={verdictMemo} setMemo={setVerdictMemo}
            onBack={() => setStep("verify")} onRestart={restart} />
        )}
      </main>

      {loading && (step === "input" || step === "pfinput") && <Overlay msg={loadingMsg} />}
    </div>
  );
}

/* ========================= sim compute ========================= */
function computeSim(s) {
  const years = [1, 2, 3].map((y) => {
    const mult = y === 1 ? 1 : y === 2 ? (1 + s.g2 / 100) : (1 + s.g2 / 100) * (1 + s.g3 / 100);
    const customers = Math.round(s.customersY1 * mult);
    const revenue = Math.round(customers * s.price * s.freq);
    const gross = Math.round(revenue * s.margin / 100);
    const op = gross - s.fixedCost - (y === 1 ? s.invest : 0);
    return { label: y + "年目", customers, revenue, gross, op };
  });
  let cum = 0, be = null;
  years.forEach((yr) => { cum += yr.op; if (be == null && cum >= 0) be = yr.label; });
  return { years, cumulative: cum, breakEven: be };
}

/* ========================= Header ========================= */
function Header({ step, onHome }) {
  return (
    <header className="bp-top">
      <Cross className="c1" /><Cross className="c2" />
      <div className="bp-brand" onClick={onHome}>
        <span className="bp-wm">VALIDATION<em>STUDIO</em></span>
        <span className="bp-wmsub">事業を、感覚ではなく設計する。 IDEA → TEST → EVIDENCE → SCALE</span>
      </div>
      <div className="bp-topright">
        {step !== "intro" && <button className="bp-home" onClick={onHome} title="最初のページに戻る"><span className="bp-homeicon">⌂</span>トップへ戻る</button>}
        <span className="bp-spec">VALIDATION</span>
      </div>
    </header>
  );
}
function Cross({ className }) { return <span className={"bp-cross " + className}>✛</span>; }

/* ========================= StepBar（全工程を一本で横並び） ========================= */
function StepBar({ step, mode, status, sim }) {
  const pre = mode === "portfolio"
    ? [["pfinput", "事業を入力"], ["pfboard", "整理・比較"]]
    : [["input", "お題を決める"], ["candidates", "3案を比較"]];
  const verifySub = [
    { key: "market", label: "市場調査", done: () => status.market === "done" },
    { key: "custcomp", label: "顧客・競合", done: () => status.custcomp === "done" },
    { key: "revstruct", label: "収益構造", done: () => status.revstruct === "done" },
    { key: "forecast", label: "売上・収支", done: () => !!sim || status.forecast === "done" },
  ];
  const rankOf = (s) => (s === pre[0][0] ? 0 : s === pre[1][0] ? 1 : s === "verify" ? 2 : s === "pitch" ? 3 : -1);
  const cur = rankOf(step);
  if (cur < 0) return null;

  const items = [];
  pre.forEach(([k, label], i) => items.push({ label, state: cur > i ? "done" : cur === i ? "on" : "todo" }));
  verifySub.forEach((v) => {
    let state = "todo";
    if (cur > 2) state = "done";
    else if (cur === 2) state = v.done() ? "done" : "on";
    items.push({ label: v.label, state });
  });
  items.push({ label: "ピッチ", state: cur === 3 ? "on" : "todo" });

  const N = items.length;
  const firstV = pre.length, lastV = pre.length + verifySub.length - 1;
  const curLabel = cur < 2 ? String(cur + 1) : cur === 2 ? (firstV + 1) + "–" + (lastV + 1) : String(N);

  return (
    <div className="bp-progress">
      <div className="bp-progwrap">
        <span className="bp-progcount">STEP <b>{curLabel}</b><i>/ {N}</i></span>
        <ol className="bp-progsteps">
          {items.map((it, i) => (
            <li key={i} className={"bp-progstep " + it.state}>
              <span className="bp-progdot">{it.state === "done" ? "✓" : i + 1}</span>
              <span className="bp-proglabel">{it.label}</span>
              {i < N - 1 && <span className="bp-progline" />}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* ========================= Intro ========================= */
function Intro({ onPick }) {
  return (
    <section className="bp-intro">
      <div className="bp-ruler"><span>0</span><span>100</span><span>200</span><span>300</span><span>400</span><span>500</span></div>
      <div className="bp-hero">
        <span className="bp-tag">BUSINESS VALIDATION STUDIO</span>
        <h1 className="bp-h1">事業の可能性を、<br /><em>「感覚」から「検証」へ。</em></h1>
        <div className="bp-uline" />
        <p className="bp-lead">
          3年後、<strong>1億円に届く事業なのか。</strong>
          現在走っている事業も、新しいアイデアも、<strong>同じ基準で検証</strong>します。
          製品を試作するように、事業も試作する。まずはやることを選んでください。
        </p>
      </div>

      <div className="bp-modes">
        <button className="bp-modecard alt" onClick={() => onPick("portfolio")}>
          <span className="bp-corner" />
          <span className="bp-modetag">EXISTING BUSINESS</span>
          <h3>進行中の事業を検証する</h3>
          <p>並走中の事業を入力すると、推進体制（人）まで含む6項目100点で採点し、A〜Eランク・Evidence Level・1億円への設計図・最大ボトルネック・次の実証まで。撤退か継続かを、数字と証拠で判断し、始める前に撤退ラインを合意します。</p>
          <span className="bp-modego">事業を検証する →</span>
        </button>
        <button className="bp-modecard" onClick={() => onPick("new")}>
          <span className="bp-corner" />
          <span className="bp-modetag">NEW BUSINESS IDEA</span>
          <h3>新しいアイデアを検証する</h3>
          <p>課題やお題を入れると、AIが方向性の異なる事業案を3つ生成。市場・収益・売上予測を検証し、成功確率と撤退ラインを決めて、経営層に出せる3分ピッチへ。</p>
          <span className="bp-modego">アイデアを検証する →</span>
        </button>
      </div>

      <p className="bp-note">事業を、感覚ではなく設計する。 IDEA → TEST → EVIDENCE → SCALE</p>
    </section>
  );
}

/* ========================= Input ========================= */
function InputScreen({ value, onChange, theme, setTheme, target, setTarget, onSubmit, loading }) {
  const fileRef = useRef(); const [fileName, setFileName] = useState("");
  function set(k, v) { onChange({ ...value, [k]: v }); }
  function handleFile(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array" });
        let out = [];
        wb.SheetNames.forEach((name) => {
          XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }).forEach((r) => {
            const cells = (r || []).filter((c) => c !== null && c !== undefined && String(c).trim() !== "");
            if (cells.length) out.push(cells.join(" : "));
          });
        });
        set("materials", out.join("\n").slice(0, 4000));
      } catch (err) { setFileName(f.name + "（読み込み失敗）"); }
    };
    reader.readAsArrayBuffer(f);
  }
  const canSubmit = (value.problem || value.materials || value.customer) && !loading;
  return (
    <section className="bp-screen">
      <SectionLabel tag="STEP 01" title="お題を決めて、種を入れる" sub="考える“問い”を選び、思いつく範囲で入力します。成功ライン＝3年で1億円。空欄はAIが補完。Excel/CSVでも可。" />

      <div className="bp-choice full">
        <span className="bp-choicehd">お題を選ぶ（＝考える"問い"）</span>
        <div className="bp-themes">
          {THEMES.map((t) => (
            <button key={t.id} className={"bp-theme" + (theme === t.id ? " on" : "")} onClick={() => setTheme(t.id)}>
              {t.best && <span className="bp-bestbadge">本命・おすすめ</span>}
              <strong>{t.label}</strong>
              <em>{t.note}</em>
            </button>
          ))}
        </div>
        <div className="bp-themeq"><span className="bp-qmark">Q</span><p>{(THEMES.find((t) => t.id === theme) || THEMES[0]).question}</p></div>
      </div>

      <div className="bp-inputgrid">
        <Field label="解決したい課題・気づき" hint="誰の、どんな困りごと？" big value={value.problem}
          onChange={(v) => set("problem", v)} ph="例）本業の市場が縮小し、新たな収益の柱がない…" />
        <Field label="ターゲット顧客" value={value.customer} onChange={(v) => set("customer", v)} ph="例）まだ取引のない中小メーカー" />
        <Field label="自社の強み・資産" hint="技術/設備/商品/顧客基盤" value={value.strength} onChange={(v) => set("strength", v)} ph="例）精密加工・試作対応・既存顧客300社" />
        <Field label="業界・ドメイン（任意）" value={value.domain} onChange={(v) => set("domain", v)} ph="例）製造業 / 部品加工" />
        <Field label="制約・前提（任意）" value={value.constraint} onChange={(v) => set("constraint", v)} ph="例）新規事業室3名・兼任中心" />
        <div className="bp-uploadrow">
          <div className="bp-upload" onClick={() => fileRef.current && fileRef.current.click()}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} hidden />
            <span className="bp-upicon">⇪</span>
            <div><strong>Excel / CSV をアップロード</strong><p>{fileName || "種の材料シートを読み込みます（任意）"}</p></div>
          </div>
          <button className="bp-ghost" onClick={() => onChange({ ...SAMPLE })}>サンプル（架空の製造業）</button>
        </div>
      </div>
      <div className="bp-actionbar">
        <button className="bp-cta" disabled={!canSubmit} onClick={onSubmit}>{loading ? "生成中…" : "3案を生成する →"}</button>
      </div>
    </section>
  );
}
function Field({ label, hint, value, onChange, ph, big }) {
  return (
    <label className={"bp-field" + (big ? " big" : "")}>
      <span className="bp-flabel">{label} {hint && <em>{hint}</em>}</span>
      <textarea rows={big ? 3 : 2} value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/* ========================= Candidates ========================= */
function Candidates({ ranked, sortKey, setSortKey, targetAmount, onSelect, onBack }) {
  const sorts = [["composite", "総合スコア"], ["revenue", "想定売上"], ["cost", "初期投資の低さ"]];
  return (
    <section className="bp-screen">
      <SectionLabel tag="STEP 02" title="3つの事業案を比較して選ぶ" sub={"評価軸を切り替えて順位が変わります。目標 " + yen(targetAmount) + " への到達度も併せて議論を。"} />
      <div className="bp-sortbar">
        <span className="bp-sortlabel">並べ替え</span>
        {sorts.map(([k, label]) => (
          <button key={k} className={"bp-sortbtn" + (sortKey === k ? " on" : "")} onClick={() => setSortKey(k)}>{label}</button>
        ))}
      </div>
      <div className="bp-candgrid">
        {ranked.map(({ c, i, rank, comp }) => {
          const fit = targetAmount ? Math.min((c.estRevenueY3 || 0) / targetAmount, 1.5) : 0;
          return (
            <article key={i} className={"bp-cand rank-" + rank}><span className="bp-corner" />
              <header className="bp-candhead">
                <span className="bp-rankbadge">{rank}<small>位</small></span>
                <div className="bp-candtitle"><h3>{c.name}</h3><p>{c.catch}</p></div>
              </header>
              <div className="bp-figs">
                <div className="bp-fig"><span className="bp-figlabel">3年目 想定年商</span><span className="bp-figval rev">{yen(c.estRevenueY3)}</span></div>
                <div className="bp-fig"><span className="bp-figlabel">初期投資</span><span className="bp-figval cost">{yen(c.estInitialCost)}</span></div>
                <div className="bp-fig"><span className="bp-figlabel">粗利率</span><span className="bp-figval">{c.grossMarginPct != null ? c.grossMarginPct + "%" : "—"}</span></div>
              </div>
              <div className="bp-fit">
                <div className="bp-fithd"><span>目標達成度</span><strong>{Math.round((fit) * 100)}%</strong></div>
                <div className="bp-fittrack"><div className={"bp-fitfill" + (fit >= 1 ? " ok" : "")} style={{ width: Math.min(fit / 1.5 * 100, 100) + "%" }} /></div>
              </div>
              <div className="bp-scores">
                {SCORE_AXES.map((a) => {
                  const v = Number((c.scores || {})[a.key]) || 0;
                  return (<div className="bp-scorerow" key={a.key}>
                    <span className="bp-scorename">{a.label}</span>
                    <span className="bp-scoretrack"><span className="bp-scorefill" style={{ width: (v / 5) * 100 + "%" }} /></span>
                    <span className="bp-scorenum">{v}</span></div>);
                })}
                <div className="bp-scorerow comp"><span className="bp-scorename">総合</span><span className="bp-compval">{comp}<small>/5</small></span></div>
              </div>
              <dl className="bp-canddetail">
                <div><dt>課題</dt><dd>{c.problem}</dd></div>
                <div><dt>顧客</dt><dd>{c.customer}</dd></div>
                <div><dt>提供価値</dt><dd>{c.solution}</dd></div>
                <div><dt>収益</dt><dd>{c.revenueModel}</dd></div>
                <div className="pro"><dt>推し</dt><dd>{c.why}</dd></div>
                <div className="risk"><dt>リスク</dt><dd>{c.risk}</dd></div>
              </dl>
              <button className="bp-selectbtn" onClick={() => onSelect(i)}>この案を検証する →</button>
            </article>
          );
        })}
      </div>
      <div className="bp-actionbar left"><button className="bp-ghost" onClick={onBack}>← お題を編集</button></div>
    </section>
  );
}

/* ========================= Verify (事業性検証 6 steps) ========================= */
const STATIONS = [
  { id: "market", n: 1, label: "市場調査", sub: "TAM・SAM・SOM整理", ai: true },
  { id: "custcomp", n: 2, label: "顧客・競合分析", sub: "検索・口コミ・競合分析", ai: true },
  { id: "revstruct", n: 3, label: "収益構造整理", sub: "誰に・何を・いくらで", ai: true },
  { id: "forecast", n: 4, label: "売上予測", sub: "顧客数×単価×頻度", ai: true },
  { id: "sim", n: 5, label: "事業計画", sub: "売上・粗利・投資額", ai: false },
  { id: "pitch", n: 6, label: "経営層へ提案", sub: "数字と根拠で提案", ai: false },
];

function Verify({ c, results, status, sim, setSim, targetAmount, onGenerate, onGenerateAll, onReseed, onBack, onDeck, deckLoading, onExit }) {
  const [open, setOpen] = useState({ market: true });
  const refs = useRef({});
  function toggle(id) { setOpen((o) => ({ ...o, [id]: !o[id] })); }
  function jump(id) { setOpen((o) => ({ ...o, [id]: true })); setTimeout(() => refs.current[id] && refs.current[id].scrollIntoView({ behavior: "smooth", block: "start" }), 60); }
  const anyLoading = Object.values(status).some((s) => s === "loading");
  const sections = STATIONS.filter((s) => s.id !== "pitch");

  return (
    <section className="bp-screen">
      <div className="bp-selbanner"><Cross className="c1" /><Cross className="c2" />
        <span className="bp-selpill">選定案</span>
        <div><h2>{c.name}</h2><p>{c.catch}</p></div>
      </div>

      <div className="bp-map">
        <div className="bp-maphead">
          <div><SectionLabel tag="STEP 03" title="事業性検証" sub="AIで調査・検証してから、経営層へ。売上・粗利・投資額まで数字で。" inline /></div>
          <button className="bp-cta small" onClick={onGenerateAll} disabled={anyLoading}>{anyLoading ? "検証中…" : "①〜④をまとめて検証"}</button>
        </div>
        <div className="bp-stations">
          {STATIONS.map((st, i) => (
            <React.Fragment key={st.id}>
              <button className={"bp-station st-" + (st.id === "sim" ? (sim ? "done" : "idle") : st.id === "pitch" ? "idle" : (status[st.id] || "idle"))}
                onClick={() => st.id === "pitch" ? onDeck() : jump(st.id)}>
                <span className="bp-stnum">{st.n}</span>
                <span className="bp-sttext"><strong>{st.label}</strong><em>{st.sub}</em></span>
                <span className="bp-ststat">
                  {st.id === "sim" ? (sim ? "✓" : "") : st.id === "pitch" ? "→" : status[st.id] === "done" ? "✓" : status[st.id] === "loading" ? "…" : status[st.id] === "error" ? "!" : ""}
                </span>
              </button>
              {i < STATIONS.length - 1 && <span className="bp-stchev">›</span>}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="bp-sections">
        {sections.map((st) => {
          const isOpen = !!open[st.id];
          const stStatus = st.id === "sim" ? (sim ? "done" : "idle") : (status[st.id] || "idle");
          return (
            <div className="bp-section" key={st.id} ref={(el) => (refs.current[st.id] = el)}>
              <button className="bp-sechead" onClick={() => toggle(st.id)}>
                <span className="bp-secn">{String(st.n).padStart(2, "0")}</span>
                <span className="bp-sectitle"><strong>{st.label}</strong><em>{st.sub}</em></span>
                <span className={"bp-secstatus " + stStatus}>{stStatus === "done" ? "検証済み" : stStatus === "loading" ? "検証中…" : stStatus === "error" ? "失敗" : "未着手"}</span>
                <span className={"bp-chevron" + (isOpen ? " up" : "")}>⌄</span>
              </button>
              {isOpen && (
                <div className="bp-secbody">
                  {st.id === "sim" ? (
                    sim ? <Simulator sim={sim} setSim={setSim} targetAmount={targetAmount} onReseed={results.forecast ? onReseed : null} />
                      : <div className="bp-secempty"><p>先に「④売上予測」を検証すると、AIが初期パラメータ(顧客数×単価×頻度)を用意します。</p></div>
                  ) : (
                    <>
                      {stStatus === "loading" && <Skeleton msg={st.label + "を検証中…"} />}
                      {stStatus === "error" && <div className="bp-secerror"><p>この検証に失敗しました。</p><button className="bp-ghost" onClick={() => onGenerate(st.id)}>再検証</button></div>}
                      {stStatus === "done" && results[st.id] && (<><StationView id={st.id} d={results[st.id]} /><div className="bp-secfoot"><button className="bp-textbtn" onClick={() => onGenerate(st.id)}>↻ 再検証</button></div></>)}
                      {stStatus === "idle" && (<div className="bp-secempty"><p>{st.sub} をAIが検証します。</p><button className="bp-cta small" onClick={() => onGenerate(st.id)}>この項目を検証 →</button></div>)}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="bp-keyline">"数字で語れる事業案" として提案する。</div>

      <div className="bp-actionbar split">
        <button className="bp-ghost" onClick={onBack}>← 3案の比較へ</button>
        <div className="bp-actionright">
          <button className="bp-ghost" onClick={onExit}>撤退ライン・成功確率を決める</button>
          <button className="bp-cta" onClick={onDeck} disabled={deckLoading}>{deckLoading ? "作成中…" : "3分ピッチ資料をつくる →"}</button>
        </div>
      </div>
    </section>
  );
}

/* ---- station router ---- */
function StationView({ id, d }) {
  switch (id) {
    case "market": return <MarketView d={d} />;
    case "custcomp": return <CustCompView d={d} />;
    case "revstruct": return <RevStructView d={d} />;
    case "forecast": return <ForecastView d={d} />;
    default: return null;
  }
}

/* ---- ① Market ---- */
function MarketView({ d }) {
  const tam = Number(d.tam) || 0;
  const rows = [{ k: "TAM", v: Number(d.tam) || 0, note: d.tamNote, cls: "tam" }, { k: "SAM", v: Number(d.sam) || 0, note: d.samNote, cls: "sam" }, { k: "SOM", v: Number(d.som) || 0, note: d.somNote, cls: "som" }];
  return (
    <div className="bp-cv">
      <div className="bp-marketbars">
        {rows.map((r) => (
          <div className="bp-mbrow" key={r.k}>
            <div className="bp-mbhead"><span className={"bp-mbtag " + r.cls}>{r.k}</span><span className="bp-mbval">{yen(r.v)}</span></div>
            <div className="bp-mbtrack"><div className={"bp-mbfill " + r.cls} style={{ width: (tam ? (r.v / tam) * 100 : 0) + "%" }} /></div>
            <p className="bp-mbnote">{r.note}</p>
          </div>
        ))}
      </div>
      {d.growth && <Callout label="市場の成長性">{d.growth}</Callout>}
      {d.assumptions && <InfoList head="算出の前提" items={d.assumptions} />}
    </div>
  );
}

/* ---- ② Customer / Competitor ---- */
function CustCompView({ d }) {
  const p = d.persona || {}, pos = d.positioning || {};
  return (
    <div className="bp-cv">
      <div className="bp-persona"><span className="bp-avatar">{(p.name || "?").slice(0, 1)}</span>
        <div><strong>{p.name}</strong><p>{p.profile}</p>{p.context && <p className="bp-ctx">{p.context}</p>}</div></div>
      {d.jobs && (<Panel title="片付けたい用事（JTBD）"><div className="bp-jobs">
        {d.jobs.map((j, i) => (<div className="bp-job" key={i}><p className="bp-jobmain">{j.job}</p>
          <div className="bp-jobmeta"><span className="pain">痛み: {j.pain}</span><span className="gain">成果: {j.gain}</span></div></div>))}
      </div></Panel>)}
      {d.competitors && (<Panel title="競合・代替との比較"><table className="bp-table">
        <thead><tr><th>相手</th><th>強み</th><th>弱み</th><th>我々の優位</th></tr></thead>
        <tbody>{d.competitors.map((x, i) => (<tr key={i}><td className="nm">{x.name}</td><td>{x.strength}</td><td>{x.weakness}</td><td className="edge">{x.ourEdge}</td></tr>))}</tbody>
      </table></Panel>)}
      {(pos.axisX || pos.ourPosition) && (<Panel title="ポジショニング"><div className="bp-posmap">
        <div className="bp-posaxes"><span className="bp-posx">{pos.axisX}</span><span className="bp-posy">{pos.axisY}</span><span className="bp-posdot" /></div>
        <p className="bp-posnote">{pos.ourPosition}</p></div></Panel>)}
      {d.insight && <Callout label="顧客インサイト" accent>{d.insight}</Callout>}
    </div>
  );
}

/* ---- ③ Revenue structure ---- */
function RevStructView({ d }) {
  return (
    <div className="bp-cv">
      <div className="bp-who3">
        <div className="bp-whocell"><span>誰に</span><strong>{d.who}</strong></div>
        <div className="bp-whocell"><span>何を</span><strong>{d.what}</strong></div>
        <div className="bp-whocell"><span>いくらで</span><strong>{d.pricing}</strong></div>
      </div>
      <div className="bp-cv2">
        <Panel title="収益源"><div className="bp-pairs">{(d.revenueStreams || []).map((s, i) => <div className="bp-pair rev" key={i}><strong>{s.name}</strong><span>{s.detail}</span></div>)}</div></Panel>
        <Panel title="主要コスト"><div className="bp-pairs">{(d.costStructure || []).map((s, i) => <div className="bp-pair cost" key={i}><strong>{s.name}</strong><span>{s.detail}</span></div>)}</div></Panel>
      </div>
      {d.grossMarginNote && <Callout label="粗利率の見立て" accent>{d.grossMarginNote}</Callout>}
    </div>
  );
}

/* ---- ④ Forecast seed ---- */
function ForecastView({ d }) {
  return (
    <div className="bp-cv">
      <div className="bp-formula">
        <span className="bp-fx">売上</span><span className="bp-op">=</span>
        <span className="bp-fx v"><em>顧客数</em>{num(d.customersY1)}</span><span className="bp-op">×</span>
        <span className="bp-fx v"><em>単価</em>{yen(d.price)}</span><span className="bp-op">×</span>
        <span className="bp-fx v"><em>頻度</em>{num(d.freqPerYear)}回/年</span>
      </div>
      {d.rationale && <Callout label="この初期値の根拠">{d.rationale}</Callout>}
      {d.notes && <InfoList head="前提メモ" items={d.notes} />}
      <p className="bp-hint">→ 下の「⑤事業計画」でこの数値を自由に動かし、3年収支を組み立てられます。</p>
    </div>
  );
}

/* ---- ⑤ Simulator ---- */
function Simulator({ sim, setSim, targetAmount, onReseed }) {
  const r = computeSim(sim);
  const y3 = r.years[2];
  const fit = targetAmount ? y3.revenue / targetAmount : 0;
  const data = r.years.map((y) => ({ label: y.label, 売上: y.revenue, 粗利: y.gross, 利益: y.op }));
  function upd(k, v) { setSim({ ...sim, [k]: v }); }
  return (
    <div className="bp-sim">
      <div className="bp-simgrid">
        <div className="bp-controls">
          <SimControl label="1年目 顧客数" unit="件/人" value={sim.customersY1} set={(v) => upd("customersY1", v)} min={0} max={Math.max(sim.customersY1 * 4, 100)} step={Math.max(Math.round(sim.customersY1 / 20) || 1, 1)} />
          <SimControl label="単価" unit="円" value={sim.price} set={(v) => upd("price", v)} min={0} max={Math.max(sim.price * 4, 10000)} step={Math.max(Math.round(sim.price / 20) || 1, 100)} money />
          <SimControl label="購入頻度" unit="回/年" value={sim.freq} set={(v) => upd("freq", v)} min={1} max={52} step={1} />
          <SimControl label="2年目 成長率" unit="%" value={sim.g2} set={(v) => upd("g2", v)} min={0} max={300} step={5} />
          <SimControl label="3年目 成長率" unit="%" value={sim.g3} set={(v) => upd("g3", v)} min={0} max={300} step={5} />
          <SimControl label="粗利率" unit="%" value={sim.margin} set={(v) => upd("margin", v)} min={0} max={95} step={1} />
          <SimControl label="年間固定費" unit="円" value={sim.fixedCost} set={(v) => upd("fixedCost", v)} min={0} max={Math.max(sim.fixedCost * 4, 10000000)} step={Math.max(Math.round(sim.fixedCost / 20) || 1, 100000)} money />
          <SimControl label="初期投資" unit="円" value={sim.invest} set={(v) => upd("invest", v)} min={0} max={Math.max(sim.invest * 4, 10000000)} step={Math.max(Math.round(sim.invest / 20) || 1, 100000)} money />
          {onReseed && <button className="bp-textbtn" onClick={onReseed}>↺ AIの初期値に戻す</button>}
        </div>

        <div className="bp-simout">
          <div className="bp-gauge">
            <div className="bp-gaugehd"><span>3年目売上 / 目標 {yen(targetAmount)}</span><strong className={fit >= 1 ? "ok" : ""}>{Math.round(fit * 100)}%</strong></div>
            <div className="bp-gaugetrack"><div className={"bp-gaugefill" + (fit >= 1 ? " ok" : "")} style={{ width: Math.min(fit * 100, 100) + "%" }} /></div>
            <p className="bp-gaugeval">{yen(y3.revenue)}</p>
          </div>
          <div className="bp-simkpis">
            <div className="bp-simkpi"><span>3年累積利益</span><strong className={r.cumulative < 0 ? "neg" : "pos"}>{yen(r.cumulative)}</strong></div>
            <div className="bp-simkpi"><span>投資回収</span><strong>{r.breakEven || "3年内未達"}</strong></div>
            <div className="bp-simkpi"><span>3年目 粗利</span><strong className="pos">{yen(y3.gross)}</strong></div>
          </div>
        </div>
      </div>

      <div className="bp-chart">
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="#D4DAE3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "#5C6B82", fontSize: 12 }} axisLine={{ stroke: "#D4DAE3" }} tickLine={false} />
            <YAxis tickFormatter={(v) => (v >= 1e8 ? (v / 1e8) + "億" : Math.round(v / 1e4) + "万")} tick={{ fill: "#5C6B82", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip formatter={(v) => yen(v)} contentStyle={{ borderRadius: 6, border: "1px solid #D4DAE3", fontSize: 13 }} />
            <ReferenceLine y={targetAmount} stroke="#1668B3" strokeDasharray="4 4" label={{ value: "目標", fill: "#1668B3", fontSize: 11, position: "right" }} />
            <ReferenceLine y={0} stroke="#B9BEC9" />
            <Bar dataKey="売上" fill="#16233F" radius={[3, 3, 0, 0]} barSize={24} />
            <Bar dataKey="粗利" fill="#5C7CB5" radius={[3, 3, 0, 0]} barSize={24} />
            <Line dataKey="利益" stroke="#1668B3" strokeWidth={2.5} dot={{ r: 4, fill: "#1668B3" }} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="bp-legend"><span><i style={{ background: "#1C2B3A" }} />売上</span><span><i style={{ background: "#5C87BC" }} />粗利</span><span><i style={{ background: "#1668B3" }} />営業利益</span></div>
      </div>

      <table className="bp-revtable">
        <thead><tr><th>年次</th><th>顧客数</th><th>売上</th><th>粗利</th><th>営業利益</th></tr></thead>
        <tbody>{r.years.map((y, i) => (<tr key={i}>
          <td className="yr">{y.label}</td><td>{num(y.customers)}</td><td className="rev">{yen(y.revenue)}</td>
          <td className="gross">{yen(y.gross)}</td><td className={"prof" + (y.op < 0 ? " neg" : "")}>{yen(y.op)}</td></tr>))}</tbody>
      </table>
    </div>
  );
}
function SimControl({ label, unit, value, set, min, max, step, money }) {
  return (
    <div className="bp-ctrl">
      <div className="bp-ctrlhd"><span>{label}</span>
        <span className="bp-ctrlval">{money ? yen(value) : num(value)}<em>{money ? "" : unit}</em></span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
      <input className="bp-ctrlnum" type="number" value={value} onChange={(e) => set(Number(e.target.value) || 0)} />
    </div>
  );
}

/* ========================= Pitch ========================= */
function Pitch({ deck, c, results, sim, targetAmount, exitLine, verdict, setVerdict, memo, setMemo, onBack, onRestart }) {
  const [copied, setCopied] = useState(false);
  const slides = deck.slides || [];
  const r = sim ? computeSim(sim) : null;
  const kpi = results.execkpi;

  function copyText() {
    const txt = "【" + c.name + "】3分ピッチ骨子\n\n" + slides.map((s) =>
      (s.no || "") + ". " + s.title + (s.subtitle ? "\n" + s.subtitle : "") +
      (s.bullets ? "\n" + s.bullets.map((b) => "・" + b).join("\n") : "") +
      (s.speaker ? "\n▶ " + s.speaker : "")).join("\n\n");
    navigator.clipboard.writeText(txt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }

  const verdicts = [["GO", "GO（実行）", "go"], ["continue", "継続（検証続行）", "cont"], ["hold", "保留", "hold"]];

  return (
    <section className="bp-screen">
      <div className="bp-pitchcover"><Cross className="c1" /><Cross className="c2" />
        <span className="bp-tag light">3分ピッチ資料</span>
        <h2>{c.name}</h2><p>{c.catch}</p>
      </div>

      {/* 3 pillars */}
      <div className="bp-pillars">
        <div className="bp-pillar">
          <span className="bp-pillarhd">① 事業計画シミュレーション</span>
          {r ? (<div className="bp-pillarbody">
            <Metric label="3年目売上" value={yen(r.years[2].revenue)} />
            <Metric label="目標達成度" value={Math.round((targetAmount ? r.years[2].revenue / targetAmount : 0) * 100) + "%"} />
            <Metric label="3年累積利益" value={yen(r.cumulative)} />
            <Metric label="初期投資" value={yen(sim.invest)} />
            <Metric label="投資回収" value={r.breakEven || "3年内未達"} />
          </div>) : <p className="bp-pillarnote">⑤事業計画シミュレーターが未設定です。</p>}
        </div>
        <div className="bp-pillar">
          <span className="bp-pillarhd">② 成果指標（KPI）</span>
          {kpi ? (<div className="bp-pillarbody kpis">
            {(kpi.salesKpis || []).map((k, i) => <div className="bp-kpichip sales" key={"s" + i}><span>{k.name}</span><strong>{k.target}</strong></div>)}
            {(kpi.actionKpis || []).map((k, i) => <div className="bp-kpichip action" key={"a" + i}><span>{k.name}</span><strong>{k.target}</strong></div>)}
          </div>) : <p className="bp-pillarnote">⑥実行計画・KPIが未検証です（検証画面で生成できます）。</p>}
        </div>
        <div className="bp-pillar">
          <span className="bp-pillarhd">③ 実行計画（誰が・どの予算で・いつまでに）</span>
          {kpi && kpi.plan ? (<div className="bp-pillarbody"><table className="bp-plantable">
            <thead><tr><th>時期</th><th>担当</th><th>予算</th><th>やること</th></tr></thead>
            <tbody>{kpi.plan.map((p, i) => <tr key={i}><td className="wh">{p.when}</td><td>{p.who}</td><td>{p.budget}</td><td>{p.what}</td></tr>)}</tbody>
          </table></div>) : <p className="bp-pillarnote">実行計画が未検証です。</p>}
        </div>
      </div>

      {exitLine && (
        <div className="bp-block">
          <div className="bp-matrixhead"><h3>撤退ライン（決裁時に合意する条件）</h3><span className="bp-blocknote">成功確率 {exitProbability(exitLine).now}%{exitLine.owner ? "／判断者：" + exitLine.owner : ""}</span></div>
          <ExitGateTable el={exitLine} readOnly />
        </div>
      )}

      {/* slide outline */}
      <SectionLabel tag="SLIDES" title="スライド骨子" sub="各スライドの要点と話すポイント。コピーして資料に落とせます。" />
      <div className="bp-deck">
        {slides.map((s, i) => (
          <article className="bp-slide" key={i}><span className="bp-corner" />
            <div className="bp-slideno">{String(s.no || i + 1).padStart(2, "0")}</div>
            <div className="bp-slidebody"><h3>{s.title}</h3>{s.subtitle && <p className="bp-slidesub">{s.subtitle}</p>}
              {s.bullets && <ul className="bp-slidebullets">{s.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul>}
              {s.speaker && <p className="bp-slidespeaker"><span>話すポイント</span>{s.speaker}</p>}</div>
          </article>
        ))}
      </div>

      {/* その場決裁 */}
      <div className="bp-verdict">
        <SectionLabel tag="DECISION" title="その場決裁" sub="発表後、経営層/審査員がその場で判断します。" inline />
        <div className="bp-verdictbtns">
          {verdicts.map(([id, label, cls]) => (
            <button key={id} className={"bp-vbtn " + cls + (verdict === id ? " on" : "")} onClick={() => setVerdict(id)}>{label}</button>
          ))}
        </div>
        <textarea className="bp-verdictmemo" rows={2} placeholder="講評・次のステップのメモ…" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </div>

      <div className="bp-actionbar split">
        <button className="bp-ghost" onClick={onBack}>← 検証へ戻る</button>
        <div className="bp-actionright">
          <button className="bp-ghost" onClick={copyText}>{copied ? "コピーしました ✓" : "骨子をコピー"}</button>
          <button className="bp-cta" onClick={onRestart}>新しいお題で始める</button>
        </div>
      </div>
    </section>
  );
}
function Metric({ label, value }) { return <div className="bp-metric"><span>{label}</span><strong>{value}</strong></div>; }

/* ========================= shared ========================= */
function SectionLabel({ tag, title, sub, inline }) {
  return (
    <div className={"bp-seclabel" + (inline ? " inline" : "")}>
      <div className="bp-secrow"><span className="bp-sectag">{tag}</span><h2>{title}</h2></div>
      <div className="bp-uline sm" />
      {sub && <p>{sub}</p>}
    </div>
  );
}
function Panel({ title, children }) { return <div className="bp-panel"><span className="bp-panelhd">{title}</span>{children}</div>; }
function Callout({ label, children, accent }) { return <div className={"bp-callout" + (accent ? " accent" : "")}><span className="bp-calloutlabel">{label}</span><p>{children}</p></div>; }
function InfoList({ head, items }) { return <div className="bp-infolist"><span className="bp-infohd">{head}</span><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>; }
function Skeleton({ msg }) { return <div className="bp-skel"><div className="bp-spinner" /><p>{msg}</p></div>; }
function Overlay({ msg }) { return <div className="bp-overlay"><div className="bp-spinner big" /><p>{msg}</p></div>; }

/* ========================= Portfolio Input ========================= */
function PortfolioInput({ rows, setRows, target, setTarget, onSubmit, loading, onBack }) {
  const fileRef = useRef(); const [fileName, setFileName] = useState("");
  function setCell(i, k, v) { setRows(rows.map((r, idx) => idx === i ? { ...r, [k]: v } : r)); }
  function addRow() { setRows([...rows, { name: "", memo: "", value: "", vstatus: "", evidence: "", bizType: "BtoB", price: "", unitCost: "", freq: 1, team: "", resource: "", passion: 3, stage: "検証" }]); }
  function delRow(i) { setRows(rows.filter((_, idx) => idx !== i)); }
  function handleFile(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array" });
        const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
        const mapped = arr.map((o) => {
          const g = (keys) => { for (const k of Object.keys(o)) { if (keys.some((x) => k.includes(x))) return o[k]; } return ""; };
          return {
            name: g(["事業", "名", "name"]) || "", memo: g(["概要", "メモ", "説明", "memo"]) || "",
            value: g(["価値", "意義", "非財務", "CSR", "value"]) || "",
            vstatus: g(["検証状況", "検証レベル"]) || "",
            evidence: g(["手応え", "補足", "エビデンス", "反応", "実績", "evidence"]) || "",
            team: g(["推進体制", "体制", "担当", "オーナー", "team"]) || "",
            bizType: /c/i.test(String(g(["形態", "BtoC", "BtoB", "type"]))) && !/b\s*to\s*b/i.test(String(g(["形態", "type"]))) ? "BtoC" : "BtoB",
            price: Number(String(g(["売価", "単価", "価格", "price"])).replace(/[^0-9.]/g, "")) || "",
            unitCost: Number(String(g(["原価", "コスト", "cost"])).replace(/[^0-9.]/g, "")) || "",
            freq: Number(String(g(["頻度", "回数", "freq"])).replace(/[^0-9.]/g, "")) || 1,
            resource: Number(String(g(["リソース", "工数", "人", "resource"])).replace(/[^0-9.]/g, "")) || "",
            passion: Number(String(g(["熱量", "passion"])).replace(/[^0-9.]/g, "")) || 3,
            stage: g(["ステージ", "段階", "stage"]) || "検証",
          };
        }).filter((r) => r.name);
        if (mapped.length) setRows(mapped);
      } catch (err) { setFileName(f.name + "（読み込み失敗）"); }
    };
    reader.readAsArrayBuffer(f);
  }
  const filled = rows.filter((r) => r.name && String(r.name).trim()).length;
  return (
    <section className="bp-screen">
      <SectionLabel tag="STEP 01" title="進行中の事業を入力する" sub="いま並走している事業を並べます。売上がまだ無い・検証中でもOK（年商・原価は任意）。「顧客にどこまで確かめたか（検証状況）」を選ぶだけで、AIが市場規模から悲観・普通・楽観の売上予測と評価を出します。情報が足りない分は後でAIが壁打ちで聞きます。" />

      <div className="bp-pftable">
        <div className="bp-pfhead">
          <span className="c-name">事業名 / 概要 / 数字以外の価値 / 検証状況</span>
          <span className="c-type">形態</span><span className="c-num">売価<em>単位</em></span><span className="c-num">原価<em>単位</em></span><span className="c-num">粗利率</span><span className="c-freq">頻度<em>回/年</em></span>
          <span className="c-res">リソース<em>人日/月</em></span><span className="c-pass">熱量</span><span className="c-stage">ステージ</span><span className="c-del" />
        </div>
        {rows.map((r, i) => {
          const m = marginPct(r.price, r.unitCost);
          const hasPrice = Number(r.price) > 0;
          return (
            <div className="bp-pfrow" key={i}>
              <span className="c-name">
                <input className="bp-in name" value={r.name} placeholder="事業名" onChange={(e) => setCell(i, "name", e.target.value)} />
                <input className="bp-in memo" value={r.memo} placeholder="ひとこと概要（誰に・何を）" onChange={(e) => setCell(i, "memo", e.target.value)} />
                <input className="bp-in value" value={r.value || ""} placeholder="数字以外の価値：CSR / 地域 / 採用 / 技術 / 現場の熱 など" onChange={(e) => setCell(i, "value", e.target.value)} />
                <select className={"bp-in vstatus" + (r.vstatus ? " set" : "")} value={r.vstatus || ""} onChange={(e) => setCell(i, "vstatus", e.target.value)}>
                  <option value="">顧客にどこまで確かめた？（検証状況）</option>
                  {EVIDENCE_LEVELS.map((lv, k) => <option key={k} value={lv}>{k + 1 + "．" + lv}</option>)}
                </select>
                <input className="bp-in evidence" value={r.evidence || ""} placeholder="補足：何社に聞いた・受注数・反応など（任意）" onChange={(e) => setCell(i, "evidence", e.target.value)} />
                <input className="bp-in team" value={r.team || ""} placeholder="推進体制：オーナー・専任/兼任・決裁者との距離・協力部署（任意）" onChange={(e) => setCell(i, "team", e.target.value)} />
              </span>
              <span className="c-type">
                <select className="bp-in" value={r.bizType || "BtoB"} onChange={(e) => setCell(i, "bizType", e.target.value)}>
                  <option value="BtoB">BtoB</option><option value="BtoC">BtoC</option>
                </select>
              </span>
              <span className="c-num"><input className="bp-in" type="number" value={r.price} placeholder="円" onChange={(e) => setCell(i, "price", e.target.value)} /></span>
              <span className="c-num"><input className="bp-in" type="number" value={r.unitCost} placeholder="円" onChange={(e) => setCell(i, "unitCost", e.target.value)} /></span>
              <span className={"c-num bp-margin" + (hasPrice && m < 0 ? " neg" : "")}>{hasPrice ? m + "%" : "—"}</span>
              <span className="c-freq"><input className="bp-in" type="number" value={r.freq} placeholder="1" onChange={(e) => setCell(i, "freq", e.target.value)} /></span>
              <span className="c-res"><input className="bp-in" type="number" value={r.resource} placeholder="—" onChange={(e) => setCell(i, "resource", e.target.value)} /></span>
              <span className="c-pass">
                <select className="bp-in" value={r.passion} onChange={(e) => setCell(i, "passion", Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </span>
              <span className="c-stage">
                <select className="bp-in" value={r.stage} onChange={(e) => setCell(i, "stage", e.target.value)}>
                  {PF_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </span>
              <span className="c-del"><button className="bp-del" onClick={() => delRow(i)} title="削除">×</button></span>
            </div>
          );
        })}
      </div>

      <div className="bp-pftools">
        <button className="bp-ghost" onClick={addRow}>＋ 事業を追加</button>
        <div className="bp-upload sm" onClick={() => fileRef.current && fileRef.current.click()}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} hidden />
          <span className="bp-upicon">⇪</span><div><strong>Excel / CSV 取込</strong><p>{fileName || "事業一覧シートを読み込み"}</p></div>
        </div>
        <button className="bp-ghost" onClick={() => setRows(PF_SAMPLE.map((x) => ({ ...x })))}>サンプル（実例）</button>
      </div>

      <div className="bp-actionbar split">
        <button className="bp-ghost" onClick={onBack}>← モード選択へ</button>
        <button className="bp-cta" disabled={!filled || loading} onClick={onSubmit}>{loading ? "整理中…" : "多角的に整理する →"}</button>
      </div>
    </section>
  );
}

/* ========================= Portfolio Board ========================= */
const VERDICT_META = {
  "集中": { cls: "focus", color: "#1668B3" },
  "実証": { cls: "validate", color: "#3E63C8" },
  "継続": { cls: "keep", color: "#16233F" },
  "縮小": { cls: "exit", color: "#C0503A" },
  "撤退": { cls: "exit", color: "#C0503A" },
};

function PortfolioBoard({ result, sortKey, setSortKey, axis, setAxis, onSelect, onBack }) {
  const biz = result.businesses || [];
  const pf = result.portfolio || {};
  const totalRev = biz.reduce((s, b) => s + b.revenue, 0);
  const totalCost = biz.reduce((s, b) => s + b.cost, 0);
  const totalProfit = totalRev - totalCost;
  const totalMargin = totalRev ? Math.round((totalProfit / totalRev) * 100) : 0;
  const [copied, setCopied] = React.useState(false);
  function copyExec() {
    const lines = [];
    lines.push("【事業ポートフォリオ整理｜経営説明】");
    if (result.targetLabel) lines.push("目標規模: " + result.targetLabel);
    if (pf.diagnosis) lines.push("\n■ 現状診断\n" + pf.diagnosis);
    if (pf.execLogic && pf.execLogic.length) lines.push("\n■ 説明ロジック\n" + pf.execLogic.map((s, i) => (i + 1) + ". " + s).join("\n"));
    if (pf.nonFinancial) lines.push("\n■ 数字に出ない価値の見せ方\n" + pf.nonFinancial);
    if (grp["集中"] && grp["集中"].length) lines.push("\n■ 集中(A): " + grp["集中"].join(" / "));
    if (grp["継続"] && grp["継続"].length) lines.push("■ 継続(B): " + grp["継続"].join(" / "));
    if (grp["実証"] && grp["実証"].length) lines.push("■ 実証(C): " + grp["実証"].join(" / "));
    if ((grp["縮小"] || []).length + (grp["撤退"] || []).length) lines.push("■ 縮小・撤退(D/E): " + grp["縮小"].concat(grp["撤退"]).join(" / "));
    if (pf.reallocation && pf.reallocation.length) lines.push("\n■ リソース再配分\n" + pf.reallocation.map((r) => "・" + r.from + " → " + r.to + "：" + (r.detail || "")).join("\n"));
    if (pf.validations && pf.validations.length) lines.push("\n■ 実証プラン\n" + pf.validations.map((v) => "・" + v.business + "\n  仮説: " + v.hypothesis + "\n  実験: " + v.experiment + "\n  判断基準: " + v.criteria + "（" + v.period + "）").join("\n"));
    navigator.clipboard.writeText(lines.join("\n")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }

  const sorts = [["score", "評価スコア"], ["reach", "1億見込み"], ["margin", "利益率(現状)"], ["passion", "熱量"], ["revenue", "現在売上"], ["resource", "リソース"]];
  const ranked = [...biz].sort((a, b) => {
    if (sortKey === "reach") return (b._reach - a._reach) || ((b.realY3 || 0) - (a.realY3 || 0));
    if (sortKey === "margin") return b.margin - a.margin;
    if (sortKey === "passion") return b.passion - a.passion;
    if (sortKey === "revenue") return b.revenue - a.revenue;
    if (sortKey === "resource") return a.resource - b.resource;
    return (b.evalPct || 0) - (a.evalPct || 0);
  });
  const keepCount = biz.filter((b) => b.rank === "A" || b.rank === "B").length;
  const exitCount = biz.filter((b) => b.rank === "D" || b.rank === "E").length;
  const grp = { 集中: [], 継続: [], 実証: [], 縮小: [], 撤退: [] };
  ranked.forEach((b) => { (grp[b.verdict] || (grp[b.verdict] = [])).push(b.name); });

  return (
    <section className="bp-screen">
      <SectionLabel tag="STEP 02" title="事業を評価して、継続か撤退かを決める" sub="新規事業の成功＝3年で1億円以上。プロの事業家視点で、市場規模・利益率・参入障壁・独自性を採点し、市場とニーズから3年後売上を悲観／普通／楽観で予測。総合スコア→A〜Eランク→継続/撤退を判定します。" />

      {/* 全体サマリ */}
      <div className="bp-pfsummary">
        <div className="bp-sumcell"><span>事業数</span><strong>{biz.length}<em>件</em></strong></div>
        <div className="bp-sumcell hl"><span>継続・集中（A/B）</span><strong className="pos">{keepCount}<em>件</em></strong></div>
        <div className="bp-sumcell"><span>実証（C）</span><strong>{biz.filter((b) => b.rank === "C").length}<em>件</em></strong></div>
        <div className="bp-sumcell"><span>縮小・撤退（D/E）</span><strong className="neg">{exitCount}<em>件</em></strong></div>
        <div className="bp-sumcell"><span>未収益（検証中）</span><strong>{biz.filter((b) => b.preRevenue).length}<em>件</em></strong></div>
      </div>

      {/* 診断 */}
      {pf.diagnosis && <div className="bp-diagnosis"><span className="bp-calloutlabel">ポートフォリオ診断</span><p>{pf.diagnosis}</p></div>}

      {/* 評価スコアカード */}
      <div className="bp-block">
        <div className="bp-matrixhead"><h3>事業評価スコアカード</h3><span className="bp-blocknote">各指標をA〜Eで採点 → 重み付き100点 → 総合ランク。市場30 / 利益25 / 障壁20 / 独自25</span></div>
        <div className="bp-ranklegend">
          <span className="bp-lg rA">A 80+</span><span className="bp-lg rB">B 65+</span><span className="bp-lg rC">C 50+</span><span className="bp-lg rD">D 35+</span><span className="bp-lg rE">E 〜34</span>
          <span className="bp-lgnote">A=集中 / B=継続 / C=実証 / D=縮小 / E=撤退</span>
        </div>
        <div className="bp-scorecards">
          {ranked.map((b, i) => {
            const rm = RANK_META[b.rank] || RANK_META.C;
            return (
              <div className={"bp-scorecard " + rm.cls} key={i}>
                <div className="bp-scrank"><span className="bp-rankbig">{b.rank}</span><span className="bp-rankmark">{rm.mark}</span></div>
                <div className="bp-scmain">
                  <div className="bp-schd">
                    <strong className="bp-scname">{b.name}</strong>
                    <span className="bp-scpct">{b.evalPct}<em>点</em></span>
                  </div>
                  <div className="bp-scaxes">
                    {EVAL_AXES.map((a) => {
                      const v = Number(b[a.key]) || 3;
                      const lr = axisRank(v);
                      return (
                        <div className="bp-scaxis" key={a.key}>
                          <span className="bp-scaxlabel">{a.label}<em>{a.weight}%</em></span>
                          <span className="bp-scaxtrack"><span className="bp-scaxfill" style={{ width: (v / 5) * 100 + "%" }} /></span>
                          <span className={"bp-axletter " + RANK_META[lr].cls}>{lr}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="bp-scfore">
                    <div className="bp-scforehd"><span>3年後 売上予測（市場規模ベース）</span>{b.hitsTarget && <span className="bp-hit1oku">1億到達見込み</span>}</div>
                    <div className="bp-scscenarios">
                      <div className="bp-scn low"><span>悲観</span><strong>{yen(b.low3)}</strong></div>
                      <div className="bp-scn base"><span>普通</span><strong>{yen(b.base3)}</strong></div>
                      <div className="bp-scn high"><span>楽観</span><strong>{yen(b.high3)}</strong></div>
                      {b.som ? <div className="bp-scn som"><span>獲得可能市場</span><strong>{yen(b.som)}</strong></div> : null}
                    </div>
                    {b.fcBasis && <p className="bp-scbasis">根拠：{b.fcBasis}</p>}
                  </div>
                  <div className="bp-scfoot">
                    <span className={"bp-scdecision " + rm.cls}>{rm.decision}</span>
                    <span className="bp-scnote">{rm.note}{b.pathToTarget ? "／届く条件：" + b.pathToTarget : ""}</span>
                    <button className="bp-mini" onClick={() => onSelect(b)}>深掘る →</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* マトリクス */}
      <div className="bp-block">
        <div className="bp-matrixhead">
          <h3>優先度マトリクス</h3>
          <div className="bp-axispick">
            <label>横軸<AxisSelect value={axis.x} onChange={(v) => setAxis({ ...axis, x: v })} /></label>
            <label>縦軸<AxisSelect value={axis.y} onChange={(v) => setAxis({ ...axis, y: v })} /></label>
          </div>
        </div>
        <Matrix biz={biz} axis={axis} onSelect={onSelect} />
        <p className="bp-matrixnote">バブルの大きさ＝年商 / 色＝判定（<b className="v-focus">集中</b>・<b className="v-keep">継続</b>・<b className="v-validate">実証</b>・<b className="v-exit">縮小・撤退</b>）。右上ほど優先、左下は見直し候補。</p>
      </div>

      {/* 選択と集中（ランク由来の4分類） */}
      <div className="bp-reco4">
        <div className="bp-recocol focus"><span className="bp-recohd focus">集中（A）</span><p className="bp-recosub">今すぐ寄せる</p>
          <div className="bp-recochips">{grp["集中"].map((n, i) => <span key={i} className="bp-recochip focus">{n}</span>)}{!grp["集中"].length && <span className="bp-recoempty">—</span>}</div></div>
        <div className="bp-recocol keep"><span className="bp-recohd">継続（B）</span><p className="bp-recosub">続けて伸ばす</p>
          <div className="bp-recochips">{grp["継続"].map((n, i) => <span key={i} className="bp-recochip keep">{n}</span>)}{!grp["継続"].length && <span className="bp-recoempty">—</span>}</div></div>
        <div className="bp-recocol validate"><span className="bp-recohd validate">実証（C）</span><p className="bp-recosub">小さく試して見極める</p>
          <div className="bp-recochips">{grp["実証"].map((n, i) => <span key={i} className="bp-recochip validate">{n}</span>)}{!grp["実証"].length && <span className="bp-recoempty">—</span>}</div></div>
        <div className="bp-recocol exit"><span className="bp-recohd exit">縮小・撤退（D/E）</span><p className="bp-recosub">畳んで資源を解放</p>
          <div className="bp-recochips">{grp["縮小"].concat(grp["撤退"]).map((n, i) => <span key={i} className="bp-recochip exit">{n}</span>)}{!(grp["縮小"].length + grp["撤退"].length) && <span className="bp-recoempty">—</span>}</div></div>
      </div>

      {/* 数字に出ない価値（残す理由） */}
      {(pf.nonFinancial || biz.some((b) => (b.strategicValue || 0) >= 4 && b.otherValue)) && (
        <div className="bp-block">
          <div className="bp-matrixhead"><h3>数字に出ない価値</h3><span className="bp-blocknote">売上だけで判断しない。CSR・地域・採用・技術・現場の意義</span></div>
          {pf.nonFinancial && <Callout label="経営者・ステークホルダーへの見せ方" accent>{pf.nonFinancial}</Callout>}
          <div className="bp-nfgrid">
            {biz.filter((b) => (b.strategicValue || 0) >= 3 && b.otherValue).sort((a, b) => (b.strategicValue || 0) - (a.strategicValue || 0)).map((b, i) => (
              <div className="bp-nfcard" key={i}>
                <div className="bp-nfhd"><strong>{b.name}</strong><span className="bp-stars">{"★".repeat(b.strategicValue)}<span className="dim">{"★".repeat(5 - b.strategicValue)}</span></span></div>
                <p>{b.otherValue}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* リソース再配分 */}
      {pf.reallocation && pf.reallocation.length > 0 && (
        <div className="bp-block">
          <div className="bp-matrixhead"><h3>リソース再配分</h3><span className="bp-blocknote">どこを畳んで、どこに寄せるか</span></div>
          <div className="bp-realloc">
            {pf.reallocation.map((r, i) => (
              <div className="bp-reallocrow" key={i}>
                <span className="bp-rafrom">{r.from}</span>
                <span className="bp-raarrow">→</span>
                <span className="bp-rato">{r.to}</span>
                <span className="bp-radetail">{r.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 実証プラン（仮説→小さく試す→やめる） */}
      {pf.validations && pf.validations.length > 0 && (
        <div className="bp-block">
          <div className="bp-matrixhead"><h3>実証プラン</h3><span className="bp-blocknote">仮説 → 小さく試す → 判断基準で決める</span></div>
          <div className="bp-vplans">
            {pf.validations.map((v, i) => (
              <div className="bp-vplan" key={i}><span className="bp-corner" />
                <strong className="bp-vpbiz">{v.business}</strong>
                <div className="bp-vprow"><span className="bp-vplabel">仮説</span><p>{v.hypothesis}</p></div>
                <div className="bp-vprow"><span className="bp-vplabel">最小実験</span><p>{v.experiment}</p></div>
                <div className="bp-vprow"><span className="bp-vplabel">判断基準</span><p className="crit">{v.criteria}</p></div>
                {v.period && <span className="bp-vpperiod">{v.period}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 経営者への説明ロジック */}
      {pf.execLogic && pf.execLogic.length > 0 && (
        <div className="bp-block">
          <div className="bp-matrixhead"><h3>経営者への説明ロジック</h3>
            <button className="bp-ghost small" onClick={copyExec}>{copied ? "コピーしました ✓" : "説明をコピー"}</button></div>
          <ol className="bp-execlogic">
            {pf.execLogic.map((s, i) => (<li key={i}><span className="bp-eln">{i + 1}</span><p>{s}</p></li>))}
          </ol>
        </div>
      )}

      {/* ランキング表 */}
      <div className="bp-block">
        <div className="bp-matrixhead">
          <h3>事業ランキング</h3>
          <div className="bp-sortbar mini">
            <span className="bp-sortlabel">並べ替え</span>
            {sorts.map(([k, label]) => <button key={k} className={"bp-sortbtn" + (sortKey === k ? " on" : "")} onClick={() => setSortKey(k)}>{label}</button>)}
          </div>
        </div>
        <table className="bp-pfrank wide">
          <thead><tr><th>事業</th><th className="ac">市場規模</th><th className="ac">利益率</th><th className="ac">参入障壁</th><th className="ac">独自性</th><th className="ac">3年後売上</th><th className="ac">総合</th><th className="ac">総合ランク</th><th>判定</th><th /></tr></thead>
          <tbody>
            {ranked.map((b, i) => {
              const rm = RANK_META[b.rank] || RANK_META.C;
              const cell = (v) => { const lr = axisRank(v); return <td className="n ac"><span className={"bp-axletter sm " + RANK_META[lr].cls}>{lr}</span><span className="bp-axsub">{v}</span></td>; };
              return (
              <tr key={i} className={"v-" + (VERDICT_META[b.verdict]?.cls || "keep")}>
                <td className="nm">
                  <strong>{b.name}</strong>
                  <span className="bp-flags">
                    {b.margin < 0 && <span className="bp-flag red">原価割れ</span>}
                    {b.preRevenue && <span className="bp-flag navy">未収益</span>}
                    {(b.sellability || 0) <= 2 && <span className="bp-flag amber">売れ構造△</span>}
                    {b.hitsTarget && <span className="bp-flag green">1億見込み</span>}
                  </span>
                  {b.reason && <em>{b.reason}</em>}
                  {b.pathToTarget && <em className="path">届く条件：{b.pathToTarget}</em>}
                </td>
                {cell(b.marketSize)}
                {cell(b.profitability)}
                {cell(b.barrier)}
                {cell(b.uniqueness)}
                <td className="n ac"><strong className="bp-fc3">{yen(b.base3)}</strong><span className="bp-axsub">{yen(b.low3)}〜{yen(b.high3)}</span></td>
                <td className="n ac"><strong className="bp-scorenum2">{b.evalPct}</strong></td>
                <td className="n ac"><span className={"bp-rankchip " + rm.cls}>{b.rank}<em>{rm.mark}</em></span></td>
                <td className="n"><span className={"bp-vbadge " + (VERDICT_META[b.verdict]?.cls || "keep")}>{b.verdict}</span></td>
                <td className="n"><button className="bp-mini" onClick={() => onSelect(b)}>深掘る →</button></td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="bp-actionbar left"><button className="bp-ghost" onClick={onBack}>← 事業を編集</button></div>
    </section>
  );
}
function AxisSelect({ value, onChange }) {
  return (
    <select className="bp-in" value={value} onChange={(e) => onChange(e.target.value)}>
      {PF_AXES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
    </select>
  );
}

/* ---- Matrix (custom SVG) ---- */
function Matrix({ biz, axis, onSelect }) {
  const ax = PF_AXES.find((a) => a.key === axis.x) || PF_AXES[0];
  const ay = PF_AXES.find((a) => a.key === axis.y) || PF_AXES[1];
  const W = 640, H = 420, pad = 48;
  const xmax = ax.max != null ? ax.max : Math.max(...biz.map(ax.get), 1);
  const ymax = ay.max != null ? ay.max : Math.max(...biz.map(ay.get), 1);
  const xmin = ax.min, ymin = ay.min;
  const maxRev = Math.max(...biz.map((b) => b.revenue), 1);
  const px = (v) => pad + ((v - xmin) / (xmax - xmin || 1)) * (W - pad * 2);
  const py = (v) => H - pad - ((v - ymin) / (ymax - ymin || 1)) * (H - pad * 2);
  const rOf = (rev) => 12 + Math.sqrt(rev / maxRev) * 26;
  const midX = pad + (W - pad * 2) / 2, midY = pad + (H - pad * 2) / 2;
  return (
    <div className="bp-matrixwrap">
      <svg viewBox={"0 0 " + W + " " + H} className="bp-matrixsvg">
        <rect x={pad} y={pad} width={W - pad * 2} height={H - pad * 2} fill="#fff" stroke="#D4DAE3" />
        {/* quadrant fills */}
        <rect x={midX} y={pad} width={(W - pad * 2) / 2} height={(H - pad * 2) / 2} fill="#FCEBDE" opacity="0.5" />
        {/* grid */}
        <line x1={midX} y1={pad} x2={midX} y2={H - pad} stroke="#C3CBD6" strokeDasharray="4 4" />
        <line x1={pad} y1={midY} x2={W - pad} y2={midY} stroke="#C3CBD6" strokeDasharray="4 4" />
        {/* quadrant labels */}
        <text x={W - pad - 8} y={pad + 16} textAnchor="end" className="bp-qlabel hi">最優先・強化</text>
        <text x={pad + 8} y={pad + 16} className="bp-qlabel">効率化・委譲</text>
        <text x={W - pad - 8} y={H - pad - 8} textAnchor="end" className="bp-qlabel">磨く・改善</text>
        <text x={pad + 8} y={H - pad - 8} className="bp-qlabel lo">見直し候補</text>
        {/* axis titles */}
        <text x={W / 2} y={H - 14} textAnchor="middle" className="bp-axtitle">{ax.label} →</text>
        <text x={16} y={H / 2} textAnchor="middle" transform={"rotate(-90 16 " + H / 2 + ")"} className="bp-axtitle">{ay.label} →</text>
        {/* bubbles */}
        {biz.map((b, i) => {
          const cx = px(ax.get(b)), cy = py(ay.get(b)), r = rOf(b.revenue);
          const color = VERDICT_META[b.verdict]?.color || "#16233F";
          return (
            <g key={i} className="bp-bubble" onClick={() => onSelect(b)}>
              <circle cx={cx} cy={cy} r={r} fill={color} fillOpacity="0.85" stroke="#fff" strokeWidth="2" />
              <text x={cx} y={cy + r + 13} textAnchor="middle" className="bp-blabel">{b.name}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ========================= Interview（壁打ち：不足情報をAIが質問して埋める） ========================= */
function Interview({ biz, iv, setIv, onSubmit, onBack }) {
  const qs = iv.questions || [];
  const answered = qs.filter((q) => { const a = iv.answers[q.id]; return a && String(a).trim(); }).length;
  function setAns(id, v) { setIv({ ...iv, answers: { ...iv.answers, [id]: v } }); }
  return (
    <section className="bp-screen">
      <div className="bp-selbanner"><Cross className="c1" /><Cross className="c2" />
        <span className="bp-selpill">BUSINESS REVIEW</span>
        <div><h2>{biz ? biz.name : "事業"} ― 壁打ち</h2><p>不足している情報だけ、AIが数問だけ確認します（{answered} / {qs.length}）</p></div>
      </div>

      <div className="bp-ivlist">
        {qs.map((q, i) => (
          <div className="bp-ivq" key={q.id}>
            <div className="bp-ivqhd">
              <span className="bp-ivno">{String(i + 1).padStart(2, "0")} / {String(qs.length).padStart(2, "0")}</span>
              {q.topic && <span className="bp-ivtopic">{q.topic}</span>}
            </div>
            <h3 className="bp-ivquestion">{q.question}</h3>
            {q.options && q.options.length > 0 && (
              <div className="bp-ivopts">
                {q.options.map((o, j) => (
                  <button key={j} className={"bp-ivopt" + (iv.answers[q.id] === o ? " on" : "")} onClick={() => setAns(q.id, o)}>{o}</button>
                ))}
              </div>
            )}
            <input className="bp-ivfree" value={(q.options || []).includes(iv.answers[q.id]) ? "" : (iv.answers[q.id] || "")} placeholder="自由に補足・具体的な数字など（任意）…" onChange={(e) => setAns(q.id, e.target.value)} />
            {q.whyAsk && <p className="bp-ivwhy"><span>なぜ確認する？</span>{q.whyAsk}</p>}
          </div>
        ))}
      </div>

      <div className="bp-actionbar split">
        <button className="bp-ghost" onClick={onBack}>← 評価へ戻る</button>
        <button className="bp-cta" onClick={onSubmit} disabled={answered === 0}>回答を反映して再評価する →</button>
      </div>
    </section>
  );
}

/* ========================= DeepEval（単一事業の1億円到達可能性 100点評価） ========================= */
function DeepEval({ de, loading, onBack, onSim, onInterview, interviewLoading, onExit }) {
  if (loading || !de) {
    return (
      <section className="bp-screen">
        <div className="bp-selbanner"><Cross className="c1" /><Cross className="c2" /><span className="bp-selpill">詳細評価</span><div><h2>1億円到達可能性を採点中…</h2><p>事実・証拠から{ALL_SUBITEMS.length}項目を機械採点しています</p></div></div>
        <Skeleton msg="顧客課題・市場・売上モデル・収益性・勝てる理由・実行と推進体制を評価中…" />
      </section>
    );
  }
  const { biz, data, items, score, ev } = de;
  const rm = RANK_META[rankFromScore(score.total)] || RANK_META.C;
  const eq = data.equation || {};
  const srcChip = (s) => { const m = SOURCE_META[s]; return m ? <span className={"bp-src " + m.cls}>{m.label}</span> : null; };

  return (
    <section className="bp-screen">
      <div className="bp-selbanner"><Cross className="c1" /><Cross className="c2" />
        <span className="bp-selpill">{data.businessType || "評価"}</span>
        <div><h2>{biz.name}</h2><p>{biz.memo}</p></div>
      </div>

      {/* ヒーロー：到達可能性・点数・ランク・Evidence・カバレッジ */}
      <div className={"bp-hero1oku " + rm.cls}>
        <div className="bp-hlead">3年後 1億円 到達可能性</div>
        <div className="bp-hmain">
          <div className="bp-hscore"><strong>{score.total}</strong><span>/ 100</span></div>
          <div className="bp-hrank">{rm.mark}<span>{rankFromScore(score.total)}</span></div>
          <div className="bp-hmeta">
            <div className="bp-hchip"><span>Evidence</span><strong>Lv.{ev} / 5</strong></div>
            <div className="bp-hchip"><span>評価カバレッジ</span><strong>{score.coverage}%</strong><em>（{score.evalCount}/{score.of}項目）</em></div>
          </div>
        </div>
        {data.conclusion && <p className="bp-hconc">{data.conclusion}</p>}
      </div>

      {/* 壁打ち促し（情報不足＝カバレッジ低 or Evidence低） */}
      {(score.coverage < 85 || ev <= 3) && (
        <div className="bp-interviewcta">
          <div>
            <strong>情報が足りていません（評価カバレッジ {score.coverage}% / Evidence Lv.{ev}）</strong>
            <p>引き継ぎ・未検証の項目があります。AIと数問の壁打ちで埋めると、スコアと比較の精度が上がります。</p>
          </div>
          <button className="bp-cta" onClick={onInterview} disabled={interviewLoading}>{interviewLoading ? "準備中…" : "壁打ちで埋める →"}</button>
        </div>
      )}

      {/* 1億円への方程式 */}
      <div className="bp-block">
        <div className="bp-matrixhead"><h3>1億円への方程式</h3><span className="bp-blocknote">{data.businessType === "BtoC" ? "1億 ÷（単価×頻度）＝必要顧客数" : "1億 ÷ 年間顧客単価 ＝必要顧客数"}</span></div>
        <div className="bp-eqrow">
          <div className="bp-eqcell"><span>年間単価</span><strong>{yen(eq.unitPrice)}</strong></div>
          {data.businessType === "BtoC" && <div className="bp-eqop">×</div>}
          {data.businessType === "BtoC" && <div className="bp-eqcell"><span>年間頻度</span><strong>{num(eq.frequency)}回</strong></div>}
          <div className="bp-eqop">→</div>
          <div className="bp-eqcell hl"><span>必要顧客数</span><strong>{num(eq.neededCustomers)}</strong></div>
        </div>
        {eq.note && <p className="bp-scbasis">{eq.note}</p>}
      </div>

      {/* 最大ボトルネック */}
      {(data.bottleneck || data.criticalAssumption) && (
        <div className="bp-block bottleneck">
          <div className="bp-matrixhead"><h3>最大ボトルネック</h3></div>
          {data.bottleneck && <Callout label="いま最も足りないもの" accent>{data.bottleneck}</Callout>}
          {data.criticalAssumption && <p className="bp-scbasis">崩れたら終わる前提：{data.criticalAssumption}</p>}
        </div>
      )}

      {/* 推進体制（人）が弱い場合は明示する：実行の確度は人で決まる */}
      {(() => {
        const ids = ["ownerCommitment", "dedicatedCapacity", "stakeholderBuyIn"];
        const ev = ids.map((id) => items[id] || {}).filter((s) => s.status !== "unverified");
        const unv = ids.length - ev.length;
        const avg = ev.length ? ev.reduce((a, s) => a + (Number(s.score) || 0), 0) / ev.length : null;
        if (avg != null && avg > 2 && unv === 0) return null;
        return (
          <div className="bp-block bottleneck">
            <div className="bp-matrixhead"><h3>推進体制（人）</h3><span className="bp-blocknote">オーナーの熱量×権限・投入工数・巻き込み力</span></div>
            <Callout label={avg != null && avg <= 2 ? "人がボトルネックです" : "推進体制の情報が足りません"} accent>
              {avg != null && avg <= 2
                ? "市場や顧客の証拠があっても、推進する人・時間・社内の協力が足りないと3年では届きません。撤退ラインを決める前に、オーナーと投入工数を確定させてください。"
                : "推進体制が未検証の項目が" + unv + "つあります。事業一覧の「推進体制」に記入するか、壁打ちで埋めてください。"}
            </Callout>
          </div>
        );
      })()}

      {/* 6カテゴリ評価（クリックで理由を展開） */}
      <div className="bp-block">
        <div className="bp-matrixhead"><h3>6項目評価（100点の内訳）</h3><span className="bp-blocknote">各項目は事実・証拠から0〜5で機械採点し、大項目の配点で重み付け。クリックで理由を表示</span></div>
        {SCORE_MODEL.map((cat) => {
          const cs = score.cats.find((c) => c.id === cat.id) || {};
          return (
            <div className="bp-catblock" key={cat.id}>
              <div className="bp-cathd"><strong>{cat.label}</strong><span className="bp-catpts">{cs.pts}<em>/ {cat.max}</em></span></div>
              {cat.items.map((it) => {
                const s = items[it.id] || {};
                const unv = s.status === "unverified";
                const sc = Math.max(0, Math.min(5, Number(s.score) || 0));
                return (
                  <details className={"bp-subitem" + (unv ? " unv" : "")} key={it.id}>
                    <summary>
                      <span className="bp-subname">{it.label}{srcChip(s.source)}</span>
                      <span className="bp-subscore">{unv ? <span className="bp-unv">未検証</span> : <><span className="bp-subdots">{"●".repeat(sc)}<span className="dim">{"●".repeat(5 - sc)}</span></span><b>{sc}/5</b></>}</span>
                      <span className="bp-subchev">⌄</span>
                    </summary>
                    <div className="bp-subbody">
                      {s.reason && <p className="bp-subreason">{s.reason}</p>}
                      {s.evidence && s.evidence.length > 0 && <ul className="bp-subev">{s.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                      {s.missingEvidence && <p className="bp-submiss">不足している証拠：{s.missingEvidence}</p>}
                      <p className="bp-subrubric">基準 {sc}：{it.rubric[sc]}</p>
                    </div>
                  </details>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* スコア改善シミュレーション */}
      {data.scoreImprovement && (
        <div className={"bp-improve " + rm.cls}>
          <span className="bp-imphd">スコア改善シミュレーション</span>
          <p className="bp-impbody">
            現在 <b>{score.total}点</b>。最弱は「{data.scoreImprovement.itemLabel}」。
            <br />{data.scoreImprovement.action} → <b className="up">{score.total}{data.scoreImprovement.gain ? " → " + (score.total + (parseInt(String(data.scoreImprovement.gain).replace(/[^0-9]/g, "")) || 0)) + "点" : ""}</b>
          </p>
        </div>
      )}

      {/* 次の実証 */}
      {data.nextExperiment && (
        <div className="bp-block">
          <div className="bp-matrixhead"><h3>次の3ヶ月で証明すること</h3><span className="bp-blocknote">仮説 → 小さく試す → 判断基準</span></div>
          <div className="bp-vplan"><span className="bp-corner" />
            <div className="bp-vprow"><span className="bp-vplabel">仮説</span><p>{data.nextExperiment.hypothesis}</p></div>
            <div className="bp-vprow"><span className="bp-vplabel">実験</span><p>{data.nextExperiment.method}</p></div>
            <div className="bp-vprow"><span className="bp-vplabel">判断基準</span><p className="crit">{data.nextExperiment.criteria}</p></div>
            {data.nextExperiment.period && <span className="bp-vpperiod">{data.nextExperiment.period}</span>}
          </div>
        </div>
      )}

      {data.strategicValue && <Callout label="数字に出ない価値">{data.strategicValue}</Callout>}

      <div className="bp-actionbar split">
        <button className="bp-ghost" onClick={onBack}>← 一覧へ戻る</button>
        <div className="bp-actionright">
          <button className="bp-ghost" onClick={onInterview} disabled={interviewLoading}>{interviewLoading ? "準備中…" : "壁打ちで情報を足す"}</button>
          <button className="bp-ghost" onClick={onSim}>売上シミュレーターで深掘る</button>
          <button className="bp-cta" onClick={onExit}>撤退ラインを決める →</button>
        </div>
      </div>
    </section>
  );
}

/* ========================= 撤退ライン ＆ 成功確率 ========================= */
function ExitGateTable({ el, readOnly, onGate, onActual }) {
  const cell = (i, k, type) => readOnly
    ? <span>{type === "number" ? num(el.gates[i][k]) : el.gates[i][k]}</span>
    : <input className="bp-exin" type={type || "text"} value={el.gates[i][k] ?? ""} onChange={(e) => onGate(i, k, e.target.value)} />;
  return (
    <div className="bp-extablewrap">
      <table className="bp-extable">
        <thead><tr><th>時期</th><th>ゲート</th><th>測る指標</th><th className="go">継続ライン</th><th className="kill">撤退ライン</th>{!readOnly && <th>実績</th>}{!readOnly && <th>判定</th>}</tr></thead>
        <tbody>
          {el.gates.map((g, i) => {
            const v = gateVerdict(g, (el.actuals || {})[i]); const m = v && GATE_META[v];
            const cmpGo = g.direction === "down" ? "≦" : "≧", cmpKill = g.direction === "down" ? "≧" : "≦";
            return (
              <tr key={i}>
                <td className="wh">{readOnly ? g.month + "ヶ月" : <span className="bp-exunit">{cell(i, "month", "number")}ヶ月</span>}</td>
                <td>{cell(i, "name")}{g.why && <em className="bp-exwhy">{g.why}</em>}</td>
                <td>{cell(i, "metric")}<span className="bp-exunit sm">単位 {cell(i, "unit")}</span></td>
                <td className="go"><span className="bp-exunit">{cmpGo}{cell(i, "go", "number")}</span></td>
                <td className="kill"><span className="bp-exunit">{cmpKill}{cell(i, "kill", "number")}</span>{g.pivot && <em className="bp-exwhy">中間なら：{g.pivot}</em>}</td>
                {!readOnly && <td><input className="bp-exin actual" type="number" placeholder="—" value={(el.actuals || {})[i] ?? ""} onChange={(e) => onActual(i, e.target.value)} /></td>}
                {!readOnly && <td>{m ? <span className={"bp-gchip " + m.cls} title={m.note}>{m.label}</span> : <span className="bp-gchip">未到来</span>}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function exitLineText(el) {
  const p = exitProbability(el), o = overallExit(el), lim = el.limits || {};
  return "【" + el.name + "】撤退ライン（" + (el.agreedAt ? el.agreedAt + " 合意" : "作成 " + el.createdAt) + (el.owner ? "／判断者：" + el.owner : "") + "）\n\n" +
    "■ 成功確率：" + p.now + "%（現状 " + p.base + "% ＋打ち手 " + p.add + "pt）\n" + (el.data.probabilityBasis || "") + "\n\n" +
    "■ 撤退ライン（ステージゲート）\n" + el.gates.map((g, i) => {
      const v = gateVerdict(g, (el.actuals || {})[i]);
      return "・" + g.month + "ヶ月目「" + g.name + "」" + g.metric + "：継続 " + (g.direction === "down" ? "≦" : "≧") + g.go + (g.unit || "") +
        "／撤退 " + (g.direction === "down" ? "≧" : "≦") + g.kill + (g.unit || "") + (v ? "　→ 実績 " + el.actuals[i] + (g.unit || "") + "：" + GATE_META[v].label : "");
    }).join("\n") + "\n\n" +
    "■ ゲートに関係なく撤退する上限\n・累計投資 " + yen(lim.maxInvestment) + "／期間 " + (lim.deadlineMonths || "—") + "ヶ月／工数 " + (lim.maxPeopleMonths || "—") + "人月\n\n" +
    "■ 現在の判定：" + (o.v ? GATE_META[o.v].label : "判定前") + "（" + o.reasons.join("、") + "）\n\n" +
    "■ 成功確率を上げる打ち手\n" + (el.data.levers || []).map((l, i) => ((el.checked || {})[i] ? "☑ " : "☐ ") + l.action + "（+" + l.gain + "pt／" + (l.when || "") + "）").join("\n") + "\n\n" +
    "■ 撤退する場合\n" + (el.data.exitPlan || "") + "\n";
}

function ExitLine({ el, loading, onChange, onRegenerate, onBack, onDeck, deckLoading }) {
  const [copied, setCopied] = useState(false);
  if (loading || !el) {
    return (
      <section className="bp-screen">
        <div className="bp-selbanner"><Cross className="c1" /><Cross className="c2" /><span className="bp-selpill">撤退ライン</span><div><h2>成功確率と撤退ラインを設計中…</h2><p>始める前に「いつ・何が・いくつ未満なら畳むか」を数字で決めます</p></div></div>
        <Skeleton msg="成功確率の見積り・打ち手・ステージゲート・投資上限を設計中…" />
      </section>
    );
  }
  const d = el.data || {}, lim = el.limits || {}, st = el.status || {};
  const p = exitProbability(el), o = overallExit(el);
  const set = (patch) => onChange({ ...el, ...patch });
  const setGate = (i, k, v) => set({ gates: el.gates.map((g, idx) => idx === i ? { ...g, [k]: v } : g) });
  const setActual = (i, v) => set({ actuals: { ...(el.actuals || {}), [i]: v } });
  const setLim = (k, v) => set({ limits: { ...lim, [k]: v } });
  const setSt = (k, v) => set({ status: { ...st, [k]: v } });
  const toggleLever = (i) => set({ checked: { ...(el.checked || {}), [i]: !(el.checked || {})[i] } });
  const om = o.v ? GATE_META[o.v] : null;
  const pCls = p.now >= 50 ? "hi" : p.now >= 25 ? "mid" : "lo";

  function copyText() {
    navigator.clipboard.writeText(exitLineText(el)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }
  function downloadXlsx() {
    const wb = XLSX.utils.book_new();
    const gates = [["時期(月)", "ゲート", "指標", "単位", "方向", "継続ライン", "撤退ライン", "実績", "判定", "理由", "中間時のピボット案"]].concat(
      el.gates.map((g, i) => { const v = gateVerdict(g, (el.actuals || {})[i]); return [Number(g.month), g.name, g.metric, g.unit, g.direction === "down" ? "小さいほど良い" : "大きいほど良い", Number(g.go), Number(g.kill), (el.actuals || {})[i] ?? "", v ? GATE_META[v].label : "", g.why || "", g.pivot || ""]; }));
    gates.push([], ["上限", "累計投資(円)", Number(lim.maxInvestment) || "", "期間(月)", Number(lim.deadlineMonths) || "", "工数(人月)", Number(lim.maxPeopleMonths) || ""]);
    gates.push(["現在", "累計投資(円)", Number(st.spent) || "", "経過(月)", Number(st.elapsed) || "", "工数(人月)", Number(st.peopleMonths) || ""]);
    gates.push(["判定", o.v ? GATE_META[o.v].label : "判定前", o.reasons.join("、")]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(gates), "撤退ライン");
    const lev = [["実行", "打ち手", "上昇pt", "必要な工数・費用", "期限"]].concat((d.levers || []).map((l, i) => [(el.checked || {})[i] ? "☑" : "", l.action, Number(l.gain) || 0, l.cost, l.when]));
    lev.push([], ["成功確率", p.base + "% → " + p.now + "%", d.probabilityBasis || ""]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lev), "成功確率と打ち手");
    const pm = [["失敗シナリオ", "警報サイン", "予防策"]].concat((d.premortem || []).map((x) => [x.scenario, x.earlySignal, x.prevention]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pm), "プレモーテム");
    XLSX.writeFile(wb, "撤退ライン_" + el.name + ".xlsx");
  }

  return (
    <section className="bp-screen">
      <div className="bp-selbanner"><Cross className="c1" /><Cross className="c2" />
        <span className="bp-selpill">撤退ライン</span>
        <div><h2>{el.name}</h2><p>始める前に、畳む条件を数字で決めておく。{el.agreedAt ? "（" + el.agreedAt + " 合意済み）" : "（作成 " + el.createdAt + "・自動保存）"}</p></div>
      </div>

      {/* 成功確率 */}
      <div className={"bp-exprob " + pCls}>
        <div className="bp-hlead">3年で目標に届く 成功確率</div>
        <div className="bp-exprobmain">
          <div className="bp-exprobnum"><strong>{p.now}</strong><span>%</span></div>
          <div className="bp-exprobside">
            <div className="bp-exbar"><span className="base" style={{ width: p.base + "%" }} /><span className="add" style={{ width: Math.max(0, p.now - p.base) + "%" }} /></div>
            <p>現状 <b>{p.base}%</b>{p.add > 0 && <> ＋ 実行する打ち手 <b className="up">+{p.add}pt</b></>}</p>
            {d.baseRate && <p className="sub">{d.baseRate}</p>}
          </div>
        </div>
        {d.probabilityBasis && <p className="bp-hconc">{d.probabilityBasis}</p>}
        {(d.drivers || []).length > 0 && <div className="bp-exdrivers">{d.drivers.map((x, i) => <span key={i}>{x.factor}<b>{x.impact}</b></span>)}</div>}
      </div>

      {/* 打ち手 */}
      <div className="bp-block">
        <div className="bp-matrixhead"><h3>成功確率を上げる打ち手</h3><span className="bp-blocknote">やると決めたものにチェック → 成功確率に反映</span></div>
        <div className="bp-exlevers">
          {(d.levers || []).map((l, i) => (
            <label key={i} className={"bp-exlever" + ((el.checked || {})[i] ? " on" : "")}>
              <input type="checkbox" checked={!!(el.checked || {})[i]} onChange={() => toggleLever(i)} />
              <span className="bp-exlvtext"><strong>{l.action}</strong><em>{[l.cost, l.when].filter(Boolean).join("／")}</em></span>
              <span className="bp-exgain">+{l.gain}pt</span>
            </label>
          ))}
        </div>
      </div>

      {/* 撤退ライン */}
      <div className="bp-block">
        <div className="bp-matrixhead"><h3>撤退ライン（ステージゲート）</h3><span className="bp-blocknote">各ゲートで実績を入れると機械判定。閾値は編集できます</span></div>
        <ExitGateTable el={el} onGate={setGate} onActual={setActual} />
        <div className="bp-exlimits">
          <span className="bp-exlimhd">ゲートに関係なく撤退する上限</span>
          <label>累計投資<input className="bp-exin" type="number" value={lim.maxInvestment ?? ""} onChange={(e) => setLim("maxInvestment", e.target.value)} /><em>{yen(lim.maxInvestment)}</em></label>
          <label>期間<input className="bp-exin" type="number" value={lim.deadlineMonths ?? ""} onChange={(e) => setLim("deadlineMonths", e.target.value)} /><em>ヶ月</em></label>
          <label>投入工数<input className="bp-exin" type="number" value={lim.maxPeopleMonths ?? ""} onChange={(e) => setLim("maxPeopleMonths", e.target.value)} /><em>人月</em></label>
          {lim.note && <p className="bp-scbasis">{lim.note}</p>}
        </div>
      </div>

      {/* 現在の判定 */}
      <div className={"bp-exverdict " + (om ? om.cls : "")}>
        <div className="bp-exvin">
          <span className="bp-exlimhd">いまの状況（定例で更新）</span>
          <label>経過<input className="bp-exin" type="number" value={st.elapsed ?? ""} onChange={(e) => setSt("elapsed", e.target.value)} /><em>ヶ月</em></label>
          <label>累計投資<input className="bp-exin" type="number" value={st.spent ?? ""} onChange={(e) => setSt("spent", e.target.value)} /><em>{yen(st.spent)}</em></label>
          <label>投入工数<input className="bp-exin" type="number" value={st.peopleMonths ?? ""} onChange={(e) => setSt("peopleMonths", e.target.value)} /><em>人月</em></label>
        </div>
        <div className="bp-exvout">
          <span>現在の判定</span>
          <strong>{om ? om.label : "判定前"}</strong>
          <p>{o.reasons.join("、")}{om ? "。" + om.note : ""}</p>
        </div>
      </div>

      {/* プレモーテム */}
      {(d.premortem || []).length > 0 && (
        <div className="bp-block">
          <div className="bp-matrixhead"><h3>プレモーテム（3年後に失敗していたら、なぜか）</h3><span className="bp-blocknote">警報サインが出たら、ゲートを待たずに議題に上げる</span></div>
          <div className="bp-expm">
            {d.premortem.map((x, i) => (
              <div className="bp-expmrow" key={i}>
                <p className="sc">{x.scenario}</p>
                <p><span>警報サイン</span>{x.earlySignal}</p>
                <p><span>予防策</span>{x.prevention}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 合意 */}
      <div className="bp-block">
        <div className="bp-matrixhead"><h3>撤退の段取りと合意</h3></div>
        {d.exitPlan && <Callout label="撤退する場合の顧客・資産・人の扱い">{d.exitPlan}</Callout>}
        {d.decisionOwner && <p className="bp-scbasis">推奨：{d.decisionOwner}</p>}
        <div className="bp-exagree">
          <label>撤退判断を下す人<input className="bp-exin wide" type="text" placeholder="例：社長＋新規事業室長（月次定例）" value={el.owner || ""} onChange={(e) => set({ owner: e.target.value })} /></label>
          {el.agreedAt
            ? <button className="bp-ghost small" onClick={() => set({ agreedAt: "" })}>合意済み（{el.agreedAt}）・取り消す</button>
            : <button className="bp-cta small" onClick={() => set({ agreedAt: new Date().toISOString().slice(0, 10) })}>この撤退ラインで合意する</button>}
        </div>
      </div>

      <div className="bp-actionbar split">
        <button className="bp-ghost" onClick={onBack}>← 戻る</button>
        <div className="bp-actionright">
          <button className="bp-ghost" onClick={onRegenerate}>↻ AIで作り直す</button>
          <button className="bp-ghost" onClick={copyText}>{copied ? "コピーしました ✓" : "テキストでコピー"}</button>
          <button className="bp-ghost" onClick={downloadXlsx}>Excelで保存</button>
          {onDeck && <button className="bp-cta" onClick={onDeck} disabled={deckLoading}>{deckLoading ? "作成中…" : "撤退ライン込みでピッチへ →"}</button>}
        </div>
      </div>
    </section>
  );
}

/* ========================= CSS ========================= */
const CSS = `
.bp-root{
  --navy:#1C2B3A; --navy-2:#13202D; --navy-3:#2A3D50; --steel:#8A97A2; --steel-l:#C3CCD3;
  --orange:#1668B3; --orange-soft:#E7F0F8; --blue-mid:#5C87BC;
  --warn:#C4762A; --danger:#C0503A;
  --canvas:#F5F7F8; --paper:#FFFFFF; --line:#D9E0E5; --ink:#17212B; --ink-soft:#5C6B78;
  --font-jp:'Zen Kaku Gothic New',system-ui,-apple-system,sans-serif;
  --font-num:'Space Grotesk',var(--font-jp);
  font-family:var(--font-jp); color:var(--ink); min-height:100vh;
  background:var(--canvas);
  background-image:linear-gradient(rgba(23,33,43,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(23,33,43,.03) 1px,transparent 1px);
  background-size:28px 28px; -webkit-font-smoothing:antialiased;
}
.bp-root *{box-sizing:border-box;}
.bp-root button{font-family:inherit; cursor:pointer;}
.bp-root h1,.bp-root h2,.bp-root h3{margin:0; line-height:1.25;}
.bp-root p{margin:0;}
.bp-cross{position:absolute; color:rgba(255,255,255,.35); font-size:13px; pointer-events:none;}
.bp-cross.c1{top:8px; left:10px;} .bp-cross.c2{bottom:8px; right:10px;}

/* header */
.bp-top{position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:22px; flex-wrap:wrap;
  padding:14px 30px; background:var(--navy); color:#fff; overflow:hidden;
  background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px); background-size:22px 22px;}
.bp-brand{display:flex; flex-direction:column; cursor:pointer; line-height:1.15;}
.bp-wm{font-weight:900; font-size:19px; letter-spacing:1px;}
.bp-wm em{font-style:normal; font-weight:700; font-size:10px; letter-spacing:2px; color:var(--steel-l); margin-left:8px;}
.bp-wmsub{font-size:10.5px; color:var(--steel-l); letter-spacing:.3px; margin-top:2px;}
.bp-topright{margin-left:auto; display:flex; align-items:center; gap:12px;}
.bp-home{display:inline-flex; align-items:center; gap:6px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.25); color:#fff; font-family:var(--font-jp); font-size:12.5px; font-weight:700; padding:7px 14px; border-radius:5px; transition:background .15s, border-color .15s;}
.bp-home:hover{background:var(--orange); border-color:transparent;}
.bp-homeicon{font-size:14px; line-height:1;}
.bp-spec{font-family:var(--font-num); font-size:11px; color:var(--steel); letter-spacing:1px; border:1px solid rgba(255,255,255,.2); padding:3px 8px; border-radius:3px;}

/* horizontal step progress bar */
.bp-progress{background:var(--paper); border-bottom:1px solid var(--line); box-shadow:0 1px 0 rgba(22,35,63,.02);}
.bp-progwrap{max-width:1140px; margin:0 auto; display:flex; align-items:center; gap:20px; padding:14px 24px; overflow-x:auto;}
.bp-progcount{display:flex; align-items:baseline; gap:3px; font-family:var(--font-num); color:var(--ink-soft); white-space:nowrap; flex-shrink:0;}
.bp-progcount b{color:var(--orange); font-size:18px; font-weight:700;}
.bp-progcount i{font-style:normal; font-size:12px;}
.bp-progsteps{display:flex; align-items:center; flex:1; list-style:none; margin:0; padding:0; min-width:520px;}
.bp-progstep{display:flex; align-items:center; gap:9px; flex:1;}
.bp-progstep:last-child{flex:0 0 auto;}
.bp-progdot{width:28px; height:28px; border-radius:50%; display:grid; place-items:center; font-family:var(--font-num); font-weight:700; font-size:13px; flex-shrink:0; transition:all .2s;}
.bp-proglabel{font-size:13px; font-weight:700; white-space:nowrap;}
.bp-progline{flex:1; height:2px; background:var(--line); margin:0 12px; min-width:20px; border-radius:1px;}
.bp-progstep.todo .bp-progdot{background:#fff; border:1.5px solid var(--line); color:var(--steel);}
.bp-progstep.todo .bp-proglabel{color:var(--ink-soft);}
.bp-progstep.on .bp-progdot{background:var(--navy); color:#fff; box-shadow:0 0 0 4px rgba(22,35,63,.12);}
.bp-progstep.on .bp-proglabel{color:var(--ink);}
.bp-progstep.done .bp-progdot{background:var(--orange); color:#fff;}
.bp-progstep.done .bp-proglabel{color:var(--ink);}
.bp-progstep.done .bp-progline{background:var(--orange);}
.bp-stepper{display:flex; gap:5px; margin-left:auto;}
.bp-stepitem{display:flex; align-items:center; gap:7px; padding:5px 12px 5px 6px; border-radius:4px; opacity:.5;}
.bp-stepitem.on{opacity:1; background:rgba(232,112,28,.18);}
.bp-stepitem.done{opacity:.85;}
.bp-stepnum{font-family:var(--font-num); font-size:11px; font-weight:700; width:24px; height:22px; display:grid; place-items:center; background:rgba(255,255,255,.12); border-radius:3px;}
.bp-stepitem.on .bp-stepnum{background:var(--orange);}
.bp-stepitem.done .bp-stepnum{background:#2A7D5A;}
.bp-steplabel{font-size:12.5px; font-weight:700;}

.bp-error{background:#FBE3DA; color:#8A3410; padding:11px 22px; font-size:13.5px; display:flex; align-items:center; gap:12px; border-bottom:1px solid #EEBBA4;}
.bp-errclose{margin-left:auto; background:none; border:none; font-size:18px; color:#8A3410;}
.bp-main{max-width:1140px; margin:0 auto; padding:30px 24px 80px;}

/* buttons */
.bp-cta{background:var(--orange); color:#fff; border:none; font-size:16px; font-weight:900; padding:14px 28px; border-radius:6px; transition:transform .12s, box-shadow .12s; box-shadow:0 5px 16px rgba(232,112,28,.32);}
.bp-cta:hover{transform:translateY(-1px); box-shadow:0 9px 22px rgba(232,112,28,.4);}
.bp-cta:disabled{background:var(--steel); box-shadow:none; cursor:not-allowed; transform:none;}
.bp-cta.small{font-size:13px; padding:9px 18px;}
.bp-ghost{background:var(--paper); border:1px solid var(--line); color:var(--ink); font-size:13.5px; font-weight:700; padding:11px 20px; border-radius:6px; transition:border-color .15s, color .15s;}
.bp-ghost:hover{border-color:var(--navy); }
.bp-textbtn{background:none; border:none; color:var(--ink-soft); font-size:12.5px; font-weight:700; padding:4px;}
.bp-textbtn:hover{color:var(--orange);}
.bp-actionbar{display:flex; justify-content:flex-end; margin-top:28px;}
.bp-actionbar.left{justify-content:flex-start;}
.bp-actionbar.split{justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;}
.bp-actionright{display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px;}
.bp-corner{position:absolute; bottom:0; right:0; width:0; height:0; border-style:solid; border-width:0 0 14px 14px; border-color:transparent transparent var(--orange) transparent;}

/* intro */
.bp-intro{position:relative;}
.bp-ruler{display:flex; gap:0; justify-content:space-between; max-width:560px; font-family:var(--font-num); font-size:10px; color:var(--steel); border-bottom:1px solid var(--line); padding-bottom:4px; margin-bottom:26px;}
.bp-ruler span{position:relative;} .bp-ruler span:before{content:""; position:absolute; bottom:-5px; left:0; width:1px; height:5px; background:var(--steel);}
.bp-hero{max-width:730px;}
.bp-tag{display:inline-block; background:var(--navy); color:#fff; font-size:11.5px; font-weight:700; padding:5px 12px; border-radius:3px; letter-spacing:.4px;}
.bp-tag.light{background:rgba(255,255,255,.14);}
.bp-h1{font-size:clamp(28px,4.6vw,48px); font-weight:900; letter-spacing:-.5px; margin-top:18px;}
.bp-h1 em{font-style:normal; color:var(--navy); background:linear-gradient(transparent 62%, var(--orange-soft) 62%);}
.bp-uline{width:64px; height:4px; background:var(--orange); margin:20px 0;}
.bp-uline.sm{width:44px; height:3px; margin:10px 0 12px;}
.bp-lead{font-size:15.5px; line-height:1.85; color:var(--ink-soft); max-width:660px;}
.bp-lead strong{color:var(--ink);}
.bp-note{margin-top:14px; font-size:12.5px; color:var(--ink-soft); font-weight:700;}
.bp-flow{display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-top:50px;}
.bp-flowcard{position:relative; background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:20px 18px; overflow:hidden;}
.bp-flownum{font-family:var(--font-num); font-size:13px; font-weight:700; color:var(--orange);}
.bp-flowcard h3{font-size:15.5px; margin:10px 0 8px;}
.bp-flowcard p{font-size:12.5px; line-height:1.7; color:var(--ink-soft);}

/* section labels */
.bp-seclabel{margin-bottom:24px;}
.bp-seclabel.inline{margin-bottom:0;}
.bp-secrow{display:flex; align-items:center; gap:12px; flex-wrap:wrap;}
.bp-sectag{font-family:var(--font-num); font-size:11px; font-weight:700; color:#fff; background:var(--navy); padding:4px 10px; border-radius:3px; letter-spacing:.5px;}
.bp-seclabel h2{font-size:24px; font-weight:900; letter-spacing:-.3px;}
.bp-seclabel p{font-size:13.5px; line-height:1.7; color:var(--ink-soft); max-width:720px;}
.bp-seclabel.inline .bp-uline{display:none;}

/* choices */
.bp-choicerow{display:grid; grid-template-columns:2fr 1fr; gap:16px; margin-bottom:20px;}
.bp-choicehd{display:block; font-size:12px; font-weight:700; color:var(--ink-soft); margin-bottom:8px;}
.bp-chips{display:flex; gap:8px; flex-wrap:wrap;}
.bp-chip{flex:1; min-width:120px; text-align:left; background:var(--paper); border:1.5px solid var(--line); border-radius:7px; padding:12px 14px; transition:all .15s;}
.bp-chip strong{display:block; font-size:14px;} .bp-chip em{font-style:normal; font-size:11px; color:var(--ink-soft); display:block; margin-top:3px;}
.bp-chip.on{border-color:var(--orange); background:var(--orange-soft);}
.bp-chip.target{flex:1; min-width:0;}
.bp-choice.full{margin-bottom:20px;}
.bp-themes{display:grid; grid-template-columns:repeat(3,1fr); gap:10px;}
.bp-theme{position:relative; text-align:left; background:var(--paper); border:1.5px solid var(--line); border-radius:9px; padding:16px 16px 14px; transition:all .15s;}
.bp-theme strong{display:block; font-size:15px;} .bp-theme em{font-style:normal; font-size:11.5px; color:var(--ink-soft); display:block; margin-top:5px; line-height:1.5;}
.bp-theme.on{border-color:var(--orange); background:var(--orange-soft); box-shadow:0 4px 14px rgba(22,104,179,.12);}
.bp-bestbadge{position:absolute; top:-9px; left:14px; font-size:10px; font-weight:700; color:#fff; background:var(--orange); padding:2px 9px; border-radius:4px; letter-spacing:.3px;}
.bp-themeq{display:flex; align-items:center; gap:12px; margin-top:12px; background:var(--navy); color:#fff; border-radius:9px; padding:14px 18px;}
.bp-themeq .bp-qmark{font-family:var(--font-num); font-size:16px; font-weight:700; color:#fff; background:var(--orange); width:30px; height:30px; border-radius:50%; display:grid; place-items:center; flex-shrink:0;}
.bp-themeq p{font-size:15px; font-weight:700; line-height:1.6;}

/* input */
.bp-inputgrid{display:grid; grid-template-columns:1fr 1fr; gap:16px;}
.bp-field{display:flex; flex-direction:column; gap:7px;}
.bp-field.big{grid-column:1/-1;}
.bp-flabel{font-size:13px; font-weight:700;}
.bp-flabel em{font-style:normal; font-weight:400; color:var(--ink-soft); font-size:12px; margin-left:6px;}
.bp-field textarea{font-family:inherit; font-size:14px; line-height:1.6; color:var(--ink); padding:12px 14px; border:1px solid var(--line); border-radius:6px; background:var(--paper); resize:vertical; transition:border-color .15s, box-shadow .15s;}
.bp-field textarea:focus{outline:none; border-color:var(--orange); box-shadow:0 0 0 3px var(--orange-soft);}
.bp-uploadrow{grid-column:1/-1; display:flex; gap:14px; flex-wrap:wrap;}
.bp-upload{flex:1; min-width:280px; display:flex; align-items:center; gap:14px; padding:15px 18px; border:1.5px dashed var(--line); border-radius:6px; background:var(--paper); transition:border-color .15s, background .15s;}
.bp-upload:hover{border-color:var(--orange);}
.bp-upicon{font-size:24px; color:var(--orange);}
.bp-upload strong{font-size:14px; display:block;} .bp-upload p{font-size:12px; color:var(--ink-soft); margin-top:3px;}

/* sort */
.bp-sortbar{display:flex; align-items:center; gap:8px; margin-bottom:18px; flex-wrap:wrap;}
.bp-sortlabel{font-size:12px; color:var(--ink-soft);}
.bp-sortbtn{background:var(--paper); border:1px solid var(--line); color:var(--ink-soft); font-size:13px; font-weight:700; padding:8px 15px; border-radius:4px;}
.bp-sortbtn.on{background:var(--navy); color:#fff; border-color:var(--navy);}

/* candidates */
.bp-candgrid{display:grid; grid-template-columns:repeat(3,1fr); gap:16px; align-items:start;}
.bp-cand{position:relative; background:var(--paper); border:1px solid var(--line); border-radius:9px; padding:20px; display:flex; flex-direction:column; gap:15px; overflow:hidden;}
.bp-cand.rank-1{border-color:var(--orange); box-shadow:0 6px 24px rgba(232,112,28,.14);}
.bp-cand.rank-1:after{content:"TOP"; position:absolute; top:14px; right:0; background:var(--orange); color:#fff; font-family:var(--font-num); font-size:10px; font-weight:700; padding:2px 10px; border-radius:3px 0 0 3px;}
.bp-candhead{display:flex; gap:12px; align-items:flex-start;}
.bp-rankbadge{font-family:var(--font-num); font-size:30px; font-weight:700; line-height:1; color:var(--navy);}
.bp-rankbadge small{font-size:11px; color:var(--ink-soft); margin-left:1px;}
.rank-1 .bp-rankbadge{color:var(--orange);}
.bp-candtitle h3{font-size:17px; font-weight:900;} .bp-candtitle p{font-size:12px; color:var(--orange); margin-top:4px; line-height:1.5;}
.bp-figs{display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; padding:13px 0; border-top:1px solid var(--canvas); border-bottom:1px solid var(--canvas);}
.bp-fig{display:flex; flex-direction:column; gap:3px;}
.bp-figlabel{font-size:10px; color:var(--ink-soft);}
.bp-figval{font-family:var(--font-num); font-size:16px; font-weight:700;}
.bp-figval.rev{color:var(--navy);} .bp-figval.cost{color:var(--orange);}
.bp-fit{}
.bp-fithd{display:flex; justify-content:space-between; font-size:11px; margin-bottom:4px;}
.bp-fithd span{color:var(--ink-soft);} .bp-fithd strong{font-family:var(--font-num);}
.bp-fittrack{height:8px; background:var(--canvas); border-radius:4px; overflow:hidden;}
.bp-fitfill{height:100%; background:var(--blue-mid); border-radius:4px;}
.bp-fitfill.ok{background:var(--orange);}
.bp-scores{display:flex; flex-direction:column; gap:6px;}
.bp-scorerow{display:flex; align-items:center; gap:8px;}
.bp-scorename{font-size:11px; color:var(--ink-soft); width:44px;}
.bp-scoretrack{flex:1; height:6px; background:var(--canvas); border-radius:3px; overflow:hidden;}
.bp-scorefill{display:block; height:100%; background:var(--navy); border-radius:3px;}
.bp-scorenum{font-family:var(--font-num); font-size:12px; font-weight:600; width:12px; text-align:right;}
.bp-scorerow.comp{margin-top:2px; padding-top:6px; border-top:1px dashed var(--line);}
.bp-compval{margin-left:auto; font-family:var(--font-num); font-size:17px; font-weight:700; color:var(--orange);}
.bp-compval small{font-size:11px; color:var(--ink-soft);}
.bp-canddetail{display:flex; flex-direction:column; gap:8px; margin:0;}
.bp-canddetail>div{display:grid; grid-template-columns:44px 1fr; gap:8px;}
.bp-canddetail dt{font-size:11px; color:var(--ink-soft); font-weight:700;}
.bp-canddetail dd{margin:0; font-size:12.5px; line-height:1.55;}
.bp-canddetail .pro dd{color:#2A7D5A;} .bp-canddetail .risk dd{color:var(--orange);}
.bp-selectbtn{margin-top:auto; background:var(--navy); color:#fff; border:none; font-size:13.5px; font-weight:700; padding:12px; border-radius:6px; transition:background .15s;}
.bp-selectbtn:hover{background:var(--orange);}
.rank-1 .bp-selectbtn{background:var(--orange);}

/* selected banner */
.bp-selbanner{position:relative; display:flex; align-items:center; gap:16px; background:var(--navy); color:#fff; padding:20px 24px; border-radius:8px; margin-bottom:20px; overflow:hidden;
  background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px); background-size:22px 22px;}
.bp-selpill{background:var(--orange); font-size:11px; font-weight:700; padding:4px 11px; border-radius:3px; flex-shrink:0;}
.bp-selbanner h2{font-size:21px; font-weight:900;} .bp-selbanner p{font-size:13px; color:var(--steel-l); margin-top:3px;}

/* verify map */
.bp-map{background:var(--paper); border:1px solid var(--line); border-radius:9px; padding:22px; margin-bottom:18px;}
.bp-maphead{display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap; margin-bottom:18px;}
.bp-stations{display:flex; align-items:stretch; gap:0; flex-wrap:wrap;}
.bp-station{flex:1; min-width:120px; display:flex; align-items:center; gap:10px; background:var(--canvas); border:1px solid transparent; border-radius:6px; padding:11px 12px; text-align:left; transition:all .15s;}
.bp-station:hover{background:#fff; border-color:var(--line);}
.bp-stnum{font-family:var(--font-num); font-size:14px; font-weight:700; width:26px; height:26px; display:grid; place-items:center; background:var(--navy); color:#fff; border-radius:50%; flex-shrink:0;}
.bp-sttext{flex:1;} .bp-sttext strong{display:block; font-size:12.5px; font-weight:700;} .bp-sttext em{font-style:normal; font-size:10.5px; color:var(--ink-soft);}
.bp-ststat{font-weight:700; color:var(--ink-soft);}
.bp-station.st-done{background:#E9F3EE;} .bp-station.st-done .bp-stnum{background:#2A7D5A;} .bp-station.st-done .bp-ststat{color:#2A7D5A;}
.bp-station.st-loading .bp-ststat{color:var(--orange);}
.bp-stchev{display:flex; align-items:center; color:var(--steel); font-size:20px; padding:0 3px;}

/* sections */
.bp-sections{display:flex; flex-direction:column; gap:10px;}
.bp-section{background:var(--paper); border:1px solid var(--line); border-radius:8px; overflow:hidden;}
.bp-sechead{width:100%; display:flex; align-items:center; gap:14px; padding:16px 20px; background:none; border:none; text-align:left;}
.bp-secn{font-family:var(--font-num); font-size:18px; font-weight:700; color:var(--steel-l);}
.bp-sectitle{flex:1;} .bp-sectitle strong{display:block; font-size:15.5px; font-weight:900;} .bp-sectitle em{font-style:normal; font-size:12px; color:var(--ink-soft);}
.bp-secstatus{font-size:11px; font-weight:700; padding:3px 10px; border-radius:12px; background:var(--canvas); color:var(--ink-soft);}
.bp-secstatus.done{background:#E9F3EE; color:#2A7D5A;} .bp-secstatus.loading{background:var(--orange-soft); color:var(--orange);} .bp-secstatus.error{background:#FBE3DA; color:#8A3410;}
.bp-chevron{font-size:18px; color:var(--ink-soft); transition:transform .2s;} .bp-chevron.up{transform:rotate(180deg);}
.bp-secbody{padding:2px 20px 22px; border-top:1px solid var(--canvas);}
.bp-secempty{display:flex; flex-direction:column; align-items:flex-start; gap:12px; padding:16px 0 4px;}
.bp-secempty p{font-size:13.5px; color:var(--ink-soft);}
.bp-secerror{display:flex; flex-direction:column; align-items:flex-start; gap:12px; padding:12px 0;} .bp-secerror p{font-size:13.5px; color:var(--orange);}
.bp-secfoot{margin-top:14px; display:flex; justify-content:flex-end;}
.bp-keyline{text-align:center; font-size:17px; font-weight:900; color:#fff; background:var(--navy); border-radius:8px; padding:18px; margin-top:18px; letter-spacing:.5px;}
.bp-keyline:before{content:"❱ "; color:var(--orange);}

/* chapter generic */
.bp-cv{display:flex; flex-direction:column; gap:15px; padding-top:14px;}
.bp-cv2{display:grid; grid-template-columns:1fr 1fr; gap:14px;}
.bp-panel{background:var(--canvas); border-radius:8px; padding:16px 18px;}
.bp-panelhd{display:block; font-size:11.5px; font-weight:700; color:var(--ink-soft); margin-bottom:11px;}
.bp-callout{background:var(--canvas); border-left:3px solid var(--steel); border-radius:0 7px 7px 0; padding:13px 16px;}
.bp-callout.accent{background:var(--orange-soft); border-left-color:var(--orange);}
.bp-calloutlabel{display:block; font-size:11px; font-weight:700; color:var(--ink-soft); margin-bottom:5px;}
.bp-callout.accent .bp-calloutlabel{color:var(--orange);}
.bp-callout p{font-size:14px; line-height:1.7;}
.bp-infolist{background:var(--canvas); border-radius:8px; padding:15px 18px;}
.bp-infohd{display:block; font-size:11.5px; font-weight:700; color:var(--ink-soft); margin-bottom:7px;}
.bp-infolist ul{margin:0; padding-left:18px;} .bp-infolist li{font-size:13px; line-height:1.8;}
.bp-hint{font-size:12.5px; color:var(--orange); font-weight:700;}

/* market */
.bp-marketbars{display:flex; flex-direction:column; gap:16px;}
.bp-mbhead{display:flex; align-items:baseline; gap:12px; margin-bottom:6px;}
.bp-mbtag{font-family:var(--font-num); font-size:12px; font-weight:700; color:#fff; padding:3px 10px; border-radius:3px;}
.bp-mbtag.tam{background:var(--steel);} .bp-mbtag.sam{background:var(--blue-mid);} .bp-mbtag.som{background:var(--navy);}
.bp-mbval{font-family:var(--font-num); font-size:21px; font-weight:700;}
.bp-mbtrack{height:13px; background:var(--canvas); border-radius:3px; overflow:hidden;}
.bp-mbfill{height:100%;} .bp-mbfill.tam{background:var(--steel);} .bp-mbfill.sam{background:var(--blue-mid);} .bp-mbfill.som{background:var(--navy);}
.bp-mbnote{font-size:12.5px; color:var(--ink-soft); margin-top:6px; line-height:1.6;}

/* customer */
.bp-persona{display:flex; gap:16px; align-items:center; background:var(--navy); color:#fff; border-radius:8px; padding:16px 18px;}
.bp-avatar{width:46px; height:46px; border-radius:8px; background:var(--orange); display:grid; place-items:center; font-family:var(--font-num); font-size:22px; font-weight:700; flex-shrink:0;}
.bp-persona strong{font-size:16px;} .bp-persona p{font-size:12.5px; color:var(--steel-l); margin-top:3px; line-height:1.6;}
.bp-ctx{font-size:11.5px !important;}
.bp-jobs{display:flex; flex-direction:column; gap:9px;}
.bp-job{background:#fff; border-radius:7px; padding:11px 14px;}
.bp-jobmain{font-size:13.5px; font-weight:700;}
.bp-jobmeta{display:flex; gap:14px; margin-top:5px; flex-wrap:wrap;}
.bp-jobmeta span{font-size:12px;} .bp-jobmeta .pain{color:var(--orange);} .bp-jobmeta .gain{color:#2A7D5A;}
.bp-table{width:100%; border-collapse:collapse; font-size:12.5px;}
.bp-table th{text-align:left; font-size:11px; color:var(--ink-soft); font-weight:700; padding:7px 10px; border-bottom:2px solid var(--line);}
.bp-table td{padding:9px 10px; border-bottom:1px solid #fff; line-height:1.55; vertical-align:top;}
.bp-table td.nm{font-weight:700;} .bp-table td.edge{color:var(--orange); font-weight:500;}
.bp-posmap{display:flex; flex-direction:column; gap:12px;}
.bp-posaxes{position:relative; height:140px; background:#fff; border-radius:8px; border:1px solid var(--line);}
.bp-posx{position:absolute; right:12px; top:50%; transform:translateY(-50%); font-size:11px; color:var(--ink-soft);}
.bp-posy{position:absolute; left:50%; top:8px; transform:translateX(-50%); font-size:11px; color:var(--ink-soft);}
.bp-posaxes:before{content:""; position:absolute; left:0; right:0; top:50%; height:1px; background:var(--line);}
.bp-posaxes:after{content:""; position:absolute; top:0; bottom:0; left:50%; width:1px; background:var(--line);}
.bp-posdot{position:absolute; left:70%; top:30%; width:16px; height:16px; border-radius:50%; background:var(--orange); box-shadow:0 0 0 5px var(--orange-soft);}
.bp-posnote{font-size:13px; line-height:1.7;}

/* revenue structure */
.bp-who3{display:grid; grid-template-columns:repeat(3,1fr); gap:10px;}
.bp-whocell{background:var(--navy); color:#fff; border-radius:8px; padding:14px 16px;}
.bp-whocell span{font-size:11px; color:var(--orange); font-weight:700; display:block; margin-bottom:5px;}
.bp-whocell strong{font-size:14px; font-weight:700; line-height:1.5;}
.bp-pairs{display:flex; flex-direction:column; gap:9px;}
.bp-pair{display:flex; flex-direction:column; gap:2px; padding-left:12px; border-left:2px solid var(--line);}
.bp-pair.rev{border-left-color:var(--navy);} .bp-pair.cost{border-left-color:var(--orange);}
.bp-pair strong{font-size:13.5px;} .bp-pair span{font-size:12px; color:var(--ink-soft); line-height:1.55;}

/* forecast */
.bp-formula{display:flex; align-items:center; gap:10px; flex-wrap:wrap; background:var(--navy); border-radius:8px; padding:18px 20px; color:#fff; justify-content:center;}
.bp-fx{font-weight:900; font-size:16px;}
.bp-fx.v{display:flex; flex-direction:column; align-items:center; font-family:var(--font-num); font-size:18px; background:rgba(255,255,255,.08); padding:8px 14px; border-radius:6px;}
.bp-fx.v em{font-style:normal; font-family:var(--font-jp); font-size:10px; color:var(--steel-l); margin-bottom:2px;}
.bp-op{font-size:20px; color:var(--orange); font-weight:700;}

/* simulator */
.bp-sim{display:flex; flex-direction:column; gap:16px; padding-top:14px;}
.bp-simgrid{display:grid; grid-template-columns:1.1fr 1fr; gap:18px;}
.bp-controls{display:flex; flex-direction:column; gap:12px;}
.bp-ctrl{}
.bp-ctrlhd{display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px;}
.bp-ctrlhd span{font-size:12px; font-weight:700;}
.bp-ctrlval{font-family:var(--font-num); font-size:15px; font-weight:700; color:var(--navy);}
.bp-ctrlval em{font-style:normal; font-size:11px; color:var(--ink-soft); margin-left:2px;}
.bp-ctrl input[type=range]{width:100%; accent-color:var(--orange); height:4px;}
.bp-ctrlnum{width:100%; margin-top:5px; font-family:var(--font-num); font-size:13px; padding:6px 10px; border:1px solid var(--line); border-radius:5px; background:var(--paper);}
.bp-ctrlnum:focus{outline:none; border-color:var(--orange);}
.bp-simout{display:flex; flex-direction:column; gap:14px;}
.bp-gauge{background:var(--navy); border-radius:8px; padding:16px 18px; color:#fff;}
.bp-gaugehd{display:flex; justify-content:space-between; align-items:baseline; font-size:12px;}
.bp-gaugehd span{color:var(--steel-l);} .bp-gaugehd strong{font-family:var(--font-num); font-size:20px;}
.bp-gaugehd strong.ok{color:var(--orange);}
.bp-gaugetrack{height:10px; background:rgba(255,255,255,.15); border-radius:5px; overflow:hidden; margin:8px 0;}
.bp-gaugefill{height:100%; background:var(--blue-mid); border-radius:5px; transition:width .2s;}
.bp-gaugefill.ok{background:var(--orange);}
.bp-gaugeval{font-family:var(--font-num); font-size:24px; font-weight:700;}
.bp-simkpis{display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;}
.bp-simkpi{background:var(--canvas); border-radius:7px; padding:11px 12px;}
.bp-simkpi span{display:block; font-size:10.5px; color:var(--ink-soft); margin-bottom:3px;}
.bp-simkpi strong{font-family:var(--font-num); font-size:15px; font-weight:700;}
.bp-simkpi strong.pos{color:#2A7D5A;} .bp-simkpi strong.neg{color:#C0392B;}
.bp-chart{background:var(--canvas); border-radius:8px; padding:14px 10px 8px;}
.bp-legend{display:flex; gap:16px; justify-content:center; margin-top:4px;}
.bp-legend span{display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-soft);}
.bp-legend i{width:11px; height:11px; border-radius:2px;}
.bp-revtable{width:100%; border-collapse:collapse; font-size:13.5px;}
.bp-revtable th{text-align:right; font-size:11px; color:var(--ink-soft); font-weight:700; padding:8px 10px; border-bottom:2px solid var(--line);}
.bp-revtable th:first-child{text-align:left;}
.bp-revtable td{text-align:right; padding:10px; border-bottom:1px solid var(--canvas); font-family:var(--font-num); font-weight:600;}
.bp-revtable td.yr{text-align:left; font-family:var(--font-jp); font-weight:700;}
.bp-revtable td.rev{color:var(--navy);} .bp-revtable td.gross{color:var(--blue-mid);} .bp-revtable td.prof{color:var(--orange);} .bp-revtable td.prof.neg{color:#C0392B;}

/* pitch */
.bp-pitchcover{position:relative; background:var(--navy); color:#fff; border-radius:9px; padding:28px 26px; margin-bottom:22px; overflow:hidden;
  background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px); background-size:22px 22px;}
.bp-pitchcover h2{font-size:26px; font-weight:900; margin-top:12px;} .bp-pitchcover p{font-size:14px; color:var(--steel-l); margin-top:6px;}
.bp-pillars{display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-bottom:26px;}
.bp-pillar{background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:18px; border-top:3px solid var(--orange);}
.bp-pillarhd{display:block; font-size:13px; font-weight:900; margin-bottom:12px;}
.bp-pillarbody{display:flex; flex-direction:column; gap:8px;}
.bp-pillarnote{font-size:12px; color:var(--ink-soft); line-height:1.6;}
.bp-metric{display:flex; justify-content:space-between; align-items:baseline; padding:7px 0; border-bottom:1px dashed var(--line);}
.bp-metric span{font-size:12px; color:var(--ink-soft);} .bp-metric strong{font-family:var(--font-num); font-size:15px; font-weight:700;}
.bp-pillarbody.kpis{gap:7px;}
.bp-kpichip{display:flex; justify-content:space-between; gap:8px; padding:8px 11px; border-radius:6px; font-size:12px;}
.bp-kpichip.sales{background:var(--orange-soft);} .bp-kpichip.action{background:var(--canvas);}
.bp-kpichip span{color:var(--ink-soft);} .bp-kpichip strong{font-family:var(--font-num); font-weight:700; text-align:right;}
.bp-plantable{width:100%; border-collapse:collapse; font-size:11.5px;}
.bp-plantable th{text-align:left; font-size:10px; color:var(--ink-soft); padding:5px 6px; border-bottom:1px solid var(--line);}
.bp-plantable td{padding:6px; border-bottom:1px solid var(--canvas); line-height:1.4; vertical-align:top;}
.bp-plantable td.wh{font-weight:700; white-space:nowrap;}

.bp-deck{display:flex; flex-direction:column; gap:11px;}
.bp-slide{position:relative; display:grid; grid-template-columns:52px 1fr; gap:18px; background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:18px 20px; overflow:hidden;}
.bp-slideno{font-family:var(--font-num); font-size:24px; font-weight:700; color:var(--steel-l);}
.bp-slidebody h3{font-size:17px; font-weight:900;}
.bp-slidesub{font-size:12.5px; color:var(--orange); margin-top:4px;}
.bp-slidebullets{margin:11px 0 0; padding-left:18px;} .bp-slidebullets li{font-size:13px; line-height:1.8;}
.bp-slidespeaker{margin-top:11px; font-size:12px; color:var(--ink-soft); line-height:1.6; background:var(--canvas); padding:9px 13px; border-radius:6px;}
.bp-slidespeaker span{display:block; font-size:10px; font-weight:700; color:var(--orange); margin-bottom:3px;}

/* verdict */
.bp-verdict{background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:22px; margin-top:22px;}
.bp-verdictbtns{display:flex; gap:10px; margin:14px 0; flex-wrap:wrap;}
.bp-vbtn{flex:1; min-width:120px; border:1.5px solid var(--line); background:var(--canvas); font-size:14px; font-weight:900; padding:14px; border-radius:6px; color:var(--ink);}
.bp-vbtn.go.on{background:#2A7D5A; color:#fff; border-color:#2A7D5A;}
.bp-vbtn.cont.on{background:var(--orange); color:#fff; border-color:var(--orange);}
.bp-vbtn.hold.on{background:var(--steel); color:#fff; border-color:var(--steel);}
.bp-verdictmemo{width:100%; font-family:inherit; font-size:13px; padding:11px 13px; border:1px solid var(--line); border-radius:6px; resize:vertical;}
.bp-verdictmemo:focus{outline:none; border-color:var(--orange);}

/* mode select */
.bp-modes{display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:28px 0 8px;}
.bp-modecard{position:relative; text-align:left; background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:26px 24px; overflow:hidden; transition:border-color .15s, box-shadow .15s, transform .12s;}
.bp-modecard:hover{border-color:var(--orange); box-shadow:0 8px 26px rgba(22,35,63,.1); transform:translateY(-2px);}
.bp-modecard.alt{border-top:3px solid var(--navy);}
.bp-modecard:not(.alt){border-top:3px solid var(--orange);}
.bp-modetag{font-family:var(--font-num); font-size:11px; font-weight:700; color:var(--orange); letter-spacing:1px;}
.bp-modecard.alt .bp-modetag{color:var(--navy);}
.bp-modecard h3{font-size:20px; font-weight:900; margin:8px 0 10px;}
.bp-modecard p{font-size:13px; line-height:1.75; color:var(--ink-soft);}
.bp-modego{display:inline-block; margin-top:16px; font-size:13.5px; font-weight:700; color:var(--orange);}
.bp-modecard.alt .bp-modego{color:var(--navy);}

/* portfolio input */
.bp-pftable{border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--paper);}
.bp-pfhead,.bp-pfrow{display:grid; grid-template-columns:2.3fr 0.8fr 0.9fr 0.9fr 0.7fr 0.7fr 0.8fr 0.6fr 0.9fr 0.4fr; gap:8px; align-items:center; padding:10px 12px;}
.bp-pfhead{background:var(--navy); color:#fff; font-size:11px; font-weight:700;}
.bp-pfhead em{font-style:normal; font-weight:400; color:var(--steel-l); font-size:10px; margin-left:3px;}
.bp-pfhead .c-num,.bp-pfhead .c-res,.bp-pfhead .c-pass,.bp-pfhead .c-type,.bp-pfhead .c-freq{text-align:center;}
.bp-margin.neg{color:#C0503A;}
.bp-pfrow{border-top:1px solid var(--canvas);}
.bp-pfrow .c-name{display:flex; flex-direction:column; gap:4px;}
.bp-in{width:100%; font-family:inherit; font-size:13px; padding:7px 9px; border:1px solid var(--line); border-radius:5px; background:var(--paper);}
.bp-in:focus{outline:none; border-color:var(--orange);}
.bp-in.name{font-weight:700;} .bp-in.memo{font-size:11.5px; color:var(--ink-soft);}
.c-num .bp-in,.c-res .bp-in{text-align:right; font-family:var(--font-num);}
.bp-margin{text-align:center; font-family:var(--font-num); font-weight:700; color:var(--navy);}
.bp-del{background:none; border:none; color:var(--steel); font-size:18px; line-height:1;}
.bp-del:hover{color:var(--orange);}
.bp-pftools{display:flex; gap:12px; align-items:center; margin-top:14px; flex-wrap:wrap;}
.bp-upload.sm{flex:1; min-width:220px; padding:11px 14px;}
.bp-upload.sm p{font-size:11px;}

/* portfolio board */
.bp-pfsummary{display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:16px;}
.bp-sumcell{background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:14px 16px;}
.bp-sumcell span{display:block; font-size:11px; color:var(--ink-soft); margin-bottom:4px;}
.bp-sumcell strong{font-family:var(--font-num); font-size:19px; font-weight:700;}
.bp-sumcell strong em{font-style:normal; font-size:12px; color:var(--ink-soft); margin-left:2px;}
.bp-sumcell strong.cost{color:var(--orange);} .bp-sumcell strong.pos{color:#2A7D5A;}
.bp-diagnosis{background:var(--navy); color:#fff; border-radius:8px; padding:16px 20px; margin-bottom:18px;}
.bp-diagnosis .bp-calloutlabel{color:var(--orange);} .bp-diagnosis p{font-size:14px; line-height:1.75; margin-top:5px;}
.bp-block{background:var(--paper); border:1px solid var(--line); border-radius:9px; padding:22px; margin-bottom:16px;}
.bp-matrixhead{display:flex; justify-content:space-between; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:16px;}
.bp-matrixhead h3{font-size:18px; font-weight:900;}
.bp-axispick{display:flex; gap:12px;}
.bp-axispick label{font-size:11px; color:var(--ink-soft); display:flex; align-items:center; gap:6px;}
.bp-axispick .bp-in{width:auto; padding:6px 10px;}
.bp-matrixwrap{width:100%; overflow-x:auto;}
.bp-matrixsvg{width:100%; min-width:520px; height:auto; display:block;}
.bp-qlabel{font-size:11px; fill:var(--ink-soft); font-weight:700; font-family:var(--font-jp);}
.bp-qlabel.hi{fill:var(--orange);} .bp-qlabel.lo{fill:var(--steel);}
.bp-axtitle{font-size:12px; fill:var(--navy); font-weight:700; font-family:var(--font-jp);}
.bp-blabel{font-size:11px; fill:var(--ink); font-weight:700; font-family:var(--font-jp);}
.bp-bubble{cursor:pointer;} .bp-bubble:hover circle{fill-opacity:1;}
.bp-matrixnote{font-size:12px; color:var(--ink-soft); margin-top:12px;}
.bp-matrixnote b{font-weight:700;} .v-focus{color:var(--orange);} .v-validate{color:#3E63C8;} .v-keep{color:var(--navy);} .v-exit{color:#C0503A;}
.bp-reco{display:grid; grid-template-columns:1fr 1fr 1.4fr; gap:12px; margin-bottom:16px;}
.bp-recocol{background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:16px 18px;}
.bp-recocol.focus{border-top:3px solid var(--orange);} .bp-recocol.exit{border-top:3px solid var(--steel);} .bp-recocol.act{border-top:3px solid var(--navy);}
.bp-recohd{display:block; font-size:12px; font-weight:900; margin-bottom:10px;}
.bp-recochips{display:flex; flex-wrap:wrap; gap:6px;}
.bp-recochip{font-size:12.5px; font-weight:700; padding:6px 12px; border-radius:5px;}
.bp-recochip.focus{background:var(--orange-soft); color:var(--orange);} .bp-recochip.exit{background:var(--canvas); color:var(--ink-soft);}
.bp-recocol ul{margin:0; padding-left:18px;} .bp-recocol li{font-size:12.5px; line-height:1.7;}
.bp-sortbar.mini{margin-bottom:0;}
.bp-pfrank{width:100%; border-collapse:collapse; font-size:12.5px;}
.bp-pfrank th{text-align:right; font-size:10.5px; color:var(--ink-soft); font-weight:700; padding:8px 8px; border-bottom:2px solid var(--line);}
.bp-pfrank th:first-child{text-align:left;}
.bp-pfrank td{text-align:right; padding:11px 8px; border-bottom:1px solid var(--canvas); font-family:var(--font-num);}
.bp-pfrank td.nm{text-align:left; font-family:var(--font-jp);}
.bp-pfrank td.nm strong{display:block; font-size:13px;} .bp-pfrank td.nm em{font-style:normal; font-size:11px; color:var(--ink-soft); display:block; margin-top:2px; line-height:1.4;}
.bp-pfrank td.cost{color:var(--orange);}
.bp-pfrank td .dim{color:var(--line);}
.bp-mtag{font-weight:700;} .bp-mtag.hi{color:#2A7D5A;} .bp-mtag.lo{color:var(--orange);}
.bp-vbadge{font-family:var(--font-jp); font-size:11px; font-weight:700; padding:3px 9px; border-radius:4px;}
.bp-vbadge.focus{background:var(--orange); color:#fff;} .bp-vbadge.validate{background:#3E63C8; color:#fff;} .bp-vbadge.keep{background:var(--navy); color:#fff;} .bp-vbadge.exit{background:#C0503A; color:#fff;}
.bp-mini{background:var(--paper); border:1px solid var(--line); font-family:var(--font-jp); font-size:11.5px; font-weight:700; padding:6px 10px; border-radius:5px; white-space:nowrap;}
.bp-mini:hover{border-color:var(--orange); color:var(--orange);}
.bp-pfrank tr.v-focus td.nm strong{color:var(--orange);}
.bp-pfrank tr.v-validate td.nm strong{color:#3E63C8;}
.bp-pfrank tr.v-exit td.nm strong{color:#C0503A;}
.bp-pfrank td.nm em.mr{color:#3E63C8;}
.bp-pfrank.wide{font-size:12px;}
.bp-flags{display:inline-flex; gap:5px; margin-left:8px; vertical-align:middle;}
.bp-flag{font-size:9.5px; font-weight:700; padding:2px 6px; border-radius:3px;}
.bp-flag.red{background:#F7DED7; color:#C0503A;} .bp-flag.amber{background:var(--orange-soft); color:var(--orange);} .bp-flag.steel{background:var(--canvas); color:var(--ink-soft);}
.bp-realy3{display:block; font-family:var(--font-jp); font-size:10px; color:var(--ink-soft); font-weight:400; margin-top:2px;}
.bp-flag.navy{background:var(--indigo-soft, #E7ECFA); color:#3E63C8;}
.bp-pfrank td.nm em.path{color:#2A7D5A;}
.reachcol{text-align:center !important;}
.bp-reachmark{font-family:var(--font-num); font-size:20px; font-weight:700; line-height:1; display:inline-block;}
.bp-reachmark.m5{color:#0E8F5E;} .bp-reachmark.m4{color:#2A7D5A;} .bp-reachmark.m3{color:#B08322;} .bp-reachmark.m2{color:#C0642E;} .bp-reachmark.m1,.bp-reachmark.m0{color:#C0503A;}

/* rank palette */
.rA{--rk:#0E8F5E;} .rB{--rk:#16233F;} .rC{--rk:#B08322;} .rD{--rk:#C0642E;} .rE{--rk:#C0503A;}

/* score cards */
.bp-scorecards{display:flex; flex-direction:column; gap:10px;}
.bp-scorecard{display:flex; align-items:stretch; gap:0; background:var(--paper); border:1px solid var(--line); border-left:5px solid var(--rk); border-radius:9px; overflow:hidden;}
.bp-scrank{width:70px; flex-shrink:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:var(--rk); color:#fff; gap:0; padding:10px 0;}
.bp-rankbig{font-family:var(--font-num); font-size:30px; font-weight:700; line-height:1;}
.bp-rankmark{font-size:14px; opacity:.9;}
.bp-scmain{flex:1; padding:14px 18px; min-width:0;}
.bp-schd{display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px;}
.bp-scname{font-size:16px; font-weight:900;}
.bp-scpct{font-family:var(--font-num); font-size:24px; font-weight:700; color:var(--rk);}
.bp-scpct em{font-style:normal; font-size:12px; color:var(--ink-soft); margin-left:2px;}
.bp-scaxes{display:grid; grid-template-columns:1fr 1fr; gap:6px 20px; margin-bottom:12px;}
.bp-scaxis{display:flex; align-items:center; gap:8px;}
.bp-scaxlabel{font-size:11.5px; color:var(--ink-soft); width:56px; flex-shrink:0;}
.bp-scaxtrack{flex:1; height:6px; background:var(--canvas); border-radius:3px; overflow:hidden;}
.bp-scaxfill{display:block; height:100%; background:var(--rk); border-radius:3px;}
.bp-scaxnum{font-family:var(--font-num); font-size:12px; font-weight:600; width:12px; text-align:right;}
.bp-axletter{font-family:var(--font-num); font-size:12px; font-weight:700; color:#fff; background:var(--rk); width:20px; height:20px; border-radius:4px; display:grid; place-items:center; flex-shrink:0;}
.bp-axletter.sm{width:18px; height:18px; font-size:11px; margin:0 auto;}
.bp-scaxlabel em{font-style:normal; font-size:9.5px; color:var(--ink-soft); margin-left:4px;}
.bp-ranklegend{display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:14px;}
.bp-lg{font-family:var(--font-num); font-size:11px; font-weight:700; color:#fff; padding:3px 9px; border-radius:4px;}
.bp-lg.rA{background:#0E8F5E;} .bp-lg.rB{background:#16233F;} .bp-lg.rC{background:#B08322;} .bp-lg.rD{background:#C0642E;} .bp-lg.rE{background:#C0503A;}
.bp-lgnote{font-size:11px; color:var(--ink-soft); margin-left:6px;}
.bp-pfrank th.ac,.bp-pfrank td.ac{text-align:center;}
.bp-axsub{display:block; font-family:var(--font-jp); font-size:9.5px; color:var(--ink-soft); font-weight:400; margin-top:2px;}
.bp-fc3{font-family:var(--font-num); font-size:12.5px; font-weight:700; color:var(--navy);}
.bp-flag.green{background:#E4F4EC; color:#0E8F5E;}

/* ===== DeepEval（1億円到達可能性 結果画面） ===== */
.bp-hero1oku{--rk:#B08322; background:var(--navy); color:#fff; border-radius:12px; padding:24px 26px; margin-bottom:18px; border-top:6px solid var(--rk);
  background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px); background-size:22px 22px;}
.bp-hero1oku.rA{--rk:#3DBE86;} .bp-hero1oku.rB{--rk:#6E86C8;} .bp-hero1oku.rC{--rk:#D6A93E;} .bp-hero1oku.rD{--rk:#E08A4E;} .bp-hero1oku.rE{--rk:#D96A55;}
.bp-hlead{font-size:13px; color:var(--steel-l); font-weight:700; letter-spacing:.5px;}
.bp-hmain{display:flex; align-items:center; gap:24px; flex-wrap:wrap; margin:10px 0 4px;}
.bp-hscore{display:flex; align-items:baseline; gap:6px;}
.bp-hscore strong{font-family:var(--font-num); font-size:56px; font-weight:700; line-height:1; color:#fff;}
.bp-hscore span{font-size:15px; color:var(--steel-l);}
.bp-hrank{display:flex; flex-direction:column; align-items:center; font-family:var(--font-num); font-weight:700; color:var(--rk);}
.bp-hrank{font-size:20px;} .bp-hrank span{font-size:26px;}
.bp-hmeta{display:flex; gap:12px; flex-wrap:wrap; margin-left:auto;}
.bp-hchip{background:rgba(255,255,255,.1); border-radius:8px; padding:9px 14px;}
.bp-hchip span{display:block; font-size:10.5px; color:var(--steel-l);}
.bp-hchip strong{font-family:var(--font-num); font-size:17px; font-weight:700;}
.bp-hchip em{font-style:normal; font-size:10px; color:var(--steel-l); margin-left:4px;}
.bp-hconc{font-size:14px; line-height:1.7; margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,.15);}

/* 壁打ちCTA */
.bp-interviewcta{display:flex; align-items:center; gap:18px; flex-wrap:wrap; background:var(--orange-soft); border:1px solid #BcD6EC; border-radius:10px; padding:16px 20px; margin-bottom:18px;}
.bp-interviewcta strong{font-size:14px; color:var(--ink);}
.bp-interviewcta p{font-size:12.5px; color:var(--ink-soft); margin-top:4px; line-height:1.5;}
.bp-interviewcta .bp-cta{margin-left:auto; flex-shrink:0;}

/* Interview（壁打ち） */
.bp-ivlist{display:flex; flex-direction:column; gap:12px;}
.bp-ivq{background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:20px 22px;}
.bp-ivqhd{display:flex; align-items:center; gap:10px; margin-bottom:8px;}
.bp-ivno{font-family:var(--font-num); font-size:12px; font-weight:700; color:var(--ink-soft);}
.bp-ivtopic{font-size:11px; font-weight:700; color:var(--orange); background:var(--orange-soft); padding:3px 10px; border-radius:5px;}
.bp-ivquestion{font-size:17px; font-weight:900; line-height:1.5; margin-bottom:14px;}
.bp-ivopts{display:flex; flex-direction:column; gap:8px; margin-bottom:12px;}
.bp-ivopt{text-align:left; background:var(--canvas); border:1.5px solid var(--line); border-radius:8px; padding:12px 16px; font-size:13.5px; font-weight:700; color:var(--ink); transition:all .15s;}
.bp-ivopt:hover{border-color:var(--orange);}
.bp-ivopt.on{border-color:var(--orange); background:var(--orange-soft);}
.bp-ivfree{width:100%; font-family:inherit; font-size:13px; padding:10px 14px; border:1px solid var(--line); border-radius:8px; background:var(--paper);}
.bp-ivfree:focus{outline:none; border-color:var(--orange);}
.bp-ivwhy{font-size:12px; color:var(--ink-soft); margin-top:12px; padding-top:10px; border-top:1px dashed var(--line); line-height:1.6;}
.bp-ivwhy span{display:inline-block; font-weight:700; color:var(--orange); margin-right:6px;}

.bp-eqrow{display:flex; align-items:center; gap:12px; flex-wrap:wrap;}
.bp-eqcell{background:var(--canvas); border-radius:8px; padding:12px 16px; min-width:110px;}
.bp-eqcell.hl{background:var(--orange-soft); border:1px solid #F1CBA9;}
.bp-eqcell span{display:block; font-size:11px; color:var(--ink-soft);}
.bp-eqcell strong{font-family:var(--font-num); font-size:20px; font-weight:700;}
.bp-eqop{font-size:20px; color:var(--orange); font-weight:700;}
.bp-block.bottleneck{border-left:4px solid var(--orange);}

.bp-catblock{border-top:1px solid var(--canvas); padding-top:12px; margin-top:12px;}
.bp-catblock:first-of-type{border-top:none; margin-top:0; padding-top:0;}
.bp-cathd{display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;}
.bp-cathd strong{font-size:14px; font-weight:900;}
.bp-catpts{font-family:var(--font-num); font-size:16px; font-weight:700; color:var(--navy);}
.bp-catpts em{font-style:normal; font-size:11px; color:var(--ink-soft); margin-left:2px;}
.bp-subitem{border-bottom:1px solid var(--canvas);}
.bp-subitem summary{display:flex; align-items:center; gap:10px; padding:9px 2px; cursor:pointer; list-style:none;}
.bp-subitem summary::-webkit-details-marker{display:none;}
.bp-subname{flex:1; font-size:13px; display:flex; align-items:center; gap:8px;}
.bp-subscore{display:flex; align-items:center; gap:8px;}
.bp-subdots{letter-spacing:-1px; color:var(--navy);} .bp-subdots .dim{color:var(--line);}
.bp-subscore b{font-family:var(--font-num); font-size:12px; color:var(--ink-soft);}
.bp-unv{font-size:11px; font-weight:700; color:#3E63C8; background:#E7ECFA; padding:2px 8px; border-radius:4px;}
.bp-subchev{color:var(--ink-soft); transition:transform .2s;}
.bp-subitem[open] .bp-subchev{transform:rotate(180deg);}
.bp-subitem.unv summary{opacity:.75;}
.bp-subbody{padding:2px 2px 12px 2px;}
.bp-subreason{font-size:12.5px; line-height:1.6;}
.bp-subev{margin:6px 0 0; padding-left:18px;} .bp-subev li{font-size:12px; line-height:1.6; color:var(--ink-soft);}
.bp-submiss{font-size:12px; color:var(--orange); margin-top:6px;}
.bp-subrubric{font-size:11px; color:var(--ink-soft); margin-top:6px; background:var(--canvas); padding:5px 10px; border-radius:5px; display:inline-block;}
.bp-src{font-size:9.5px; font-weight:700; padding:2px 7px; border-radius:4px;}
.src-fact{background:#E4F4EC; color:#0E8F5E;} .src-cust{background:#FCEBDE; color:#C0642E;} .src-mkt{background:#E7ECFA; color:#3E63C8;} .src-ai{background:var(--canvas); color:var(--ink-soft);}

.bp-improve{--rk:#B08322; background:var(--orange-soft); border:1px solid #F1CBA9; border-radius:10px; padding:16px 18px; margin-bottom:18px;}
.bp-imphd{font-size:11.5px; font-weight:700; color:var(--orange);}
.bp-impbody{font-size:14px; line-height:1.8; margin-top:6px;}
.bp-impbody .up{color:#0E8F5E;}
.bp-scfoot{display:flex; align-items:center; gap:12px; flex-wrap:wrap;}
.bp-scfore{background:var(--canvas); border-radius:8px; padding:11px 13px; margin-bottom:12px;}
.bp-scforehd{display:flex; align-items:center; gap:10px; margin-bottom:8px;}
.bp-scforehd span:first-child{font-size:11px; font-weight:700; color:var(--ink-soft);}
.bp-hit1oku{font-size:10.5px; font-weight:700; color:#fff; background:var(--rk); padding:2px 9px; border-radius:4px;}
.bp-scscenarios{display:flex; gap:8px; flex-wrap:wrap;}
.bp-scn{flex:1; min-width:84px; background:#fff; border-radius:6px; padding:8px 10px; display:flex; flex-direction:column; gap:2px;}
.bp-scn span{font-size:10px; color:var(--ink-soft);}
.bp-scn strong{font-family:var(--font-num); font-size:15px; font-weight:700; letter-spacing:-.3px;}
.bp-scn.low strong{color:var(--ink-soft);} .bp-scn.base strong{color:var(--rk);} .bp-scn.high strong{color:#2A7D5A;}
.bp-scn.som{background:transparent; border:1px dashed var(--line);} .bp-scn.som strong{color:var(--navy); font-size:13px;}
.bp-scbasis{font-size:11.5px; color:var(--ink-soft); margin-top:8px; line-height:1.5;}
.bp-scdecision{font-size:12px; font-weight:700; color:#fff; background:var(--rk); padding:4px 12px; border-radius:5px;}
.bp-scnote{font-size:12px; color:var(--ink-soft); flex:1; min-width:120px; line-height:1.5;}
.bp-rankchip{font-family:var(--font-num); font-size:15px; font-weight:700; color:#fff; background:var(--rk); padding:3px 9px; border-radius:5px; display:inline-flex; align-items:baseline; gap:2px;}
.bp-rankchip em{font-style:normal; font-size:10px;}
.bp-scorenum2{font-family:var(--font-num); font-size:16px; font-weight:700;}
.bp-recocol.keep{border-top:3px solid var(--navy);}
.bp-recochip.keep{background:var(--canvas); color:var(--navy);}
.bp-sumcell.hl{background:var(--orange-soft); border:1px solid #F1CBA9;}
.bp-sumcell strong.reach{color:var(--orange);}
.bp-sumcell strong.neg{color:#C0503A;} .bp-sumcell strong.pos{color:#2A7D5A;}
.bp-dots{letter-spacing:-1px;} .bp-dots.lo{color:#C0503A;}
.bp-stars{color:#B08322; letter-spacing:-1px;} .bp-stars .dim{color:var(--line);}
.bp-choicerow.one{grid-template-columns:1fr; margin-bottom:18px;}
.bp-in.value{font-size:12px; color:#8A6A2B;}
.bp-in.evidence{font-size:12px; color:#2A5F8F;}
.bp-in.team{font-size:12px; color:#3D6B4F;}
.bp-in.vstatus{font-size:12px; color:var(--ink-soft); border-color:var(--line); background:var(--canvas);}
.bp-in.vstatus.set{color:var(--blue); font-weight:700; border-color:var(--blue); background:var(--blue-soft);}
.bp-pretag{font-family:var(--font-jp); font-size:10.5px; font-weight:700; color:#3E63C8; background:#E7ECFA; padding:2px 7px; border-radius:4px;}
.bp-pfhead .c-num em{font-style:normal; font-weight:400; font-size:9.5px; opacity:.7; margin-left:3px;}
.bp-nfgrid{display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px;}
.bp-nfcard{background:#FBF6EA; border:1px solid #EBDCBF; border-radius:8px; padding:14px 16px;}
.bp-nfhd{display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px;}
.bp-nfhd strong{font-size:13.5px;} .bp-nfhd .bp-stars{font-size:13px;}
.bp-nfcard p{font-size:12.5px; line-height:1.6; color:var(--ink);}

/* reco 4-way */
.bp-reco4{display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-bottom:16px;}
.bp-recocol.validate{border-top:3px solid #3E63C8;}
.bp-recosub{font-size:11px; color:var(--ink-soft); margin:-6px 0 10px;}
.bp-recohd.focus{color:var(--orange);} .bp-recohd.validate{color:#3E63C8;} .bp-recohd.exit{color:#C0503A;}
.bp-recochip.validate{background:#E7ECFA; color:#3E63C8;}
.bp-recoempty{color:var(--steel); font-weight:700;}

/* block note + small ghost */
.bp-blocknote{font-size:12px; color:var(--ink-soft);}
.bp-ghost.small{font-size:12px; padding:7px 14px;}

/* resource reallocation */
.bp-realloc{display:flex; flex-direction:column; gap:8px;}
.bp-reallocrow{display:grid; grid-template-columns:auto 24px auto 1fr; align-items:center; gap:10px; background:var(--canvas); border-radius:7px; padding:11px 14px;}
.bp-rafrom{font-weight:700; font-size:13px; color:#C0503A;}
.bp-raarrow{color:var(--orange); font-weight:700; text-align:center;}
.bp-rato{font-weight:700; font-size:13px; color:var(--orange);}
.bp-radetail{font-size:12px; color:var(--ink-soft); line-height:1.5;}

/* validation plans */
.bp-vplans{display:grid; grid-template-columns:1fr 1fr; gap:12px;}
.bp-vplan{position:relative; background:#fff; border:1px solid var(--line); border-left:3px solid #3E63C8; border-radius:8px; padding:16px 18px; overflow:hidden;}
.bp-vpbiz{display:block; font-size:14px; font-weight:900; margin-bottom:10px;}
.bp-vprow{display:grid; grid-template-columns:58px 1fr; gap:8px; margin-bottom:7px;}
.bp-vplabel{font-size:11px; font-weight:700; color:#3E63C8; padding-top:1px;}
.bp-vprow p{font-size:12.5px; line-height:1.6;} .bp-vprow p.crit{color:var(--navy); font-weight:700;}
.bp-vpperiod{display:inline-block; margin-top:4px; font-family:var(--font-num); font-size:11px; font-weight:700; color:var(--ink-soft); background:var(--canvas); padding:3px 10px; border-radius:4px;}

/* exec logic */
.bp-execlogic{list-style:none; margin:0; padding:0; counter-reset:none;}
.bp-execlogic li{display:grid; grid-template-columns:34px 1fr; gap:14px; align-items:start; padding:12px 0; border-bottom:1px dashed var(--line);}
.bp-execlogic li:last-child{border-bottom:none;}
.bp-eln{font-family:var(--font-num); font-size:14px; font-weight:700; color:#fff; background:var(--navy); width:30px; height:30px; border-radius:50%; display:grid; place-items:center;}
.bp-execlogic li:first-child .bp-eln{background:var(--orange);}
.bp-execlogic p{font-size:14px; line-height:1.7; padding-top:3px;}

/* loading */
.bp-skel{display:flex; flex-direction:column; align-items:center; gap:14px; padding:36px 20px;}
.bp-skel p{font-size:13.5px; color:var(--ink-soft);}
.bp-spinner{width:32px; height:32px; border:3px solid var(--orange-soft); border-top-color:var(--orange); border-radius:50%; animation:bp-spin .8s linear infinite;}
.bp-spinner.big{width:44px; height:44px; border-width:4px;}
@keyframes bp-spin{to{transform:rotate(360deg);}}
.bp-overlay{position:fixed; inset:0; background:rgba(238,241,245,.85); backdrop-filter:blur(3px); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; z-index:50;}
.bp-overlay p{font-size:15px; font-weight:900;}

/* ---- 撤退ライン ---- */
.bp-exprob{--pk:#D6A93E; background:var(--navy); color:#fff; border-radius:12px; padding:24px 26px; margin-bottom:18px; border-top:6px solid var(--pk);}
.bp-exprob.hi{--pk:#3DBE86;} .bp-exprob.mid{--pk:#D6A93E;} .bp-exprob.lo{--pk:#D96A55;}
.bp-exprobmain{display:flex; align-items:center; gap:24px; flex-wrap:wrap; margin-top:8px;}
.bp-exprobnum strong{font-family:'Space Grotesk',sans-serif; font-size:64px; line-height:1; color:var(--pk);}
.bp-exprobnum span{font-size:22px; margin-left:4px; color:var(--steel-l);}
.bp-exprobside{flex:1; min-width:220px;}
.bp-exprobside p{font-size:13.5px; margin-top:8px; color:#E3E9EE;} .bp-exprobside p.sub{font-size:12px; color:var(--steel-l);}
.bp-exprobside b.up{color:#7FE0B4;}
.bp-exbar{height:12px; background:rgba(255,255,255,.12); border-radius:6px; display:flex; overflow:hidden;}
.bp-exbar .base{background:var(--pk);} .bp-exbar .add{background:#7FE0B4;}
.bp-exdrivers{display:flex; flex-wrap:wrap; gap:8px; margin-top:14px;}
.bp-exdrivers span{font-size:12px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.15); border-radius:999px; padding:4px 11px;}
.bp-exdrivers b{margin-left:6px; color:#F2A08F;}
.bp-exlevers{display:flex; flex-direction:column; gap:8px;}
.bp-exlever{display:flex; align-items:center; gap:12px; border:1px solid var(--line); border-radius:8px; padding:11px 14px; cursor:pointer; background:var(--paper);}
.bp-exlever.on{border-color:var(--orange); background:var(--orange-soft);}
.bp-exlever input{width:18px; height:18px; flex-shrink:0;}
.bp-exlvtext{flex:1; display:flex; flex-direction:column; gap:2px;}
.bp-exlvtext strong{font-size:14px;} .bp-exlvtext em{font-style:normal; font-size:12px; color:var(--ink-soft);}
.bp-exgain{font-family:'Space Grotesk',sans-serif; font-weight:700; color:#0E8F5E; white-space:nowrap;}
.bp-extablewrap{overflow-x:auto;}
.bp-extable{width:100%; border-collapse:collapse; font-size:13px; min-width:640px;}
.bp-extable th{text-align:left; font-size:11px; color:var(--ink-soft); padding:7px 8px; border-bottom:2px solid var(--line); white-space:nowrap;}
.bp-extable th.go{color:#0E8F5E;} .bp-extable th.kill{color:var(--danger);}
.bp-extable td{padding:8px; border-bottom:1px solid var(--line); vertical-align:top;}
.bp-extable td.wh{font-weight:700; white-space:nowrap;}
.bp-extable td.go{background:rgba(14,143,94,.06);} .bp-extable td.kill{background:rgba(192,80,58,.06);}
.bp-exin{font:inherit; font-size:13px; border:1px solid var(--line); border-radius:5px; padding:5px 7px; width:100%; min-width:0; background:var(--paper); color:var(--ink);}
.bp-exin[type=number]{width:96px;} .bp-exin.actual{width:84px; border-color:var(--orange);} .bp-exin.wide{width:min(360px,100%);}
.bp-exunit{display:inline-flex; align-items:center; gap:4px; white-space:nowrap;}
.bp-extable td .bp-exin[type=text]{min-width:110px;} .bp-extable td.wh .bp-exin{width:58px;} .bp-extable td.go .bp-exin,.bp-extable td.kill .bp-exin{width:80px;}
.bp-exunit.sm{font-size:11px; color:var(--ink-soft); margin-top:4px;} .bp-exunit.sm .bp-exin{width:70px; font-size:11px; padding:3px 5px;}
.bp-exwhy{display:block; font-style:normal; font-size:11px; color:var(--ink-soft); margin-top:4px; line-height:1.5;}
.bp-gchip{display:inline-block; font-size:12px; font-weight:700; padding:3px 10px; border-radius:999px; background:var(--canvas); color:var(--ink-soft); white-space:nowrap;}
.bp-gchip.g-go{background:#0E8F5E; color:#fff;} .bp-gchip.g-pivot{background:#B08322; color:#fff;} .bp-gchip.g-kill{background:var(--danger); color:#fff;}
.bp-exlimits,.bp-exvin{display:flex; flex-wrap:wrap; align-items:center; gap:10px 18px; margin-top:14px;}
.bp-exlimits label,.bp-exvin label,.bp-exagree label{display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:700;}
.bp-exlimits em,.bp-exvin em{font-style:normal; font-size:12px; color:var(--ink-soft); font-weight:500;}
.bp-exlimhd{width:100%; font-size:11px; font-weight:700; color:var(--ink-soft);}
.bp-exlimits .bp-scbasis{width:100%;}
.bp-exverdict{display:flex; flex-wrap:wrap; gap:18px; align-items:stretch; background:var(--paper); border:1px solid var(--line); border-left:6px solid var(--steel); border-radius:10px; padding:16px 18px; margin-bottom:18px;}
.bp-exverdict.g-go{border-left-color:#0E8F5E;} .bp-exverdict.g-pivot{border-left-color:#B08322;} .bp-exverdict.g-kill{border-left-color:var(--danger);}
.bp-exverdict .bp-exvin{flex:1; min-width:260px; margin-top:0;}
.bp-exvout{min-width:200px; flex:1;}
.bp-exvout span{font-size:11px; font-weight:700; color:var(--ink-soft);}
.bp-exvout strong{display:block; font-size:28px; font-weight:900; margin:2px 0 4px;}
.bp-exverdict.g-go .bp-exvout strong{color:#0E8F5E;} .bp-exverdict.g-pivot .bp-exvout strong{color:#B08322;} .bp-exverdict.g-kill .bp-exvout strong{color:var(--danger);}
.bp-exvout p{font-size:13px; line-height:1.6; color:var(--ink-soft);}
.bp-expm{display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px;}
.bp-expmrow{border:1px solid var(--line); border-radius:8px; padding:12px 14px; background:var(--paper);}
.bp-expmrow p{font-size:13px; line-height:1.6; margin-top:6px;} .bp-expmrow p.sc{font-weight:700; margin-top:0;}
.bp-expmrow span{display:inline-block; font-size:10.5px; font-weight:700; color:var(--orange); margin-right:6px;}
.bp-exagree{display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:12px;}

@media(max-width:880px){
  .bp-candgrid,.bp-flow,.bp-pillars,.bp-modes,.bp-reco,.bp-reco4,.bp-vplans,.bp-nfgrid{grid-template-columns:1fr;}
  .bp-reallocrow{grid-template-columns:1fr; gap:4px;} .bp-raarrow{text-align:left;}
  .bp-inputgrid,.bp-cv2,.bp-choicerow,.bp-simgrid,.bp-who3,.bp-themes{grid-template-columns:1fr;}
  .bp-pfsummary{grid-template-columns:1fr 1fr 1fr;}
  .bp-stepper{display:none;}
  .bp-stations{flex-direction:column;} .bp-stchev{transform:rotate(90deg); align-self:center;}
  .bp-pftable{overflow-x:auto;} .bp-pfhead,.bp-pfrow{min-width:900px;}
  .bp-pfrank.wide{display:block; overflow-x:auto; white-space:nowrap;}
  .bp-proglabel{font-size:12px;} .bp-progline{min-width:10px; margin:0 7px;}
}
@media(max-width:560px){
  .bp-main{padding:22px 14px 60px;}
  .bp-figs,.bp-simkpis,.bp-pfsummary{grid-template-columns:1fr 1fr;}
  .bp-scaxes{grid-template-columns:1fr;}
  .bp-progwrap{gap:10px; padding:11px 12px;}
  .bp-progsteps{min-width:0;}
  .bp-progstep .bp-proglabel{display:none;}
  .bp-progline{min-width:5px; margin:0 4px;}
  .bp-progdot{width:24px; height:24px; font-size:11px;}
  .bp-progcount b{font-size:15px;}
  .bp-spec{display:none;}
  .bp-home{padding:6px 11px; font-size:12px;}
}`;
