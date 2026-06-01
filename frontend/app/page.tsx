"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  encodeFunctionData,
  isAddress,
  parseUnits
} from "viem";
import {
  usePrivy,
  useLoginWithEmail,
  useWallets,
  useCreateWallet
} from "@privy-io/react-auth";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  "https://4-all-trook-bot-production.up.railway.app";

const POLYGON_CHAIN_ID_HEX = "0x89";
const POLYGON_USDC_E_CONTRACT =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const USDC_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;

type PageName = "home" | "settings" | "strategy" | "wallet" | "logs";
type WalletMode = "main" | "deposit" | "withdraw";
type Direction = "buy" | "sell" | "both";

type Config = {
  asset: string;
  timeframe: string;
  symbol: string;
  leverage: number | string;
  trade_amount: number | string;
  base_profit_target: number | string;
  stop_loss: number | string;
  martingale_multiplier: number | string;
  martingale_steps: number | string;
  profit_target: number | string;
  loss_limit: number | string;
  direction: Direction;
  selected_indicators: string[];
};

type Status = {
  running: boolean;
  current_trade: any;
  martingale_loss_count: number;
  total_profit: number;
  total_loss: number;
  resolved_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  last_error: string | null;
  trade_state?: "neutral" | "win" | "loss";
  tradeState?: "neutral" | "win" | "loss";
};

type Wallet = {
  address: string;
  deposit_address: string;
  balance: number;
};

type TradeLog = {
  time: string;
  result: string;
  amount: number;
  side?: "buy" | "sell";
};

const allIndicators = [
  "nebula",
  "flash",
  "titan",
  "phantom",
  "smart_trook",
  "turbo"
];

const strategyNames: Record<string, string> = {
  nebula: "Nebula Pulse 🌌",
  flash: "Flash Reversal ⚡",
  titan: "Titan Trend 🛡️",
  phantom: "Phantom Breakout 👻",
  smart_trook: "Smart Trook 🎯",
  turbo: "Turbo Scalper ⚡"
};

function getBrowserUserId() {
  if (typeof window === "undefined") return "local-dev";

  let id = window.localStorage.getItem("trook_user_id");

  if (!id) {
    id = `user_${crypto.randomUUID()}`;
    window.localStorage.setItem("trook_user_id", id);
  }

  return id;
}

function shortAddress(address?: string) {
  if (!address) return "-";
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizeError(e: any) {
  return e?.response?.data?.error || e?.message || String(e);
}

function findPrivyWallet(wallets: any[]) {
  return (
    wallets?.find((w: any) => w?.walletClientType === "privy") ||
    wallets?.find((w: any) => w?.connectorType === "embedded") ||
    wallets?.find((w: any) => w?.address) ||
    null
  );
}

function getPrivyWalletIdFromObject(wallet: any) {
  return (
    wallet?.id ||
    wallet?.walletId ||
    wallet?.wallet_id ||
    wallet?.delegatedWalletId ||
    wallet?.linkedAccountId ||
    wallet?.account?.id ||
    wallet?.metadata?.id ||
    ""
  );
}

export default function Page() {
  const { authenticated, logout, user, ready, getAccessToken } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();

  const [authToken, setAuthToken] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);

  const [userId, setUserId] = useState("local-dev");
  const [tradingReady, setTradingReady] = useState(false);
  const [turnkeyMode, setTurnkeyMode] = useState("not_ready");
  const [turnkeyWarning, setTurnkeyWarning] = useState("");

  const [page, setPage] = useState<PageName>("home");
  const [now, setNow] = useState(Date.now());
  const [walletMode, setWalletMode] = useState<WalletMode>("main");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [withdrawTo, setWithdrawTo] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");

  const [wallet, setWallet] = useState<Wallet>({
    address: "",
    deposit_address: "",
    balance: 0
  });

  const [status, setStatus] = useState<Status>({
    running: false,
    current_trade: null,
    martingale_loss_count: 0,
    total_profit: 0,
    total_loss: 0,
    resolved_trades: 0,
    wins: 0,
    losses: 0,
    win_rate: 0,
    last_error: null,
    trade_state: "neutral"
  });

  const [config, setConfig] = useState<Config>({
    asset: "BTC",
    timeframe: "1m",
    symbol: "BTCUSDT",
    leverage: 5,
    trade_amount: 10,
    base_profit_target: 1,
    stop_loss: 1,
    martingale_multiplier: 2,
    martingale_steps: 5,
    profit_target: 10,
    loss_limit: 10,
    direction: "both",
    selected_indicators: allIndicators
  });

  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);

  function apiHeaders(extra?: Record<string, string>) {
    const token =
      authToken ||
      (typeof window !== "undefined"
        ? window.localStorage.getItem("trook_auth_token") || ""
        : "");

    return {
      "x-user-id": userId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extra || {})
    };
  }

  async function syncPrivyWalletToBackend() {
    if (!authenticated) return;

    const privyUserId = user?.id || getBrowserUserId();
    const userEmail = user?.email?.address || email.trim();

    setUserId(privyUserId);
    window.localStorage.setItem("trook_user_id", privyUserId);

    let embeddedWallet: any = findPrivyWallet(wallets as any[]);

    try {
      if (!embeddedWallet?.address && createWallet) {
        setAuthMessage("جاري إنشاء محفظة Privy...");
        embeddedWallet = await createWallet();
      }
    } catch (e: any) {
      setAuthMessage(e?.message || "فشل إنشاء محفظة Privy");
    }

    console.log("PRIVY USER DEBUG:", user);
    console.log("PRIVY EMBEDDED WALLET DEBUG:", embeddedWallet);
    console.log("PRIVY ALL WALLETS DEBUG:", wallets);

    const walletAddress = embeddedWallet?.address || "";
    const walletId = getPrivyWalletIdFromObject(embeddedWallet);

    if (!walletAddress) {
      setAuthMessage("لم يتم العثور على عنوان محفظة Privy");
      return;
    }

    if (!walletId) {
      setAuthMessage(
        "محفظة Privy موجودة، لكن لم يتم العثور على walletId المطلوب لتوقيع السيرفر. افتح Console وصوّر بيانات PRIVY EMBEDDED WALLET DEBUG."
      );
    }

    setWallet((p) => ({
      ...p,
      address: walletAddress,
      deposit_address: walletAddress
    }));

    const token = (await getAccessToken?.().catch(() => "")) || "privy-authenticated";
    setAuthToken(token);
    window.localStorage.setItem("trook_auth_token", token);

    const payload = {
      privy_user_id: privyUserId,
      user_id: privyUserId,
      email: userEmail,
      wallet_address: walletAddress,
      address: walletAddress,
      wallet_id: walletId,
      walletId: walletId
    };

    try {
      const r = await fetch(`${API}/api/privy-wallet-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": privyUserId,
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload)
      });

      const j = await r.json().catch(() => ({}));

      if (j?.token) {
        window.localStorage.setItem("trook_auth_token", j.token);
        setAuthToken(j.token);
      }

      if (j?.user_id) {
        window.localStorage.setItem("trook_user_id", j.user_id);
        setUserId(j.user_id);
      }

      if (j?.ok && walletId) {
        setAuthMessage("");
      }

      if (!j?.ok) {
        setAuthMessage(j?.error || "فشل مزامنة محفظة Privy مع الباكند");
      }
    } catch (e: any) {
      setAuthMessage(e?.message || "فشل الاتصال أثناء مزامنة محفظة Privy");
    }

    await loadAll();
    await loadLogs();
    await loadTradingCheck();
  }

  async function handleSendCode() {
    if (!email.trim()) {
      setAuthMessage("أدخل البريد الإلكتروني");
      return;
    }

    setAuthLoading(true);
    setAuthMessage("جاري إرسال الكود...");

    try {
      await sendCode({ email: email.trim() });
      setOtpSent(true);
      setAuthMessage("تم إرسال الكود لبريدك ✅");
    } catch (e: any) {
      setAuthMessage(e?.message || normalizeError(e) || "فشل إرسال الكود");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleVerifyCode() {
    if (!otp.trim()) {
      setAuthMessage("أدخل كود التحقق");
      return;
    }

    setAuthLoading(true);
    setAuthMessage("جاري التحقق...");

    try {
      await loginWithCode({ code: otp.trim() });
      setOtpSent(false);
      setOtp("");
      setAuthMessage("تم الدخول، جاري تجهيز المحفظة...");
    } catch (e: any) {
      setAuthMessage(e?.message || normalizeError(e) || "الكود غير صحيح");
    } finally {
      setAuthLoading(false);
    }
  }

  async function doLogout() {
    try {
      const token = window.localStorage.getItem("trook_auth_token") || "";

      if (token) {
        await fetch(`${API}/api/auth/logout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`
          }
        });
      }

      await logout();
    } catch {}

    window.localStorage.removeItem("trook_auth_token");
    window.localStorage.removeItem("trook_user_id");

    setAuthToken("");
    setUserId("local-dev");
    setTradingReady(false);
    setTurnkeyMode("not_ready");
    setTurnkeyWarning("");
    setWallet({
      address: "",
      deposit_address: "",
      balance: 0
    });
  }

  async function loadTradingCheck() {
    try {
      const r = await fetch(`${API}/api/user/trading-check`, {
        cache: "no-store",
        headers: apiHeaders()
      });

      const j = await r.json();
      const check = j?.trading_check;

      if (check) {
        setTradingReady(Boolean(check.ok));
        setTurnkeyMode(check.mode || "not_ready");
        setTurnkeyWarning(check.warning || "");
      }
    } catch {
      setTradingReady(false);
      setTurnkeyMode("not_ready");
      setTurnkeyWarning("فشل فحص جاهزية Privy");
    }
  }

  async function loadAll() {
    try {
      const r = await fetch(`${API}/api/all`, {
        cache: "no-store",
        headers: apiHeaders()
      });

      const j = await r.json();

      if (j?.ok) {
        const serverAddress =
          j.wallet?.address ||
          j.walletInfo?.address ||
          j.wallet?.walletAddress ||
          "";

        const serverDeposit =
          j.wallet?.deposit_address ||
          j.walletInfo?.deposit_address ||
          j.wallet?.walletAddress ||
          "";

        setWallet((p) => ({
          address: serverAddress || p.address,
          deposit_address: serverDeposit || serverAddress || p.deposit_address,
          balance: Number(j.wallet?.balance || j.walletInfo?.balance || 0)
        }));

        setStatus((p) => ({ ...p, ...(j.status || {}) }));

        if (page !== "settings" && page !== "strategy") {
          const incomingConfig = j.config || {};
          setConfig((p) => ({
            ...p,
            ...incomingConfig,
            trade_amount: incomingConfig.trade_amount ?? incomingConfig.tradeAmount ?? p.trade_amount,
            base_profit_target: incomingConfig.base_profit_target ?? incomingConfig.baseProfitTarget ?? p.base_profit_target,
            stop_loss: incomingConfig.stop_loss ?? incomingConfig.stopLoss ?? p.stop_loss,
            martingale_multiplier: incomingConfig.martingale_multiplier ?? incomingConfig.martingaleMultiplier ?? p.martingale_multiplier,
            martingale_steps: incomingConfig.martingale_steps ?? incomingConfig.martingaleSteps ?? p.martingale_steps,
            profit_target: incomingConfig.profit_target ?? incomingConfig.profitTarget ?? p.profit_target,
            loss_limit: incomingConfig.loss_limit ?? incomingConfig.lossLimit ?? p.loss_limit,
            selected_indicators: Array.isArray(incomingConfig.selected_indicators)
              ? incomingConfig.selected_indicators.filter((x: string) =>
                  allIndicators.includes(x)
                )
              : p.selected_indicators
          }));
        }
      }
    } catch {
      setMessage("فشل الاتصال بالباكند");
    }
  }

  async function loadLogs() {
    try {
      const r = await fetch(`${API}/api/logs`, {
        cache: "no-store",
        headers: apiHeaders()
      });

      const j = await r.json();

      if (j?.ok) {
        setTradeLogs(j.trade_logs || []);
      }
    } catch {}
  }

  async function startBot() {
    setMessage("");

    try {
      const r = await fetch(`${API}/api/start`, {
        method: "POST",
        headers: apiHeaders()
      });

      const j = await r.json();

      if (!j?.ok) {
        setMessage(
          j?.trading_check?.warning ||
            j?.error ||
            "المحفظة غير جاهزة للتداول"
        );
        await loadAll();
        await loadLogs();
        await loadTradingCheck();
        return;
      }

      setMessage("تم تشغيل البوت");
      await loadAll();
      await loadLogs();
      await loadTradingCheck();
    } catch {
      setMessage("فشل الاتصال أثناء التشغيل");
    }
  }

  async function stopBot() {
    setMessage("");

    await fetch(`${API}/api/stop`, {
      method: "POST",
      headers: apiHeaders()
    });

    await loadAll();
    await loadLogs();
    await loadTradingCheck();
  }

  async function saveConfig() {
    setSaving(true);
    setMessage("");

    try {
      const cleanConfig = {
        ...config,
        symbol: String(config.symbol || "BTCUSDT").toUpperCase(),
        leverage: Number(config.leverage),
        trade_amount: Number(config.trade_amount),
        base_profit_target: Number(config.base_profit_target),
        stop_loss: Number(config.stop_loss),
        martingale_multiplier: Number(config.martingale_multiplier),
        martingale_steps: Number(config.martingale_steps),
        profit_target: Number(config.profit_target),
        loss_limit: Number(config.loss_limit),
        selected_indicators: config.selected_indicators.filter((x) =>
          allIndicators.includes(x)
        )
      };

      const r = await fetch(`${API}/api/config`, {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(cleanConfig)
      });

      const j = await r.json();

      if (j?.ok) {
        setMessage("تم الحفظ بنجاح");
        setPage("home");
        await loadAll();
        await loadLogs();
        await loadTradingCheck();
      } else {
        setMessage("فشل الحفظ");
      }
    } catch {
      setMessage("فشل الاتصال أثناء الحفظ");
    }

    setSaving(false);
  }

  async function withdraw() {
    const to = withdrawTo.trim();
    const amountText = String(withdrawAmount || "").trim();
    const amountNumber = Number(amountText);

    if (!to || !amountText) {
      setMessage("اكتب عنوان المستلم والمبلغ");
      return;
    }

    if (!isAddress(to)) {
      setMessage("عنوان المستلم غير صحيح");
      return;
    }

    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setMessage("مبلغ السحب غير صحيح");
      return;
    }

    const embeddedWallet = findPrivyWallet(wallets as any[]);

    if (!embeddedWallet?.address) {
      setMessage("محفظة Privy غير موجودة");
      return;
    }

    const ok = window.confirm(
      `تأكيد سحب ${amountText} USDC.e على Polygon إلى:\n${to}\n\nسيطلب منك Privy توقيع العملية من الواجهة.`
    );

    if (!ok) return;

    setSaving(true);
    setMessage("افتح نافذة Privy ووقّع عملية السحب...");

    try {
      if (typeof embeddedWallet.switchChain === "function") {
        try {
          await embeddedWallet.switchChain(137);
        } catch {}
      }

      const provider =
        typeof embeddedWallet.getEthereumProvider === "function"
          ? await embeddedWallet.getEthereumProvider()
          : null;

      if (!provider?.request) {
        setMessage("تعذر فتح مزود محفظة Privy للتوقيع");
        setSaving(false);
        return;
      }

      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: POLYGON_CHAIN_ID_HEX }]
        });
      } catch {}

      const amount = parseUnits(amountText, 6);

      const data = encodeFunctionData({
        abi: USDC_TRANSFER_ABI,
        functionName: "transfer",
        args: [to as `0x${string}`, amount]
      });

      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: embeddedWallet.address,
            to: POLYGON_USDC_E_CONTRACT,
            data,
            value: "0x0"
          }
        ]
      });

      setMessage(`تم إرسال السحب بنجاح ✅ TX: ${String(txHash).slice(0, 10)}...`);
      setWithdrawTo("");
      setWithdrawAmount("");

      setTimeout(() => {
        loadAll();
      }, 2500);
    } catch (e: any) {
      setMessage(e?.message || "فشل توقيع أو إرسال السحب");
    }

    setSaving(false);
  }

  function toggleIndicator(name: string) {
    const exists = config.selected_indicators.includes(name);

    setConfig({
      ...config,
      selected_indicators: exists
        ? config.selected_indicators.filter((x) => x !== name)
        : [...config.selected_indicators, name]
    });
  }

  function copy(text?: string) {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setMessage("تم نسخ العنوان");
  }

  useEffect(() => {
    const savedUserId = window.localStorage.getItem("trook_user_id") || "";
    if (savedUserId) setUserId(savedUserId);
    else setUserId(getBrowserUserId());
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    syncPrivyWalletToBackend();
  }, [authenticated, user?.id, wallets.length]);

  useEffect(() => {
    if (!authToken) return;

    loadAll();
    loadLogs();
    loadTradingCheck();

    const t = setInterval(() => {
      loadAll();
    }, 15000);

    const t2 = setInterval(() => {
      loadLogs();
    }, 30000);

    const t3 = setInterval(() => {
      loadTradingCheck();
    }, 60000);

    const t4 = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(t);
      clearInterval(t2);
      clearInterval(t3);
      clearInterval(t4);
    };
  }, [page, userId, authToken]);

  if (!ready) {
    return (
      <Shell>
        <section className="hero">
          <h1>Trook Bot V2</h1>
          <p>جاري تجهيز Privy...</p>
        </section>
        <Style />
      </Shell>
    );
  }

  if (!authenticated) {
    return (
      <Shell>
        <section className="hero">
          <h1>Trook Bot V2</h1>
          <p>Binance Futures Testnet</p>

          <div className="tradeBox idle">
            <strong>سجل الدخول أولًا</strong>
            <p className="hint">
              أدخل بريدك وسيصلك كود التحقق من Privy.
            </p>
          </div>

          <label className="field">
            <span>البريد الإلكتروني</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@gmail.com"
              dir="ltr"
              onKeyDown={(e) => e.key === "Enter" && handleSendCode()}
            />
          </label>

          {otpSent && (
            <label className="field">
              <span>كود التحقق</span>
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="123456"
                dir="ltr"
                onKeyDown={(e) => e.key === "Enter" && handleVerifyCode()}
              />
            </label>
          )}

          {authMessage && <div className="notice">{authMessage}</div>}

          {!otpSent ? (
            <button className="saveBtn" onClick={handleSendCode} disabled={authLoading}>
              {authLoading ? "جاري الإرسال..." : "إرسال كود التحقق"}
            </button>
          ) : (
            <>
              <button className="saveBtn" onClick={handleVerifyCode} disabled={authLoading}>
                {authLoading ? "جاري التحقق..." : "تأكيد الدخول"}
              </button>
              <button
                className="saveBtn secondary"
                onClick={() => {
                  setOtpSent(false);
                  setOtp("");
                  setAuthMessage("");
                }}
                disabled={authLoading}
              >
                تغيير البريد
              </button>
            </>
          )}
        </section>

        <Style />
      </Shell>
    );
  }

  if (!authToken) {
    return (
      <Shell>
        <section className="hero">
          <h1>Trook Bot V2</h1>
          <p>جاري تجهيز المحفظة...</p>
          {authMessage && <div className="notice">{authMessage}</div>}
        </section>
        <Style />
      </Shell>
    );
  }

  if (page === "settings") {
    return (
      <Shell>
        <Back title="الإعدادات" onBack={() => setPage("home")} />

        <Card>
          <div className="infoGrid">
            <SmallBox title="السوق" value={String(config.symbol || "BTCUSDT")} />
            <SmallBox title="النظام" value="Binance Futures Testnet" />
          </div>

          <Input label="رمز التداول" value={config.symbol} onChange={(v) => setConfig({ ...config, symbol: String(v).toUpperCase() })} />
          <Input label="حجم الرافعة" value={config.leverage} onChange={(v) => setConfig({ ...config, leverage: v })} />
          <Input label="هامش الصفقة USDT" value={config.trade_amount} onChange={(v) => setConfig({ ...config, trade_amount: v })} />
          <Input label="هدف الصفقة الواحدة USDT" value={config.base_profit_target} onChange={(v) => setConfig({ ...config, base_profit_target: v })} />
          <Input label="وقف خسارة الصفقة الواحدة USDT" value={config.stop_loss} onChange={(v) => setConfig({ ...config, stop_loss: v })} />
          <Input label="مضاعف هدف الربح بعد الخسارة" value={config.martingale_multiplier} onChange={(v) => setConfig({ ...config, martingale_multiplier: v })} />
          <Input label="عدد خطوات المضاعفة" value={config.martingale_steps} onChange={(v) => setConfig({ ...config, martingale_steps: v })} />
          <Input label="هدف الربح الإجمالي" value={config.profit_target} onChange={(v) => setConfig({ ...config, profit_target: v })} />
          <Input label="حد الخسارة الإجمالي" value={config.loss_limit} onChange={(v) => setConfig({ ...config, loss_limit: v })} />

          <label className="field">
            <span>نوع الصفقة</span>
            <select value={config.direction} onChange={(e) => setConfig({ ...config, direction: e.target.value as Direction })}>
              <option value="both">شراء وبيع</option>
              <option value="buy">LONG فقط</option>
              <option value="sell">SHORT فقط</option>
            </select>
          </label>

          <button className="saveBtn" onClick={saveConfig} disabled={saving}>
            {saving ? "جاري الحفظ..." : "حفظ ورجوع"}
          </button>
        </Card>

        <Style />
      </Shell>
    );
  }

  if (page === "strategy") {
    return (
      <Shell>
        <Back title="الاستراتيجية" onBack={() => setPage("home")} />

        <Card>
          <div className="indicators">
            {allIndicators.map((x) => (
              <button
                key={x}
                onClick={() => toggleIndicator(x)}
                className={`indicator ${config.selected_indicators.includes(x) ? "active" : ""}`}
              >
                {strategyNames[x] || x}
              </button>
            ))}
          </div>

          <button className="saveBtn" onClick={saveConfig} disabled={saving}>
            {saving ? "جاري الحفظ..." : "حفظ ورجوع"}
          </button>
        </Card>

        <Style />
      </Shell>
    );
  }

  if (page === "wallet") {
    return (
      <Shell>
        <Back title="المحفظة" onBack={() => setPage("home")} />

        <Card>
          <div className="walletBalance">
            <span>الرصيد</span>
            <strong>{wallet.balance.toFixed(2)} USDC</strong>
          </div>

          <div className="tabs">
            <button className={walletMode === "main" ? "active" : ""} onClick={() => setWalletMode("main")}>عام</button>
            <button className={walletMode === "deposit" ? "active" : ""} onClick={() => setWalletMode("deposit")}>إيداع</button>
            <button className={walletMode === "withdraw" ? "active" : ""} onClick={() => setWalletMode("withdraw")}>سحب</button>
          </div>

          {walletMode === "main" && (
            <>
              <Info label="عنوان التداول" value={wallet.address || "-"} />
              <Info label="عنوان الإيداع" value={wallet.deposit_address || "-"} />

              <div className={`turnkeyStatus ${tradingReady ? "ready" : "notReady"}`}>
                <strong>Privy:</strong>{" "}
                {tradingReady ? "جاهز للتداول" : "غير جاهز"}
                <br />
                <span>{turnkeyMode}</span>
                {turnkeyWarning && <p>{turnkeyWarning}</p>}
              </div>
            </>
          )}

          {walletMode === "deposit" && (
            <>
              <div className="depositOptions">
                <div className="depositBox">
                  <h3>إيداع بعنوان المحفظة</h3>
                  <div className="qr">USDC<br />Polygon</div>
                  <p className="hint gold">أرسل USDC فقط على شبكة Polygon لهذا العنوان.</p>
                  <Info label="عنوان الإيداع" value={wallet.deposit_address || "-"} />
                  <button className="saveBtn" onClick={() => copy(wallet.deposit_address)}>
                    نسخ عنوان الإيداع
                  </button>
                </div>

                <div className="depositBox">
                  <h3>شراء بالفيزا 💳</h3>
                  <p className="hint">اشحن رصيدك مباشرة بالبطاقة. سيتم تفعيلها لاحقًا.</p>
                  <button
                    className="saveBtn"
                    disabled={true}
                  >
                    شراء USDC بالبطاقة قريبًا
                  </button>
                </div>
              </div>
            </>
          )}

          {walletMode === "withdraw" && (
            <>
              <p className="hint danger">
                السحب يتم من الواجهة مباشرة بتوقيع المستخدم عبر محفظة Privy.
                جرّب أول مرة بمبلغ صغير مثل 0.1 USDC.
              </p>

              <label className="field">
                <span>عنوان المستلم</span>
                <input value={withdrawTo} onChange={(e) => setWithdrawTo(e.target.value)} placeholder="0x..." />
              </label>

              <label className="field">
                <span>المبلغ USDC</span>
                <input type="number" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} placeholder="0" />
              </label>

              <button className="dangerBtn" onClick={withdraw} disabled={saving || !wallet.address}>
                {saving ? "جاري فتح التوقيع..." : "سحب بتوقيع المستخدم"}
              </button>
            </>
          )}
        </Card>

        <Style />
      </Shell>
    );
  }

  if (page === "logs") {
    return (
      <Shell>
        <div className="back">
          <button onClick={() => setPage("home")}>رجوع</button>
          <h1>سجل الصفقات</h1>
          <button onClick={() => window.open(`${API}/api/report/pdf`)}>كامل السجل</button>
        </div>

        <Card>
          {tradeLogs.length === 0 ? (
            <div className="empty">لا توجد نتائج صفقات بعد</div>
          ) : (
            <div className="tradeLogs">
              {tradeLogs.slice().reverse().map((x, i) => (
                <div key={i} className={`tradeLine ${x.result === "WIN" ? "win" : "loss"}`}>
                  <div className="logLeft">
                    {x.side === "buy" && <span className="arrow up">▲</span>}
                    {x.side === "sell" && <span className="arrow down">▼</span>}
                    <div>
                      <strong>{x.result === "WIN" ? "ربح" : "خسارة"}</strong>
                      <span>{new Date(x.time).toLocaleString("ar-SA")}</span>
                    </div>
                  </div>
                  <b>${Number(x.amount || 0).toFixed(2)}</b>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Style />
      </Shell>
    );
  }

  const tradeState = status.trade_state || status.tradeState || "neutral";

  return (
    <Shell>
      {message && <div className="notice">{message}</div>}

      <section className="hero">
        <div style={{ textAlign: "left", marginBottom: 10 }}>
          <button className="logoutBtn" onClick={doLogout}>
            خروج
          </button>
        </div>

        <h1>Trook Bot V2</h1>
        <p>Binance Futures Testnet</p>

        <div className="balance">{wallet.balance.toFixed(2)} USDT</div>

        {status.current_trade && (
          <div className={`tradeBox ${tradeState}`}>
            <div className="tradeTop">
              <span className={`dot ${tradeState}`}></span>
              {status.current_trade?.side === "buy" && (
                <span className="arrow up">▲</span>
              )}
              {status.current_trade?.side === "sell" && (
                <span className="arrow down">▼</span>
              )}
              <strong>صفقة Futures نشطة</strong>
              <span className="seconds">{status.current_trade?.side === "buy" ? "LONG" : "SHORT"}</span>
            </div>

            <div className="timeText">
              {String(status.current_trade?.symbol || "BTCUSDT")} | Isolated | {Number(status.current_trade?.leverage || 0)}x
            </div>

            <div className="tradeAmount">
              الهامش : ${Number(status.current_trade?.marginAmount || status.current_trade?.amount || 0).toFixed(2)}
            </div>

            <div className="tradeAmount">
              الهدف : ${Number(status.current_trade?.targetProfit || 0).toFixed(2)} | الوقف : ${Number(status.current_trade?.stopLoss || 0).toFixed(2)}
            </div>

            <div className="tradeAmount">
              الدخول : {Number(status.current_trade?.entryPrice || 0).toFixed(2)} | TP: {Number(status.current_trade?.takeProfitPrice || 0).toFixed(2)} | SL: {Number(status.current_trade?.stopLossPrice || 0).toFixed(2)}
            </div>
          </div>
        )}

        {!status.current_trade && (
          <div className="tradeBox idle">
            <strong>لا يوجد صفقة نشطة</strong>
          </div>
        )}

        <button
          className={`power ${status.running ? "stop" : ""}`}
          onClick={status.running ? stopBot : startBot}
          disabled={!status.running && !tradingReady}
          title={!tradingReady ? turnkeyWarning : ""}
        >
          {status.running ? "إيقاف" : "تشغيل"}
        </button>

        <div className={`turnkeyStatus ${tradingReady ? "ready" : "notReady"}`}>
          <strong>Privy:</strong>{" "}
          {tradingReady ? "جاهز للتداول" : "غير جاهز"}
          <br />
          <span>{turnkeyMode}</span>
          {turnkeyWarning && <p>{turnkeyWarning}</p>}
        </div>
      </section>

      <Card>
        <div className="menuGrid">
          <Menu title="الإعدادات" sub="المبلغ والمضاعفات" onClick={() => setPage("settings")} />
          <Menu title="الاستراتيجية" sub="المؤشرات" onClick={() => setPage("strategy")} />
          <Menu title="المحفظة" sub="إيداع وسحب" onClick={() => setPage("wallet")} />
          <Menu title="السجل" sub="ربح وخسارة فقط" onClick={() => setPage("logs")} />
        </div>
      </Card>

      <Card>
        <h2>الإحصائية العامة</h2>
        <Stats status={status} />
      </Card>

      <Style />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="app">{children}</main>;
}

function Card({ children }: { children: ReactNode }) {
  return <section className="card">{children}</section>;
}

function Back({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="back">
      <button onClick={onBack}>رجوع</button>
      <h1>{title}</h1>
    </div>
  );
}

function Menu({ title, sub, onClick }: { title: string; sub: string; onClick: () => void }) {
  return (
    <button className="menu" onClick={onClick}>
      <strong>{title}</strong>
      <span>{sub}</span>
    </button>
  );
}

function Input({
  label,
  value,
  onChange
}: {
  label: string;
  value: number | string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SmallBox({ title, value }: { title: string; value: string }) {
  return (
    <div className="smallBox">
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Stats({ status }: { status: Status }) {
  return (
    <div className="stats">
      <Stat label="الربح" value={`$${Number(status.total_profit || 0).toFixed(2)}`} />
      <Stat label="الخسارة" value={`$${Number(status.total_loss || 0).toFixed(2)}`} />
      <Stat label="الصفقات" value={status.resolved_trades || 0} />
      <Stat label="الفوز" value={`${Number(status.win_rate || 0).toFixed(1)}%`} />
      <Stat label="الرابحة" value={status.wins || 0} />
      <Stat label="الخاسرة" value={status.losses || 0} />
      <Stat label="المضاعفة" value={status.martingale_loss_count || 0} />
      <Stat label="صفقة نشطة" value={status.current_trade ? "نعم" : "لا"} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Style() {
  return (
    <style jsx global>{`
      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: #061426;
        color: white;
        font-family: Arial, sans-serif;
      }

      .app {
        min-height: 100vh;
        padding: 22px;
        background:
          radial-gradient(circle at top left, rgba(49, 212, 161, 0.25), transparent 36%),
          radial-gradient(circle at top right, rgba(24, 124, 255, 0.34), transparent 40%),
          linear-gradient(180deg, #092b55 0%, #061426 42%, #030813 100%);
      }

      .hero,
      .card {
        max-width: 860px;
        margin: 0 auto 20px;
        border-radius: 34px;
        padding: 30px;
        background: linear-gradient(145deg, rgba(6, 32, 62, 0.96), rgba(5, 18, 39, 0.95));
        border: 1px solid rgba(245, 210, 122, 0.22);
        box-shadow: 0 20px 70px rgba(0,0,0,.34);
      }

      .hero { text-align: center; }

      h1 {
        margin: 0;
        font-size: 46px;
        color: #f5d27a;
        font-weight: 900;
      }

      h2 {
        margin: 0 0 22px;
        font-size: 36px;
        color: #f5d27a;
        font-weight: 900;
      }

      p,
      .hint {
        color: #aec6eb;
        line-height: 1.7;
        font-size: 24px;
      }

      .balance {
        width: fit-content;
        margin: 24px auto 8px;
        padding: 16px 34px;
        border-radius: 999px;
        color: #7fffba;
        background: rgba(45,212,130,.14);
        border: 1px solid rgba(80,255,170,.28);
        font-size: 38px;
        font-weight: 900;
      }

      .tradeBox {
        margin: 16px auto 0;
        padding: 18px;
        border-radius: 22px;
        background: rgba(255, 255, 255, .06);
        border: 1px solid rgba(255, 255, 255, .15);
        max-width: 860px;
      }

      .tradeBox.win {
        background: rgba(45, 212, 130, 0.16);
        border: 1px solid rgba(80, 255, 170, .45);
      }

      .tradeBox.loss {
        background: rgba(255, 80, 110, 0.16);
        border: 1px solid rgba(255, 80, 110, .50);
      }

      .tradeBox.neutral {
        background: rgba(255, 255, 255, .06);
        border: 1px solid rgba(255, 255, 255, .15);
      }

      .tradeBox.idle {
        background: rgba(255, 255, 255, .06);
        border: 1px solid rgba(255, 255, 255, .15);
        text-align: center;
      }

      .tradeTop {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .dot {
        width: 10px;
        height: 10px;
        background: #9eb6dc;
        border-radius: 50%;
        margin-left: 8px;
      }

      .dot.win { background: #2ddb91; }
      .dot.loss { background: #ff596a; }
      .dot.neutral { background: #9eb6dc; }

      .arrow {
        font-size: 22px;
        margin-left: 8px;
      }

      .arrow.up { color: #2ddb91; }
      .arrow.down { color: #ff596a; }

      .seconds {
        font-size: 22px;
        font-weight: bold;
      }

      .timeText {
        margin-top: 6px;
        color: #9eb6dc;
        font-size: 16px;
      }

      .tradeAmount {
        margin-top: 6px;
        font-size: 22px;
        font-weight: 900;
        text-align: center;
        color: #ffffff;
      }

      .progressBar {
        margin-top: 10px;
        height: 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, .1);
        overflow: hidden;
      }

      .progress {
        height: 100%;
        background: linear-gradient(90deg, #9eb6dc, #1685ff);
      }

      .progress.win {
        background: linear-gradient(90deg, #2ddb91, #1685ff);
      }

      .progress.loss {
        background: linear-gradient(90deg, #ff596a, #b3102a);
      }

      .power {
        margin-top: 30px;
        width: 245px;
        height: 245px;
        border-radius: 999px;
        border: 0;
        color: white;
        font-size: 46px;
        font-weight: 900;
        background: radial-gradient(circle, #22d983, #0877d9 72%, #061426);
        box-shadow: 0 0 60px rgba(34,217,131,.48);
      }

      .power.stop {
        background: radial-gradient(circle, #ff5d6d, #bf1831 62%, #72111e);
        box-shadow: 0 0 55px rgba(255,68,96,.36);
      }

      .power:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        filter: grayscale(0.4);
        box-shadow: none;
      }

      .turnkeyStatus {
        max-width: 520px;
        margin: 18px auto 0;
        padding: 16px;
        border-radius: 18px;
        font-size: 18px;
        line-height: 1.6;
      }

      .turnkeyStatus.ready {
        color: #8dffbd;
        background: rgba(45, 212, 130, .12);
        border: 1px solid rgba(80, 255, 170, .28);
      }

      .turnkeyStatus.notReady {
        color: #f5d27a;
        background: rgba(245, 210, 122, .10);
        border: 1px solid rgba(245, 210, 122, .22);
      }

      .turnkeyStatus span {
        color: #9eb6dc;
        font-size: 15px;
      }

      .turnkeyStatus p {
        margin: 8px 0 0;
        font-size: 15px;
        color: #aec6eb;
      }

      .menuGrid,
      .stats,
      .infoGrid,
      .indicators {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 16px;
      }

      .menu,
      .stat,
      .smallBox,
      .indicator,
      .info,
      .tradeLine {
        border-radius: 24px;
        padding: 22px;
        border: 1px solid rgba(255,215,120,.16);
        background: rgba(255,255,255,.075);
      }

      .menu {
        color: white;
        text-align: right;
        cursor: pointer;
      }

      .menu strong {
        display: block;
        font-size: 28px;
        color: #f5d27a;
      }

      .menu span,
      .stat span,
      .smallBox span,
      .info span,
      .field span {
        display: block;
        color: #9eb6dc;
        font-size: 19px;
        margin-top: 8px;
      }

      .stat strong,
      .smallBox strong,
      .info strong {
        display: block;
        margin-top: 10px;
        font-size: 30px;
        word-break: break-all;
      }

      .back {
        max-width: 860px;
        margin: 0 auto 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
      }

      .back button,
      .saveBtn,
      .dangerBtn,
      .tabs button {
        border: 0;
        border-radius: 18px;
        padding: 18px 24px;
        color: white;
        background: linear-gradient(135deg, #1685ff, #0d5db8);
        font-size: 22px;
        font-weight: 900;
      }

      .back h1 {
        color: #f5d27a;
        font-size: 40px;
        margin: 0;
      }

      .field {
        display: block;
        margin-bottom: 18px;
      }

      input,
      select {
        width: 100%;
        margin-top: 10px;
        padding: 20px;
        border-radius: 20px;
        border: 1px solid rgba(255,215,120,.18);
        color: white;
        background: rgba(255,255,255,.09);
        font-size: 22px;
      }

      option { color: black; }

      .saveBtn {
        width: 100%;
        margin-top: 14px;
        background: linear-gradient(135deg, #29d687, #0d76d6);
      }

      .dangerBtn {
        width: 100%;
        margin-top: 14px;
        background: linear-gradient(135deg, #ff596a, #b3102a);
      }

      .dangerBtn:disabled,
      .saveBtn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .indicator {
        color: white;
        text-align: center;
        cursor: pointer;
        font-weight: 900;
        font-size: 22px;
      }

      .indicator.active {
        background: rgba(37,205,125,.3);
        border-color: rgba(80,255,170,.48);
        color: #8dffbd;
      }

      .walletBalance {
        margin-bottom: 18px;
        padding: 24px;
        border-radius: 26px;
        background: linear-gradient(135deg, rgba(245,210,122,.15), rgba(38,180,255,.15));
      }

      .walletBalance span {
        color: #9eb6dc;
        font-size: 20px;
      }

      .walletBalance strong {
        display: block;
        font-size: 36px;
        color: #8dffbd;
        margin-top: 8px;
      }

      .tabs {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        margin-bottom: 20px;
      }

      .tabs button {
        background: rgba(255,255,255,.09);
      }

      .tabs .active {
        background: linear-gradient(135deg, #f5d27a, #0d76d6);
      }

      .depositOptions {
        display: grid;
        gap: 18px;
      }

      .depositBox {
        border-radius: 26px;
        padding: 22px;
        border: 1px solid rgba(255, 215, 120, .16);
        background: rgba(255, 255, 255, .075);
      }

      .depositBox h3 {
        margin: 0 0 14px;
        color: #f5d27a;
        font-size: 28px;
      }

      .qr {
        width: 190px;
        height: 190px;
        margin: 12px auto 20px;
        display: grid;
        place-items: center;
        text-align: center;
        border-radius: 30px;
        color: #061426;
        background: linear-gradient(135deg, #f5d27a, #2ddb91);
        font-size: 30px;
        font-weight: 900;
      }

      .gold { color: #f5d27a; }
      .danger { color: #ffb0bc; }

      .tradeLogs {
        display: grid;
        gap: 12px;
      }

      .tradeLine {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .logLeft {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .tradeLine strong {
        display: block;
        font-size: 28px;
      }

      .tradeLine span {
        display: block;
        margin-top: 6px;
        color: #9eb6dc;
        font-size: 17px;
      }

      .tradeLine b {
        font-size: 28px;
      }

      .tradeLine.win {
        border-color: rgba(80,255,170,.42);
        color: #8dffbd;
      }

      .tradeLine.loss {
        border-color: rgba(255,80,110,.42);
        color: #ffb0bc;
      }

      .empty,
      .notice {
        max-width: 860px;
        margin: 0 auto 18px;
        border-radius: 18px;
        padding: 18px;
        color: #f5d27a;
        background: rgba(245,210,122,.1);
        text-align: center;
        font-size: 20px;
      }

      .logoutBtn {
        border: 0;
        border-radius: 14px;
        padding: 10px 16px;
        color: white;
        background: rgba(255,255,255,.09);
        font-size: 16px;
        font-weight: 900;
      }

      @media (max-width: 600px) {
        .app { padding: 18px; }

        .menuGrid,
        .stats,
        .infoGrid,
        .indicators {
          grid-template-columns: 1fr;
        }

        .power {
          width: 205px;
          height: 205px;
          font-size: 40px;
        }

        h1 { font-size: 38px; }
        h2 { font-size: 32px; }
        .balance { font-size: 34px; }
        .back h1 { font-size: 28px; }
        .back button { padding: 12px 16px; font-size: 18px; }
      }
    `}</style>
  );
}
