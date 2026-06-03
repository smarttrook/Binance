import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";
import reportRouter from "./report.js"; // تأكد من أن هذا الملف لا يحتوي على أكواد قواعد بيانات

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const port = process.env.PORT || 8080;

// ✅ تم التبديل من بينانس (محظور على Railway) إلى OKX — واجهة عامة مجانية ولا تُحجب
const okxBaseUrl = "https://www.okx.com";
const defaultFuturesSymbol = "BTC-USDT-SWAP"; // رمز عقد البيتكوين الدائم في OKX
const okxCandlesUrl = `${okxBaseUrl}/api/v5/market/candles`;
const okxTickerUrl = `${okxBaseUrl}/api/v5/market/ticker`;
const stateFile = "./sim-state.json";

// تحويل الفريمات من صيغة بينانس إلى صيغة OKX (OKX يستخدم حرف كبير للدقائق/الساعات أحياناً)
function toOkxBar(tf) {
  const map = { "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "2h": "2H", "4h": "4H", "1d": "1D" };
  return map[String(tf || "1m")] || "1m";
}

// قائمة المؤشرات للاستراتيجيات (الخلطة)
const allowedIndicators = ["nebula", "flash", "titan", "phantom", "smart_trook", "turbo"];

// ─── إعدادات وحالة المحاكي (تعمل محلياً بدون مستخدمين) ───
let appState = {
  virtualBalance: 10000, // رصيد افتراضي
  config: {
    asset: "BTC",
    timeframe: "1m",
    symbol: defaultFuturesSymbol, // BTC-USDT-SWAP
    leverage: 5, // الرافعة — تنطبق على كل الاستراتيجيات
    tradeAmount: 10,
    baseProfitTarget: 1,
    stopLoss: 1,
    martingaleMultiplier: 2,
    martingaleSteps: 5,
    profitTarget: 100, // هدف الربح لإيقاف البوت
    lossLimit: 100, // حد الخسارة لإيقاف البوت
    direction: "both",
    selectedIndicators: ["smart_trook"]
  },
  status: {
    running: false,
    currentTrade: null,
    martingaleLossCount: 0,
    totalProfit: 0,
    totalLoss: 0,
    resolvedTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    lastError: null,
    tradeState: "neutral",
    livePrice: 0,        // السعر الحي اللحظي من بينانس
    livePnl: 0           // الربح/الخسارة الحالي للصفقة المفتوحة
  },
  logs: [],
  tradeLogs: [],
  fullTradeLogs: [],
  lastSignalKey: null
};

let botWorkerActive = false;

// ─── دوال مساعدة ───
function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify(appState, null, 2)); } catch {}
}

function loadState() {
  try {
    if (!fs.existsSync(stateFile)) return;
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (data && typeof data === "object") {
      appState = { ...appState, ...data };
      appState.status.running = false; // دائماً يبدأ متوقفاً بعد إعادة تشغيل السيرفر
      // ضمان وجود الحقول الجديدة بعد التحديث
      if (typeof appState.status.livePrice !== "number") appState.status.livePrice = 0;
      if (typeof appState.status.livePnl !== "number") appState.status.livePnl = 0;
    }
  } catch {}
}

function addLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  appState.logs.push(line);
  if (appState.logs.length > 500) appState.logs = appState.logs.slice(-500);
  console.log(`[SIM] ${line}`);
}

function addTradeLog(result, amount, side, strategy = "-") {
  const row = { time: new Date().toISOString(), result, amount, side, strategy };
  appState.tradeLogs.push(row);
  if (appState.tradeLogs.length > 200) appState.tradeLogs = appState.tradeLogs.slice(-200);
  appState.fullTradeLogs.push(row);
  if (appState.fullTradeLogs.length > 5000) appState.fullTradeLogs = appState.fullTradeLogs.slice(-5000);
  saveState();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── دوال OKX (جلب بيانات فقط - أسعار حيّة حقيقية) ───
async function getCurrentFuturesPrice(symbol = defaultFuturesSymbol) {
  try {
    const r = await axios.get(okxTickerUrl, {
      params: { instId: symbol },
      timeout: 10000
    });
    // OKX يرجّع: { code:"0", data:[ { last:"...", ... } ] }
    const last = r.data?.data?.[0]?.last;
    return Number(last || 0);
  } catch {
    return 0;
  }
}

async function getFuturesKlines(symbol = defaultFuturesSymbol, interval = "1m", limit = 60) {
  try {
    const r = await axios.get(okxCandlesUrl, {
      params: { instId: symbol, bar: toOkxBar(interval), limit },
      timeout: 15000
    });
    const rows = r.data?.data;
    if (!Array.isArray(rows)) return [];
    // ⚠️ مهم: OKX يرجّع الشموع من الأحدث للأقدم — نعكسها لتصير الأقدم أولاً (مثل بينانس)
    // صيغة شمعة OKX: [ts, open, high, low, close, vol, ...] — الإغلاق في الفهرس 4 (نفس بينانس)
    return rows.slice().reverse();
  } catch {
    return [];
  }
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ─── محرك التحليل والصفقات الوهمية ───
async function analyzeFuturesMarket() {
  const symbol = String(appState.config.symbol || defaultFuturesSymbol).toUpperCase();
  const rows = await getFuturesKlines(symbol, appState.config.timeframe, 35);

  if (rows.length < 25) {
    addLog("⏳ جاري انتظار اكتمال بيانات الشموع من بينانس...");
    return null;
  }

  const closes = rows.map((r) => Number(r[4])).filter((n) => Number.isFinite(n) && n > 0);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];

  // استراتيجية تقاطع EMA البسيطة كأساس (يمكنك تعديل خلطة المؤشرات هنا لاحقاً)
  const emaFast = average(closes.slice(-7));
  const emaSlow = average(closes.slice(-21));
  const candleUp = last > prev;
  const candleDown = last < prev;

  let side = null;
  if (emaFast > emaSlow && candleUp) side = "buy";
  if (emaFast < emaSlow && candleDown) side = "sell";

  if (appState.config.direction === "buy" && side === "sell") side = null;
  if (appState.config.direction === "sell" && side === "buy") side = null;

  if (!side) return null;

  return { side, symbol, strategyText: "sim_trend_strategy" };
}

function getRecoveryTargetProfit() {
  const step = Math.min(Number(appState.status.martingaleLossCount || 0), Number(appState.config.martingaleSteps || 1) - 1);
  const base = Number(appState.config.baseProfitTarget || appState.config.tradeAmount || 1);
  const mult = Number(appState.config.martingaleMultiplier || 1);
  return Math.round((base * Math.pow(mult, step)) * 100) / 100;
}

async function executeSimTrade(pending) {
  // ✅ إصلاح الفجوة: نلتقط السعر الحي الحقيقي لحظة الفتح (مو سعر شمعة مغلقة)
  const liveEntry = await getCurrentFuturesPrice(pending.symbol);
  const entryPrice = liveEntry > 0 ? liveEntry : pending.entryPrice;

  const notional = Number(pending.amount) * Number(pending.leverage);
  const qty = notional / entryPrice;

  const targetDistance = Number(pending.targetProfit) / qty;
  const stopDistance = Number(pending.stopLoss) / qty;

  const takeProfitPrice = pending.side === "buy" ? entryPrice + targetDistance : entryPrice - targetDistance;
  const stopLossPrice = pending.side === "buy" ? entryPrice - stopDistance : entryPrice + stopDistance;

  appState.status.currentTrade = {
    id: crypto.randomUUID(),
    side: pending.side,
    symbol: pending.symbol,
    amount: pending.amount,
    leverage: pending.leverage,
    qty,
    targetProfit: pending.targetProfit,
    stopLoss: pending.stopLoss,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
    strategy: pending.strategy,
    openedAt: new Date().toISOString(),
    pnlChart: [{ t: Date.now(), price: entryPrice, pnl: 0 }] // نقطة بداية الشارت
  };

  appState.status.livePrice = entryPrice;
  appState.status.livePnl = 0;

  addLog(`📄 صفقة محاكاة جديدة [${pending.side.toUpperCase()}] | الرافعة: x${pending.leverage} | الدخول: ${entryPrice.toFixed(2)} | الهدف: ${takeProfitPrice.toFixed(2)} | الوقف: ${stopLossPrice.toFixed(2)}`);
  saveState();
}

async function resolveSimTrade() {
  const t = appState.status.currentTrade;
  if (!t) return;

  const currentPrice = await getCurrentFuturesPrice(t.symbol);
  if (!currentPrice) return;

  // ── حساب الربح/الخسارة اللحظي بالدولار ──
  const priceDiff = t.side === "buy" ? (currentPrice - t.entryPrice) : (t.entryPrice - currentPrice);
  const livePnl = Math.round((priceDiff * Number(t.qty)) * 100) / 100;

  appState.status.livePrice = currentPrice;
  appState.status.livePnl = livePnl;

  // إضافة نقطة لشارت الربح/الخسارة (نحتفظ بآخر 300 نقطة)
  t.pnlChart.push({ t: Date.now(), price: currentPrice, pnl: livePnl });
  if (t.pnlChart.length > 300) t.pnlChart = t.pnlChart.slice(-300);

  // حالة الصفقة للمنصة (رابحة أم خاسرة حالياً)
  appState.status.tradeState = livePnl >= 0 ? "win" : "loss";

  const won = t.side === "buy" ? currentPrice >= t.takeProfitPrice : currentPrice <= t.takeProfitPrice;
  const lost = t.side === "buy" ? currentPrice <= t.stopLossPrice : currentPrice >= t.stopLossPrice;

  if (won) {
    appState.virtualBalance += Number(t.targetProfit);
    appState.status.wins++;
    appState.status.totalProfit += Number(t.targetProfit);
    appState.status.martingaleLossCount = 0;
    addTradeLog("WIN", Number(t.targetProfit), t.side, t.strategy);
    addLog(`✅ صفقة رابحة | +$${Number(t.targetProfit).toFixed(2)} | الرصيد: $${appState.virtualBalance.toFixed(2)}`);
    closeTrade();
  } else if (lost) {
    appState.virtualBalance -= Number(t.stopLoss);
    appState.status.losses++;
    appState.status.totalLoss += Number(t.stopLoss);
    appState.status.martingaleLossCount++;
    if (appState.status.martingaleLossCount >= Number(appState.config.martingaleSteps)) {
      appState.status.martingaleLossCount = 0; // تصفير إذا تجاوزنا الخطوات المسموحة
    }
    addTradeLog("LOSS", Number(t.stopLoss), t.side, t.strategy);
    addLog(`❌ صفقة خاسرة | -$${Number(t.stopLoss).toFixed(2)} | الرصيد: $${appState.virtualBalance.toFixed(2)}`);
    closeTrade();
  }
}

function closeTrade() {
  appState.status.resolvedTrades++;
  appState.status.winRate = (appState.status.wins / appState.status.resolvedTrades) * 100;
  appState.status.currentTrade = null;
  appState.status.tradeState = "neutral";
  appState.status.livePnl = 0;

  if (appState.status.totalProfit >= Number(appState.config.profitTarget)) {
    appState.status.running = false;
    addLog(`🛑 توقف البوت: تم الوصول لهدف الربح الكلي ($${appState.status.totalProfit})`);
  }
  if (appState.status.totalLoss >= Number(appState.config.lossLimit)) {
    appState.status.running = false;
    addLog(`🛑 توقف البوت: تم الوصول للحد الأقصى للخسارة ($${appState.status.totalLoss})`);
  }
  saveState();
}

// ─── حلقة المحاكاة الرئيسية (Bot Loop) ───
async function botLoop() {
  if (botWorkerActive) return;
  botWorkerActive = true;
  addLog("🤖 بدء محرك المحاكاة...");

  while (appState.status.running) {
    try {
      if (appState.status.currentTrade) {
        await resolveSimTrade();
        await sleep(2000); // تحديث سريع أثناء وجود صفقة مفتوحة (شارت لحظي)
        continue;
      }

      const signal = await analyzeFuturesMarket();
      if (!signal) {
        await sleep(5000);
        continue;
      }

      const signalKey = `${signal.side}-${signal.symbol}-${Math.floor(Date.now() / 60000)}`;
      if (appState.lastSignalKey === signalKey) {
        await sleep(5000);
        continue;
      }

      const targetProfit = getRecoveryTargetProfit();
      const stopLoss = Number(appState.config.stopLoss || 1);

      const pending = {
        side: signal.side,
        symbol: signal.symbol,
        amount: Number(appState.config.tradeAmount || 10),
        leverage: Number(appState.config.leverage || 5),
        targetProfit,
        stopLoss,
        entryPrice: 0, // سيُلتقط حيّاً داخل executeSimTrade
        strategy: signal.strategyText
      };

      appState.lastSignalKey = signalKey;
      await executeSimTrade(pending);

    } catch (e) {
      const msg = e.message || String(e);
      appState.status.lastError = msg;
      addLog(`⚠️ خطأ في المحاكي: ${msg}`);
      await sleep(10000); // راحة في حال وجود خطأ
    }
  }

  botWorkerActive = false;
  addLog("🛑 توقف محرك المحاكاة.");
}

// ─── الروابط (API Endpoints) - مبسطة للعمل الفوري بدون تسجيل ───

// روابط وهمية للمصادقة لمنع أخطاء الواجهة القديمة إذا طلبتها
app.post("/api/auth/send-otp", (req, res) => res.json({ ok: true }));
app.post("/api/auth/verify-otp", (req, res) => res.json({ ok: true, token: "sim-token", isNew: false }));
app.get("/api/auth/me", (req, res) => res.json({ ok: true, user_id: "local_user" }));

app.get("/api/all", async (req, res) => {
  res.json({
    ok: true,
    status: appState.status,
    config: appState.config,
    walletInfo: { balance: appState.virtualBalance }
  });
});

app.get("/api/logs", (req, res) => {
  res.json({
    ok: true,
    logs: appState.logs,
    trade_logs: appState.tradeLogs,
    full_trade_logs: appState.fullTradeLogs
  });
});

// ✅ رابط جديد: شارت الربح/الخسارة اللحظي للصفقة المفتوحة
app.get("/api/trade-chart", (req, res) => {
  const t = appState.status.currentTrade;
  if (!t) {
    return res.json({
      ok: true,
      open: false,
      livePrice: appState.status.livePrice,
      livePnl: 0,
      points: []
    });
  }
  res.json({
    ok: true,
    open: true,
    side: t.side,
    symbol: t.symbol,
    entryPrice: t.entryPrice,
    takeProfitPrice: t.takeProfitPrice,
    stopLossPrice: t.stopLossPrice,
    leverage: t.leverage,
    livePrice: appState.status.livePrice,
    livePnl: appState.status.livePnl,
    points: t.pnlChart // [{ t, price, pnl }, ...]
  });
});

app.post("/api/config", (req, res) => {
  const c = req.body;
  appState.config = {
    ...appState.config,
    ...c,
    symbol: String(c.symbol || appState.config.symbol).toUpperCase(), // BTC-USDT-SWAP — الشرطات تبقى
    leverage: Math.max(1, Math.min(125, Number(c.leverage || appState.config.leverage))),
    selectedIndicators: Array.isArray(c.selectedIndicators || c.selected_indicators)
      ? (c.selectedIndicators || c.selected_indicators).filter(x => allowedIndicators.includes(x))
      : appState.config.selectedIndicators
  };
  saveState();
  res.json({ ok: true, config: appState.config });
});

app.post("/api/start", (req, res) => {
  appState.status.running = true;
  appState.status.currentTrade = null;
  appState.status.martingaleLossCount = 0;
  appState.status.totalProfit = 0;
  appState.status.totalLoss = 0;
  appState.status.resolvedTrades = 0;
  appState.status.wins = 0;
  appState.status.losses = 0;
  appState.status.winRate = 0;
  appState.status.lastError = null;
  appState.status.tradeState = "neutral";
  appState.status.livePrice = 0;
  appState.status.livePnl = 0;
  appState.tradeLogs = [];
  appState.lastSignalKey = null;
  saveState();
  botLoop();
  res.json({ ok: true });
});

app.post("/api/stop", (req, res) => {
  appState.status.running = false;
  saveState();
  res.json({ ok: true });
});

app.post("/api/toggle", (req, res) => {
  const target = Boolean(req.body?.running);
  appState.status.running = target;
  saveState();
  if (target) botLoop();
  res.json({ ok: true, running: target });
});

app.get("/health", (_, res) => res.json({ ok: true, mode: "simulation-only" }));

// ─── التشغيل ───
loadState();
if (reportRouter) app.use(reportRouter);

app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${port} | وضع المحاكاة فقط (Simulation Mode)`);
  addLog("السيرفر جاهز وتم تفعيل محرك المحاكاة.");
});
