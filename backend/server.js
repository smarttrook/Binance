import express from "express";
import cors from "cors";
import axios from "axios";
import { ethers } from "ethers";
import fs from "fs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import pkg from "pg";
import { PrivyClient as privyClient } from "@privy-io/server-auth";
import reportRouter from "./report.js";

const { Pool } = pkg;

// ─── PostgreSQL pool ───
const dbPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("railway.internal")
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

async function initDb() {
  if (!dbPool) {
    console.log("⚠️ DATABASE_URL not set — using memory only");
    return;
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_wallets (
        user_id TEXT PRIMARY KEY,
        email TEXT,
        wallet_id TEXT,
        wallet_address TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("✅ database ready");
  } catch (e) {
    console.error("❌ database init failed:", e.message);
  }
}

async function dbSaveWallet(userId, email, walletId, walletAddress) {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      INSERT INTO user_wallets (user_id, email, wallet_id, wallet_address, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET email = EXCLUDED.email,
            wallet_id = COALESCE(EXCLUDED.wallet_id, user_wallets.wallet_id),
            wallet_address = EXCLUDED.wallet_address,
            updated_at = NOW()
    `, [userId, email || null, walletId || null, walletAddress || null]);
  } catch (e) {
    console.error("dbSaveWallet error:", e.message);
  }
}

async function dbGetWallet(userId) {
  if (!dbPool) return null;
  try {
    const r = await dbPool.query(
      "SELECT * FROM user_wallets WHERE user_id = $1",
      [userId]
    );
    return r.rows[0] || null;
  } catch (e) {
    console.error("dbGetWallet error:", e.message);
    return null;
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const port = process.env.PORT || 8080;
const polygonRpc = process.env.POLYGON_RPC || "https://polygon-bor-rpc.publicnode.com";

// Binance Futures Testnet config
const binanceFuturesBaseUrl = process.env.BINANCE_FUTURES_BASE_URL || "https://testnet.binancefuture.com";
const binanceApiKey = process.env.BINANCE_API_KEY || "";
const binanceApiSecret = process.env.BINANCE_API_SECRET || "";
const defaultFuturesSymbol = process.env.FUTURES_SYMBOL || "BTCUSDT";
const binanceKlinesUrl = `${binanceFuturesBaseUrl}/fapi/v1/klines`;
const stateFile = "./bot-state.json";
const paperMode = String(process.env.PAPER_MODE || "false").toLowerCase() === "true";

// ─── Polymarket signing config ───
// 0 = EOA wallet
// 1 = Polymarket/Magic proxy
// 2 = Gnosis Safe/proxy
const polymarketSignatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || "0");
const polymarketFunderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || "";

function getPolymarketFunderAddress(walletAddress) {
  return polymarketFunderAddress && ethers.isAddress(polymarketFunderAddress)
    ? ethers.getAddress(polymarketFunderAddress)
    : walletAddress;
}

const privyAppId = process.env.PRIVY_APP_ID || "";
const privyAppSecret = process.env.PRIVY_APP_SECRET || "";
const privyAuthorizationKey = process.env.PRIVY_AUTHORIZATION_KEY || "";

const polygonUsdcEContract = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const polygonNativeUsdcContract = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const defaultUserId = "local-dev";

// الأسماء تبقى للواجهة فقط، لكن منطق السيرفر لا يستخدم أي مؤشرات
const allowedIndicators = ["nebula", "flash", "titan", "phantom", "smart_trook", "turbo"];

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)"
];

const workers = new Map();
const authSessions = new Map();
let usersState = {};

const otpStore = new Map();

const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
const smtpPort = Number(process.env.SMTP_PORT || "587");
const smtpUser = process.env.SMTP_USER || "";
const smtpPass = process.env.SMTP_PASS || "";

function getMailer() {
  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: false,
    auth: { user: smtpUser, pass: smtpPass }
  });
}

async function sendOtpEmail(email, code) {
  const mailer = getMailer();
  await mailer.sendMail({
    from: `"Trook Bot" <${smtpUser}>`,
    to: email,
    subject: "Login Code - Trook Bot",
    html: `
      <div style="font-family:Arial;text-align:center;padding:40px;background:#061426;color:white">
        <h1 style="color:#f5d27a">Trook Bot</h1>
        <p style="color:#aec6eb;font-size:18px">Your login code is:</p>
        <div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#29d687;margin:30px 0">${code}</div>
        <p style="color:#6a8aaa;font-size:14px">This code is valid for 10 minutes.</p>
      </div>
    `
  });
}

function getPrivyClient() {
  if (!privyAppId || !privyAppSecret) {
    throw new Error("privy env variables not configured");
  }
  return new privyClient({
    appId: privyAppId,
    appSecret: privyAppSecret,
    authorizationPrivateKey: privyAuthorizationKey || undefined
  });
}

function isPrivyConfigured() {
  return Boolean(privyAppId && privyAppSecret);
}

async function createPrivyWalletForUser(userId, email) {
  const privy = getPrivyClient();
  const wallet = await privy.walletApi.create({ chainType: "ethereum" });

  if (!wallet?.address || !wallet?.id) {
    throw new Error("failed to create privy wallet");
  }

  addLog("system", `privy wallet created: ${wallet.address} | walletId: ${wallet.id}`);

  return {
    privyUserId: userId,
    walletId: wallet.id,
    walletAddress: ethers.getAddress(wallet.address)
  };
}

// ─── بناء الـ signer لـ Privy ───
function buildPrivySigner(walletAddress, walletId, provider) {
  const privy = getPrivyClient();
  return {
    address: walletAddress,
    provider: provider,
    getAddress: async () => walletAddress,
    signMessage: async (message) => {
      let msg = typeof message === "string" ? message : ethers.hexlify(message);
      const result = await privy.walletApi.signMessage({
        walletId: walletId,
        message: msg
      });
      return result.signature;
    },
    signTypedData: async (domain, types, value) => {
      const filteredTypes = { ...types };
      delete filteredTypes.EIP712Domain;
      const primaryType = Object.keys(filteredTypes)[0] || "Order";
      const result = await privy.walletApi.signTypedData({
        walletId: walletId,
        typedData: {
          domain,
          types: filteredTypes,
          primaryType: primaryType,
          message: value
        }
      });
      return result.signature;
    },
    _signTypedData: async function(domain, types, value) {
      return this.signTypedData(domain, types, value);
    },
    connect: function(p) { return { ...this, provider: p }; },
    _isSigner: true
  };
}

// ─── Binance Futures helpers ───
function isBinanceConfigured() {
  return Boolean(binanceApiKey && binanceApiSecret);
}

function binanceSignature(queryString) {
  return crypto.createHmac("sha256", binanceApiSecret).update(queryString).digest("hex");
}

async function binancePublicRequest(path, params = {}) {
  const r = await axios.get(`${binanceFuturesBaseUrl}${path}`, { params, timeout: 15000 });
  return r.data;
}

async function binanceSignedRequest(method, path, params = {}) {
  if (!isBinanceConfigured()) throw new Error("BINANCE_API_KEY / BINANCE_API_SECRET missing");
  const payload = { ...params, timestamp: Date.now(), recvWindow: 10000 };
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined && v !== null && v !== "") query.append(k, String(v));
  }
  const queryString = query.toString();
  const signature = binanceSignature(queryString);
  const url = `${binanceFuturesBaseUrl}${path}?${queryString}&signature=${signature}`;
  const r = await axios({
    method,
    url,
    timeout: 20000,
    headers: { "X-MBX-APIKEY": binanceApiKey }
  });
  return r.data;
}

const symbolInfoCache = new Map();

async function getSymbolInfo(symbol) {
  const s = String(symbol || defaultFuturesSymbol).toUpperCase();
  if (symbolInfoCache.has(s)) return symbolInfoCache.get(s);
  const info = await binancePublicRequest("/fapi/v1/exchangeInfo");
  const item = info?.symbols?.find((x) => x.symbol === s);
  if (!item) throw new Error(`symbol not found: ${s}`);
  const lot = item.filters?.find((f) => f.filterType === "LOT_SIZE") || {};
  const price = item.filters?.find((f) => f.filterType === "PRICE_FILTER") || {};
  const data = {
    quantityPrecision: Number(item.quantityPrecision || 3),
    pricePrecision: Number(item.pricePrecision || 2),
    stepSize: Number(lot.stepSize || 0.001),
    tickSize: Number(price.tickSize || 0.1)
  };
  symbolInfoCache.set(s, data);
  return data;
}

function floorToStep(value, step) {
  const n = Number(value);
  const st = Number(step);
  if (!Number.isFinite(n) || !Number.isFinite(st) || st <= 0) return n;
  return Math.floor(n / st) * st;
}

function roundToTick(value, tick) {
  const n = Number(value);
  const tk = Number(tick);
  if (!Number.isFinite(n) || !Number.isFinite(tk) || tk <= 0) return n;
  return Math.round(n / tk) * tk;
}

function fmtNumber(value, precision) {
  return Number(value).toFixed(Math.max(0, Number(precision || 0))).replace(/\.?0+$/, "");
}

async function setupBinanceSymbol(userId, symbol, leverage) {
  try {
    await binanceSignedRequest("POST", "/fapi/v1/marginType", { symbol, marginType: "ISOLATED" });
    addLog(userId, `✅ margin type set: ${symbol} ISOLATED`);
  } catch (e) {
    const msg = normalizeError(e);
    if (!msg.includes("No need to change margin type")) addLog(userId, `⚠️ margin type note: ${msg}`);
  }

  const lev = Math.max(1, Math.min(125, Math.floor(Number(leverage || 5))));
  await binanceSignedRequest("POST", "/fapi/v1/leverage", { symbol, leverage: lev });
  addLog(userId, `✅ leverage set: ${symbol} ${lev}x`);
}

async function cancelTradeExitOrders(userId, t) {
  const symbol = t?.symbol;
  if (!symbol || paperMode || !isBinanceConfigured()) return;
  for (const orderId of [t.tpOrderId, t.slOrderId]) {
    if (!orderId) continue;
    try {
      await binanceSignedRequest("DELETE", "/fapi/v1/order", { symbol, orderId });
    } catch (e) {
      const msg = normalizeError(e);
      if (!msg.includes("Unknown order")) addLog(userId, `⚠️ cancel order note: ${msg}`);
    }
  }
}

async function placeBinanceFuturesTrade(userId, pending) {
  const symbol = pending.symbol;
  const side = pending.side === "buy" ? "BUY" : "SELL";
  const exitSide = side === "BUY" ? "SELL" : "BUY";

  await setupBinanceSymbol(userId, symbol, pending.leverage);

  const entryPrice = await getCurrentFuturesPrice(symbol);
  const info = await getSymbolInfo(symbol);
  const notional = Number(pending.marginAmount) * Number(pending.leverage);
  const rawQty = notional / entryPrice;
  const qty = floorToStep(rawQty, info.stepSize);

  if (!Number.isFinite(qty) || qty <= 0) throw new Error("calculated quantity is invalid");

  const targetDistance = Number(pending.targetProfit) / qty;
  const stopDistance = Number(pending.stopLoss) / qty;
  const tpRaw = side === "BUY" ? entryPrice + targetDistance : entryPrice - targetDistance;
  const slRaw = side === "BUY" ? entryPrice - stopDistance : entryPrice + stopDistance;
  const tpPrice = roundToTick(tpRaw, info.tickSize);
  const slPrice = roundToTick(slRaw, info.tickSize);

  const qtyText = fmtNumber(qty, info.quantityPrecision);
  const tpText = fmtNumber(tpPrice, info.pricePrecision);
  const slText = fmtNumber(slPrice, info.pricePrecision);

  const entryOrder = await binanceSignedRequest("POST", "/fapi/v1/order", {
    symbol,
    side,
    type: "MARKET",
    quantity: qtyText
  });

  const tpOrder = await binanceSignedRequest("POST", "/fapi/v1/order", {
    symbol,
    side: exitSide,
    type: "TAKE_PROFIT_MARKET",
    stopPrice: tpText,
    closePosition: "true",
    workingType: "MARK_PRICE"
  });

  const slOrder = await binanceSignedRequest("POST", "/fapi/v1/order", {
    symbol,
    side: exitSide,
    type: "STOP_MARKET",
    stopPrice: slText,
    closePosition: "true",
    workingType: "MARK_PRICE"
  });

  return {
    orderId: entryOrder?.orderId || `binance_${pending.id}`,
    entryOrder,
    tpOrderId: tpOrder?.orderId || null,
    slOrderId: slOrder?.orderId || null,
    entryPrice,
    quantity: qty,
    takeProfitPrice: tpPrice,
    stopLossPrice: slPrice
  };
}

function defaultConfig() {
  return {
    asset: "BTC",
    timeframe: "1m",
    symbol: defaultFuturesSymbol,
    marginType: "ISOLATED",
    leverage: 5,
    tradeAmount: 10,
    baseProfitTarget: 1,
    stopLoss: 1,
    martingaleMultiplier: 2,
    martingaleSteps: 5,
    profitTarget: 10,
    lossLimit: 10,
    direction: "both",
    selectedIndicators: ["smart_trook"]
  };
}

function defaultStatus() {
  return {
    running: false,
    currentTrade: null,
    pendingTrade: null,
    martingaleLossCount: 0,
    totalProfit: 0,
    totalLoss: 0,
    resolvedTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    lastError: null,
    tradeState: "neutral"
  };
}

function createUserState(userId, email = null) {
  return {
    userId,
    email,
    privyWallet: {
      walletId: null,
      walletAddress: null,
      ready: false,
      createdAt: null
    },
    config: defaultConfig(),
    status: defaultStatus(),
    logs: [],
    tradeLogs: [],
    fullTradeLogs: [],
    lastPeriod: null,
    lastSignalKey: null
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function makeUserIdFromEmail(email) {
  const normalized = normalizeEmail(email);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `user_${hash}`;
}

function createAuthToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim();
}

function getUserId(req) {
  const token = getBearerToken(req);
  if (token && authSessions.has(token)) return authSessions.get(token).userId;
  return req.headers["x-user-id"] || req.query.user_id || defaultUserId;
}

function getUserState(userId = defaultUserId, email = null) {
  if (!usersState[userId]) usersState[userId] = createUserState(userId, email);
  if (email && !usersState[userId].email) usersState[userId].email = email;

  usersState[userId].config = { ...defaultConfig(), ...(usersState[userId].config || {}) };
  usersState[userId].status = { ...defaultStatus(), ...(usersState[userId].status || {}) };
  usersState[userId].privyWallet = {
    walletId: null, walletAddress: null, ready: false, createdAt: null,
    ...(usersState[userId].privyWallet || {})
  };

  if (!Array.isArray(usersState[userId].logs)) usersState[userId].logs = [];
  if (!Array.isArray(usersState[userId].tradeLogs)) usersState[userId].tradeLogs = [];
  if (!Array.isArray(usersState[userId].fullTradeLogs)) usersState[userId].fullTradeLogs = [];

  return usersState[userId];
}

function isUserWalletReady(user) {
  return Boolean(
    user?.privyWallet?.ready &&
    user?.privyWallet?.walletAddress &&
    ethers.isAddress(user.privyWallet.walletAddress)
  );
}

function getWalletAddressForUser(user) {
  return isUserWalletReady(user) ? user.privyWallet.walletAddress : null;
}

function addLog(userId, msg) {
  const user = getUserState(userId);
  const line = `[${new Date().toISOString()}] ${msg}`;
  user.logs.push(line);
  if (user.logs.length > 500) user.logs = user.logs.slice(-500);
  console.log(`[${userId}] ${line}`);
}

function addTradeLog(userId, result, amount, side, strategy = "-") {
  const user = getUserState(userId);
  const row = { time: new Date().toISOString(), result, amount, side, strategy };
  user.tradeLogs.push(row);
  if (user.tradeLogs.length > 200) user.tradeLogs = user.tradeLogs.slice(-200);
  user.fullTradeLogs.push(row);
  if (user.fullTradeLogs.length > 5000) user.fullTradeLogs = user.fullTradeLogs.slice(-5000);
  saveState();
}

function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify({ usersState }, null, 2)); } catch {}
}

function loadState() {
  try {
    if (!fs.existsSync(stateFile)) return;
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (data.usersState && typeof data.usersState === "object") {
      usersState = data.usersState;
      for (const userId of Object.keys(usersState)) getUserState(userId);
    }
  } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getProvider() { return new ethers.JsonRpcProvider(polygonRpc); }

function normalizeError(e) {
  return e?.response?.data ? JSON.stringify(e.response.data) : e?.message || String(e);
}

async function readErc20Balance(provider, tokenAddress, walletAddress) {
  try {
    const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
    const raw = await token.balanceOf(walletAddress);
    const balance = Number(ethers.formatUnits(raw, 6));
    return Number.isFinite(balance) ? balance : 0;
  } catch { return 0; }
}

async function getBalance(userId) {
  try {
    if (!isBinanceConfigured()) return 0;
    const rows = await binanceSignedRequest("GET", "/fapi/v2/balance");
    const usdt = Array.isArray(rows) ? rows.find((x) => x.asset === "USDT") : null;
    const balance = Number(usdt?.availableBalance || usdt?.balance || 0);
    return Number.isFinite(balance) ? Math.round(balance * 100) / 100 : 0;
  } catch (e) {
    addLog(userId, `balance error: ${normalizeError(e)}`);
    return 0;
  }
}

async function getCurrentFuturesPrice(symbol = defaultFuturesSymbol) {
  try {
    const r = await axios.get(`${binanceFuturesBaseUrl}/fapi/v1/ticker/price`, {
      params: { symbol },
      timeout: 10000
    });
    return Number(r.data?.price || 0);
  } catch {
    return 0;
  }
}

async function getFuturesKlines(symbol = defaultFuturesSymbol, interval = "1m", limit = 60) {
  const r = await axios.get(binanceKlinesUrl, {
    params: { symbol, interval, limit },
    timeout: 15000
  });
  return Array.isArray(r.data) ? r.data : [];
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function analyzeFuturesMarket(userId) {
  const user = getUserState(userId);
  const config = user.config;
  const symbol = String(config.symbol || defaultFuturesSymbol).toUpperCase();
  const rows = await getFuturesKlines(symbol, "1m", 35);
  if (rows.length < 25) {
    addLog(userId, "⏳ waiting for enough Binance candles...");
    return null;
  }

  const closes = rows.map((r) => Number(r[4])).filter((n) => Number.isFinite(n) && n > 0);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const emaFast = average(closes.slice(-7));
  const emaSlow = average(closes.slice(-21));
  const candleUp = last > prev;
  const candleDown = last < prev;

  let side = null;
  if (emaFast > emaSlow && candleUp) side = "buy";
  if (emaFast < emaSlow && candleDown) side = "sell";

  if (config.direction === "buy" && side === "sell") side = null;
  if (config.direction === "sell" && side === "buy") side = null;

  if (!side) {
    addLog(userId, `⏸️ no futures signal | price=${last} fast=${emaFast.toFixed(2)} slow=${emaSlow.toFixed(2)}`);
    return null;
  }

  addLog(userId, `📊 futures signal: ${side === "buy" ? "LONG" : "SHORT"} | ${symbol} | price=${last}`);
  return {
    side,
    symbol,
    entryBtcPrice: last,
    strategyText: "binance_futures_trend"
  };
}

function getRecoveryTargetProfit(userId) {
  const user = getUserState(userId);
  const step = Math.min(Number(user.status.martingaleLossCount || 0), Number(user.config.martingaleSteps || 1) - 1);
  const base = Number(user.config.baseProfitTarget || user.config.tradeAmount || 1);
  const mult = Number(user.config.martingaleMultiplier || 1);
  return Math.round((base * Math.pow(mult, step)) * 100) / 100;
}

function getTradeAmount(userId) {
  const user = getUserState(userId);
  return Number(user.config.tradeAmount || 10);
}

async function updateTradeState(userId) {
  const user = getUserState(userId);
  const status = user.status;
  if (!status.currentTrade) { status.tradeState = "neutral"; return; }
  const price = await getCurrentFuturesPrice(status.currentTrade.symbol || defaultFuturesSymbol);
  const open = Number(status.currentTrade.entryPrice || 0);
  if (!price || !open) { status.tradeState = "neutral"; return; }
  status.tradeState = status.currentTrade.side === "buy" ? (price >= open ? "win" : "loss") : (price <= open ? "win" : "loss");
}

async function resolveTrade(userId) {
  const user = getUserState(userId);
  const status = user.status;
  const config = user.config;
  if (!status.currentTrade) return;
  const t = status.currentTrade;

  if (paperMode) {
    const price = await getCurrentFuturesPrice(t.symbol || defaultFuturesSymbol);
    if (!price) return;
    const won = t.side === "buy" ? price >= Number(t.takeProfitPrice) : price <= Number(t.takeProfitPrice);
    const lost = t.side === "buy" ? price <= Number(t.stopLossPrice) : price >= Number(t.stopLossPrice);
    if (!won && !lost) return;
    await finalizeTrade(userId, won ? "WIN" : "LOSS", won ? Number(t.targetProfit) : Number(t.stopLoss), t);
    return;
  }

  const tp = t.tpOrderId ? await binanceSignedRequest("GET", "/fapi/v1/order", { symbol: t.symbol, orderId: t.tpOrderId }) : null;
  const sl = t.slOrderId ? await binanceSignedRequest("GET", "/fapi/v1/order", { symbol: t.symbol, orderId: t.slOrderId }) : null;

  if (tp?.status === "FILLED") {
    await cancelTradeExitOrders(userId, { ...t, tpOrderId: null });
    await finalizeTrade(userId, "WIN", Number(t.targetProfit), t);
  } else if (sl?.status === "FILLED") {
    await cancelTradeExitOrders(userId, { ...t, slOrderId: null });
    await finalizeTrade(userId, "LOSS", Number(t.stopLoss), t);
  }
}

async function finalizeTrade(userId, result, amount, t) {
  const user = getUserState(userId);
  const status = user.status;
  const config = user.config;

  if (result === "WIN") {
    status.wins++;
    status.totalProfit = Math.round((Number(status.totalProfit || 0) + Number(amount || 0)) * 100) / 100;
    status.martingaleLossCount = 0;
    addTradeLog(userId, "WIN", Number(amount || 0), t.side, t.strategy || "-");
    addLog(userId, `✅ WIN | target +$${Number(amount || 0).toFixed(2)}`);
  } else {
    status.losses++;
    status.totalLoss = Math.round((Number(status.totalLoss || 0) + Number(amount || 0)) * 100) / 100;
    status.martingaleLossCount++;
    if (status.martingaleLossCount >= Number(config.martingaleSteps || 1)) status.martingaleLossCount = 0;
    addTradeLog(userId, "LOSS", Number(amount || 0), t.side, t.strategy || "-");
    addLog(userId, `❌ LOSS | -$${Number(amount || 0).toFixed(2)} | next target step=${status.martingaleLossCount}`);
  }

  status.resolvedTrades++;
  status.winRate = status.resolvedTrades ? (status.wins / status.resolvedTrades) * 100 : 0;
  status.currentTrade = null;
  status.current_trade = null;
  status.tradeState = "neutral";

  if (Number.isFinite(Number(config.profitTarget)) && status.totalProfit >= Number(config.profitTarget)) {
    status.running = false;
    addLog(userId, `🛑 profit target reached: $${status.totalProfit}`);
  }
  if (Number.isFinite(Number(config.lossLimit)) && status.totalLoss >= Number(config.lossLimit)) {
    status.running = false;
    addLog(userId, `🛑 loss limit reached: $${status.totalLoss}`);
  }
  saveState();
}

async function executeTrade(userId, pending) {
  const user = getUserState(userId);
  const status = user.status;

  try {
    addLog(userId, `🚀 Binance Futures ${pending.side === "buy" ? "LONG" : "SHORT"} | margin=$${pending.marginAmount} | lev=${pending.leverage}x | target=$${pending.targetProfit} | SL=$${pending.stopLoss}`);

    let execution;
    if (paperMode) {
      const info = await getSymbolInfo(pending.symbol);
      const entryPrice = await getCurrentFuturesPrice(pending.symbol);
      const notional = Number(pending.marginAmount) * Number(pending.leverage);
      const qty = floorToStep(notional / entryPrice, info.stepSize);
      const tpRaw = pending.side === "buy" ? entryPrice + Number(pending.targetProfit) / qty : entryPrice - Number(pending.targetProfit) / qty;
      const slRaw = pending.side === "buy" ? entryPrice - Number(pending.stopLoss) / qty : entryPrice + Number(pending.stopLoss) / qty;
      execution = {
        orderId: `paper_${pending.id}`,
        entryPrice,
        quantity: qty,
        takeProfitPrice: roundToTick(tpRaw, info.tickSize),
        stopLossPrice: roundToTick(slRaw, info.tickSize),
        tpOrderId: null,
        slOrderId: null
      };
      addLog(userId, `📄 PAPER futures trade: ${execution.orderId}`);
    } else {
      execution = await placeBinanceFuturesTrade(userId, pending);
      addLog(userId, `✅ Binance order sent: ${execution.orderId}`);
    }

    const currentTrade = {
      orderId: execution.orderId,
      side: pending.side,
      symbol: pending.symbol,
      amount: pending.marginAmount,
      marginAmount: pending.marginAmount,
      leverage: pending.leverage,
      targetProfit: pending.targetProfit,
      stopLoss: pending.stopLoss,
      entryPrice: execution.entryPrice,
      quantity: execution.quantity,
      takeProfitPrice: execution.takeProfitPrice,
      stopLossPrice: execution.stopLossPrice,
      tpOrderId: execution.tpOrderId,
      slOrderId: execution.slOrderId,
      strategy: pending.strategy,
      openedAt: new Date().toISOString()
    };

    status.currentTrade = currentTrade;
    status.current_trade = currentTrade;
    status.pendingTrade = null;
    saveState();
  } catch (e) {
    const msg = normalizeError(e);
    addLog(userId, `❌ Binance trade execution failed: ${msg}`);
    status.lastError = msg;
    status.pendingTrade = null;
    saveState();
  }
}

async function botLoop(userId) {
  if (workers.get(userId)) return;
  workers.set(userId, true);
  addLog(userId, "🤖 Binance Futures Testnet worker started");

  while (getUserState(userId).status.running) {
    try {
      const user = getUserState(userId);
      const status = user.status;
      const config = user.config;

      if (status.currentTrade) {
        await resolveTrade(userId);
        await updateTradeState(userId);
        if (status.currentTrade) {
          await sleep(7000);
          continue;
        }
      }

      if (!status.running) break;

      const signal = await analyzeFuturesMarket(userId);
      if (!signal) {
        await sleep(12000);
        continue;
      }

      const signalKey = `${signal.side}-${signal.symbol}-${Math.floor(Date.now() / 60000)}`;
      if (user.lastSignalKey === signalKey) {
        await sleep(12000);
        continue;
      }

      const marginAmount = getTradeAmount(userId);
      const targetProfit = getRecoveryTargetProfit(userId);
      const stopLoss = Number(config.stopLoss || 1);
      const leverage = Number(config.leverage || 5);

      const pending = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        userId,
        side: signal.side,
        symbol: signal.symbol,
        marginAmount,
        leverage,
        targetProfit,
        stopLoss,
        entryBtcPrice: signal.entryBtcPrice,
        strategy: signal.strategyText
      };

      user.lastSignalKey = signalKey;
      status.pendingTrade = pending;
      saveState();

      await executeTrade(userId, pending);
    } catch (e) {
      const user = getUserState(userId);
      const msg = normalizeError(e);
      user.status.lastError = msg;
      addLog(userId, `bot error: ${msg}`);
      saveState();
      if (msg.includes("429") || msg.includes("418")) {
        addLog(userId, "⏳ Binance rate limit — cooling down 5min");
        await sleep(300000);
      }
    }
    await sleep(7000);
  }

  workers.delete(userId);
  addLog(userId, "🛑 Binance Futures worker stopped");
}

function getTradingCheck(userId) {
  const checks = {
    binanceConfigured: isBinanceConfigured(),
    testnet: binanceFuturesBaseUrl.includes("testnet"),
    paperMode: paperMode
  };
  const ok = checks.binanceConfigured || checks.paperMode;
  return {
    ok,
    mode: ok ? "binance_futures_testnet" : "not_ready",
    checks,
    warning: ok
      ? "Binance Futures Testnet ready — isolated margin + fixed leverage"
      : "BINANCE_API_KEY / BINANCE_API_SECRET missing"
  };
}

app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { email } = req.body || {};
    const normalizedEmail = normalizeEmail(email || "");
    if (!normalizedEmail) return res.json({ ok: false, error: "email is required" });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 10 * 60 * 1000;

    otpStore.set(normalizedEmail, { code, expiresAt });

    await sendOtpEmail(normalizedEmail, code);

    console.log(`otp sent to ${normalizedEmail}: ${code}`);

    res.json({ ok: true, message: "otp sent to your email" });
  } catch (e) {
    res.json({ ok: false, error: normalizeError(e) });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { email, code } = req.body || {};
    const normalizedEmail = normalizeEmail(email || "");

    if (!normalizedEmail || !code) return res.json({ ok: false, error: "email and code required" });

    const stored = otpStore.get(normalizedEmail);
    if (!stored) return res.json({ ok: false, error: "no otp sent for this email" });
    if (Date.now() > stored.expiresAt) {
      otpStore.delete(normalizedEmail);
      return res.json({ ok: false, error: "code expired — send a new one" });
    }
    if (stored.code !== String(code).trim()) {
      return res.json({ ok: false, error: "incorrect code" });
    }

    otpStore.delete(normalizedEmail);

    const userId = makeUserIdFromEmail(normalizedEmail);
    const user = getUserState(userId, normalizedEmail);

    if (isUserWalletReady(user)) {
      const token = createAuthToken();
      authSessions.set(token, { userId, email: normalizedEmail, walletAddress: user.privyWallet.walletAddress, createdAt: Date.now() });
      addLog(userId, `✅ login: ${normalizedEmail}`);
      return res.json({ ok: true, token, user_id: userId, email: normalizedEmail, wallet: user.privyWallet, trading_check: getTradingCheck(userId), isNew: false });
    }

    addLog(userId, `creating privy wallet for ${normalizedEmail}`);
    const { walletId, walletAddress } = await createPrivyWalletForUser(userId, normalizedEmail);

    user.privyWallet = { walletId, walletAddress, ready: true, createdAt: new Date().toISOString() };
    saveState();

    await dbSaveWallet(userId, normalizedEmail, walletId, walletAddress);

    const token = createAuthToken();
    authSessions.set(token, { userId, email: normalizedEmail, walletAddress, createdAt: Date.now() });

    addLog(userId, `✅ new privy wallet created: ${walletAddress}`);

    res.json({ ok: true, token, user_id: userId, email: normalizedEmail, wallet: user.privyWallet, trading_check: getTradingCheck(userId), isNew: true });
  } catch (e) {
    res.json({ ok: false, error: normalizeError(e) });
  }
});

app.post("/api/auth/logout", (req, res) => {
  const token = getBearerToken(req);
  if (token) authSessions.delete(token);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const userId = getUserId(req);
  const user = getUserState(userId);
  res.json({ ok: true, user_id: userId, email: user.email || null, wallet: user.privyWallet, trading_check: getTradingCheck(userId) });
});

app.get("/api/all", async (req, res) => {
  const userId = getUserId(req);
  const user = getUserState(userId);
  await updateTradeState(userId);
  const balance = await getBalance(userId);
  res.json({
    ok: true, user_id: userId, email: user.email || null,
    status: user.status, config: user.config, wallet: user.privyWallet,
    trading_check: getTradingCheck(userId),
    walletInfo: { address: getWalletAddressForUser(user), deposit_address: getWalletAddressForUser(user), balance }
  });
});

app.get("/api/logs", (req, res) => {
  const userId = getUserId(req);
  const user = getUserState(userId);
  res.json({ ok: true, user_id: userId, logs: user.logs, trade_logs: user.tradeLogs, full_trade_logs: user.fullTradeLogs });
});

app.get("/api/user/trading-check", (req, res) => {
  const userId = getUserId(req);
  res.json({ ok: true, user_id: userId, trading_check: getTradingCheck(userId) });
});

app.post("/api/config", (req, res) => {
  const userId = getUserId(req);
  const user = getUserState(userId);
  const nextSymbol = String(req.body?.symbol || req.body?.futures_symbol || user.config.symbol || defaultFuturesSymbol).toUpperCase();
  user.config = {
    ...user.config,
    ...req.body,
    asset: "BTC",
    timeframe: "1m",
    symbol: nextSymbol,
    marginType: "ISOLATED",
    leverage: Math.max(1, Math.min(125, Number(req.body?.leverage || user.config.leverage || 5))),
    tradeAmount: Number(req.body?.trade_amount || req.body?.tradeAmount || user.config.tradeAmount),
    baseProfitTarget: Number(req.body?.base_profit_target || req.body?.baseProfitTarget || user.config.baseProfitTarget || 1),
    stopLoss: Number(req.body?.stop_loss || req.body?.stopLoss || user.config.stopLoss || 1),
    martingaleMultiplier: Number(req.body?.martingale_multiplier || req.body?.martingaleMultiplier || user.config.martingaleMultiplier),
    martingaleSteps: Number(req.body?.martingale_steps || req.body?.martingaleSteps || user.config.martingaleSteps),
    profitTarget: Number(req.body?.profit_target || req.body?.profitTarget || user.config.profitTarget),
    lossLimit: Number(req.body?.loss_limit || req.body?.lossLimit || user.config.lossLimit),
    direction: ["buy", "sell", "both"].includes(req.body?.direction) ? req.body.direction : user.config.direction,
    selectedIndicators: Array.isArray(req.body?.selected_indicators || req.body?.selectedIndicators)
      ? (req.body.selected_indicators || req.body.selectedIndicators).filter((x) => allowedIndicators.includes(x))
      : user.config.selectedIndicators
  };
  saveState();
  res.json({ ok: true, user_id: userId, config: user.config });
});

app.post("/api/start", async (req, res) => {
  const userId = getUserId(req);

  if (userId === defaultUserId) {
    return res.json({ ok: false, error: "login required first" });
  }

  const check = getTradingCheck(userId);
  if (!check.ok) return res.json({ ok: false, error: check.warning, trading_check: check });

  const user = getUserState(userId);
  user.status.running = true;
  user.status.currentTrade = null;
  user.status.current_trade = null;
  user.status.pendingTrade = null;
  user.status.martingaleLossCount = 0;
  user.status.totalProfit = 0;
  user.status.totalLoss = 0;
  user.status.resolvedTrades = 0;
  user.status.wins = 0;
  user.status.losses = 0;
  user.status.winRate = 0;
  user.status.lastError = null;
  user.status.tradeState = "neutral";
  user.tradeLogs = [];
  user.lastPeriod = null;
  user.lastSignalKey = null;
  saveState();

  botLoop(userId);

  res.json({ ok: true, user_id: userId, trading_check: getTradingCheck(userId) });
});

app.post("/api/stop", (req, res) => {
  const userId = getUserId(req);
  const user = getUserState(userId);
  user.status.running = false;
  user.status.pendingTrade = null;
  saveState();
  res.json({ ok: true, user_id: userId });
});

app.post("/api/privy-wallet-sync", async (req, res) => {
  try {
    const userId = getUserId(req);
    const user = getUserState(userId);

    const address = req.body?.address;
    const email = normalizeEmail(req.body?.email || user.email || "");

    if (!address || !ethers.isAddress(address)) {
      return res.json({ ok: false, error: "invalid wallet address" });
    }

    user.email = email || user.email;

    const incomingWalletId = req.body?.wallet_id || req.body?.walletId || null;

    user.privyWallet = {
      ...(user.privyWallet || {}),
      walletId: incomingWalletId || user.privyWallet?.walletId || null,
      walletAddress: ethers.getAddress(address),
      ready: true,
      createdAt: user.privyWallet?.createdAt || new Date().toISOString()
    };

    saveState();

    await dbSaveWallet(userId, user.email, user.privyWallet.walletId, user.privyWallet.walletAddress);

    addLog(userId, `✅ privy wallet synced: ${user.privyWallet.walletAddress}`);

    res.json({ ok: true, wallet: user.privyWallet, trading_check: getTradingCheck(userId) });
  } catch (e) {
    res.json({ ok: false, error: normalizeError(e) });
  }
});

app.post("/api/toggle", async (req, res) => {
  const userId = getUserId(req);
  const target = Boolean(req.body?.running);

  if (target) {
    const check = getTradingCheck(userId);
    if (!check.ok) {
      return res.json({ ok: false, error: check.warning });
    }

    const user = getUserState(userId);
    user.status.running = true;
    saveState();
    botLoop(userId);

    return res.json({ ok: true, running: true });
  }

  const user = getUserState(userId);
  user.status.running = false;
  user.status.pendingTrade = null;
  saveState();

  res.json({ ok: true, running: false });
});

app.post("/api/clear-creds-cache", (req, res) => {
  const userId = getUserId(req);
  symbolInfoCache.clear();
  addLog(userId, "🗑️ Binance symbol cache cleared");
  res.json({ ok: true, message: "Binance symbol cache cleared" });
});

app.get("/api/health", (_, res) => res.json({
  ok: true,
  mode: "binance-futures-testnet",
  paper_mode: paperMode,
  binance_configured: isBinanceConfigured(),
  futures_base_url: binanceFuturesBaseUrl,
  default_symbol: defaultFuturesSymbol
}));

app.get("/health", (_, res) => res.json({ ok: true }));

loadState();
initDb().then(() => {
  app.use(reportRouter);
  app.listen(port, "0.0.0.0", () => {
    console.log(`🚀 server running on port ${port} | Binance Futures Testnet mode`);
    addLog(defaultUserId, "backend ready | Binance Futures Testnet");
  });
});
