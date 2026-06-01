"use client";

import { useEffect, useState, type ReactNode } from "react";

// ضع رابط السيرفر الخاص بك هنا أو اتركه كما هو إذا كان يعمل على نفس النطاق
const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  "https://4-all-trook-bot-production.up.railway.app";

type PageName = "home" | "settings" | "strategy" | "wallet" | "logs";
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

export default function Page() {
  const [page, setPage] = useState<PageName>("home");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [, setNow] = useState(Date.now()); // لتحديث الواجهة دورياً

  const [virtualBalance, setVirtualBalance] = useState(0);

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
    profit_target: 100,
    loss_limit: 100,
    direction: "both",
    selected_indicators: allIndicators
  });

  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);

  // ─── دوال الاتصال بالسيرفر ───

  async function loadAll() {
    try {
      const r = await fetch(`${API}/api/all`, { cache: "no-store" });
      const j = await r.json();

      if (j?.ok) {
        setVirtualBalance(Number(j.walletInfo?.balance || 0));
        setStatus((p) => ({ ...p, ...(j.status || {}) }));

        if (page !== "settings" && page !== "strategy") {
          const incomingConfig = j.config || {};
          setConfig((p) => ({
            ...p,
            ...incomingConfig,
            trade_amount: incomingConfig.tradeAmount ?? incomingConfig.trade_amount ?? p.trade_amount,
            base_profit_target: incomingConfig.baseProfitTarget ?? incomingConfig.base_profit_target ?? p.base_profit_target,
            stop_loss: incomingConfig.stopLoss ?? incomingConfig.stop_loss ?? p.stop_loss,
            martingale_multiplier: incomingConfig.martingaleMultiplier ?? incomingConfig.martingale_multiplier ?? p.martingale_multiplier,
            martingale_steps: incomingConfig.martingaleSteps ?? incomingConfig.martingale_steps ?? p.martingale_steps,
            profit_target: incomingConfig.profitTarget ?? incomingConfig.profit_target ?? p.profit_target,
            loss_limit: incomingConfig.lossLimit ?? incomingConfig.loss_limit ?? p.loss_limit,
            selected_indicators: Array.isArray(incomingConfig.selectedIndicators || incomingConfig.selected_indicators)
              ? (incomingConfig.selectedIndicators || incomingConfig.selected_indicators).filter((x: string) => allIndicators.includes(x))
              : p.selected_indicators
          }));
        }
      }
    } catch {
      // إخفاء رسالة الخطأ لتجنب الإزعاج في وضع التطوير
      // setMessage("فشل الاتصال بالباكند"); 
    }
  }

  async function loadLogs() {
    try {
      const r = await fetch(`${API}/api/logs`, { cache: "no-store" });
      const j = await r.json();
      if (j?.ok) {
        setTradeLogs(j.trade_logs || []);
      }
    } catch {}
  }

  async function startBot() {
    setMessage("");
    try {
      const r = await fetch(`${API}/api/start`, { method: "POST" });
      const j = await r.json();
      if (j?.ok) {
        setMessage("تم تشغيل محرك المحاكاة بنجاح");
        await loadAll();
      } else {
        setMessage(j?.error || "فشل تشغيل البوت");
      }
    } catch {
      setMessage("فشل الاتصال أثناء التشغيل");
    }
  }

  async function stopBot() {
    setMessage("");
    await fetch(`${API}/api/stop`, { method: "POST" });
    await loadAll();
  }

  async function saveConfig() {
    setSaving(true);
    setMessage("");
    try {
      const cleanConfig = {
        ...config,
        symbol: String(config.symbol || "BTCUSDT").toUpperCase(),
        leverage: Number(config.leverage),
        tradeAmount: Number(config.trade_amount),
        baseProfitTarget: Number(config.base_profit_target),
        stopLoss: Number(config.stop_loss),
        martingaleMultiplier: Number(config.martingale_multiplier),
        martingaleSteps: Number(config.martingale_steps),
        profitTarget: Number(config.profit_target),
        lossLimit: Number(config.loss_limit),
        selectedIndicators: config.selected_indicators.filter((x) =>
          allIndicators.includes(x)
        )
      };

      const r = await fetch(`${API}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanConfig)
      });
      const j = await r.json();

      if (j?.ok) {
        setMessage("تم الحفظ بنجاح");
        setPage("home");
        await loadAll();
      } else {
        setMessage("فشل الحفظ");
      }
    } catch {
      setMessage("فشل الاتصال أثناء الحفظ");
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

  // ─── التحديث التلقائي (Polling) ───
  useEffect(() => {
    loadAll();
    loadLogs();

    const t = setInterval(loadAll, 3000); // تحديث سريع للبيانات (3 ثواني)
    const t2 = setInterval(loadLogs, 6000);
    const t3 = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      clearInterval(t);
      clearInterval(t2);
      clearInterval(t3);
    };
  }, [page]);

  // ─── الواجهات (Views) ───

  if (page === "settings") {
    return (
      <Shell>
        <Back title="الإعدادات" onBack={() => setPage("home")} />
        <Card>
          <div className="infoGrid">
            <SmallBox title="السوق" value={String(config.symbol || "BTCUSDT")} />
            <SmallBox title="النظام" value="محاكاة فقط (Simulation)" />
          </div>

          <Input label="رمز التداول" value={config.symbol} onChange={(v) => setConfig({ ...config, symbol: String(v).toUpperCase() })} />
          <Input label="حجم الرافعة" value={config.leverage} onChange={(v) => setConfig({ ...config, leverage: v })} />
          <Input label="هامش الصفقة USDT" value={config.trade_amount} onChange={(v) => setConfig({ ...config, trade_amount: v })} />
          <Input label="هدف الصفقة الواحدة USDT" value={config.base_profit_target} onChange={(v) => setConfig({ ...config, base_profit_target: v })} />
          <Input label="وقف خسارة الصفقة الواحدة USDT" value={config.stop_loss} onChange={(v) => setConfig({ ...config, stop_loss: v })} />
          <Input label="مضاعف هدف الربح بعد الخسارة" value={config.martingale_multiplier} onChange={(v) => setConfig({ ...config, martingale_multiplier: v })} />
          <Input label="عدد خطوات المضاعفة" value={config.martingale_steps} onChange={(v) => setConfig({ ...config, martingale_steps: v })} />
          <Input label="هدف الربح الإجمالي لإيقاف البوت" value={config.profit_target} onChange={(v) => setConfig({ ...config, profit_target: v })} />
          <Input label="حد الخسارة الإجمالي لإيقاف البوت" value={config.loss_limit} onChange={(v) => setConfig({ ...config, loss_limit: v })} />

          <label className="field">
            <span>نوع الصفقة</span>
            <select value={config.direction} onChange={(e) => setConfig({ ...config, direction: e.target.value as Direction })}>
              <option value="both">شراء وبيع (Both)</option>
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
        <Back title="الرصيد الافتراضي" onBack={() => setPage("home")} />
        <Card>
          <div className="walletBalance">
            <span>رصيد المحاكاة المتاح</span>
            <strong>{virtualBalance.toFixed(2)} $</strong>
          </div>
          <p className="hint" style={{textAlign: "center", fontSize: "18px"}}>
            هذا الرصيد وهمي تماماً ومخصص لاختبار الاستراتيجيات وأداء البوت بدون أي مخاطرة حقيقية.
          </p>
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
          {/* يمكن تفعيل التقرير لاحقاً إذا أضفناه للسيرفر */}
          {/* <button onClick={() => window.open(`${API}/api/report/pdf`)}>كامل السجل</button> */}
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
  const currentTrade = status.current_trade || (status as any).currentTrade;

  return (
    <Shell>
      {message && <div className="notice">{message}</div>}

      <section className="hero">
        <h1>Trook Bot V2</h1>
        <p style={{color: "#f5d27a", fontWeight: "bold"}}>وضع المحاكاة - Simulation Mode</p>

        <div className="balance">{virtualBalance.toFixed(2)} $</div>

        {currentTrade && (
          <div className={`tradeBox ${tradeState}`}>
            <div className="tradeTop">
              <span className={`dot ${tradeState}`}></span>
              {currentTrade.side === "buy" && <span className="arrow up">▲</span>}
              {currentTrade.side === "sell" && <span className="arrow down">▼</span>}
              <strong>صفقة وهمية نشطة</strong>
              <span className="seconds">{currentTrade.side === "buy" ? "LONG" : "SHORT"}</span>
            </div>

            <div className="timeText">
              {String(currentTrade.symbol || "BTCUSDT")} | Leverage: {Number(currentTrade.leverage || 0)}x
            </div>

            <div className="tradeAmount">
              الهامش : ${Number(currentTrade.marginAmount || currentTrade.amount || 0).toFixed(2)}
            </div>

            <div className="tradeAmount">
              الهدف : ${Number(currentTrade.targetProfit || 0).toFixed(2)} | الوقف : ${Number(currentTrade.stopLoss || 0).toFixed(2)}
            </div>

            <div className="tradeAmount" style={{fontSize: "18px", marginTop: "12px", color: "#9eb6dc"}}>
              الدخول : {Number(currentTrade.entryPrice || 0).toFixed(2)} | TP: {Number(currentTrade.takeProfitPrice || 0).toFixed(2)} | SL: {Number(currentTrade.stopLossPrice || 0).toFixed(2)}
            </div>
          </div>
        )}

        {!currentTrade && (
          <div className="tradeBox idle">
            <strong>لا يوجد صفقة نشطة</strong>
            <p className="timeText">بانتظار إشارة المؤشرات...</p>
          </div>
        )}

        <button
          className={`power ${status.running ? "stop" : ""}`}
          onClick={status.running ? stopBot : startBot}
        >
          {status.running ? "إيقاف" : "تشغيل"}
        </button>
      </section>

      <Card>
        <div className="menuGrid">
          <Menu title="الإعدادات" sub="المبلغ والمضاعفات" onClick={() => setPage("settings")} />
          <Menu title="الاستراتيجية" sub="المؤشرات" onClick={() => setPage("strategy")} />
          <Menu title="الرصيد الافتراضي" sub="متابعة السيولة" onClick={() => setPage("wallet")} />
          <Menu title="السجل" sub="ربح وخسارة الصفقات" onClick={() => setPage("logs")} />
        </div>
      </Card>

      <Card>
        <h2>الإحصائية العامة للمحاكاة</h2>
        <Stats status={status} />
      </Card>

      <Style />
    </Shell>
  );
}

// ─── مكونات الواجهة (Components) والتصميم ───

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

function Input({ label, value, onChange }: { label: string; value: number | string; onChange: (v: string) => void; }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={String(value)} onChange={(e) => onChange(e.target.value)} />
    </label>
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
      <Stat label="إجمالي الربح" value={`$${Number(status.total_profit || 0).toFixed(2)}`} />
      <Stat label="إجمالي الخسارة" value={`$${Number(status.total_loss || 0).toFixed(2)}`} />
      <Stat label="الصفقات المكتملة" value={status.resolved_trades || 0} />
      <Stat label="نسبة الفوز" value={`${Number(status.win_rate || 0).toFixed(1)}%`} />
      <Stat label="الصفقات الرابحة" value={status.wins || 0} />
      <Stat label="الصفقات الخاسرة" value={status.losses || 0} />
      <Stat label="مرحلة المضاعفة" value={status.martingale_loss_count || 0} />
      <Stat label="حالة البوت" value={status.running ? "يعمل 🟢" : "متوقف 🔴"} />
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
        direction: rtl; /* ضمان اتجاه النصوص الصحيح */
      }
      .app {
        min-height: 100vh;
        padding: 22px;
        background:
          radial-gradient(circle at top right, rgba(245, 210, 122, 0.15), transparent 36%),
          radial-gradient(circle at top left, rgba(24, 124, 255, 0.20), transparent 40%),
          linear-gradient(180deg, #092b55 0%, #061426 42%, #030813 100%);
      }
      .hero, .card {
        max-width: 860px;
        margin: 0 auto 20px;
        border-radius: 34px;
        padding: 30px;
        background: linear-gradient(145deg, rgba(6, 32, 62, 0.96), rgba(5, 18, 39, 0.95));
        border: 1px solid rgba(245, 210, 122, 0.22);
        box-shadow: 0 20px 70px rgba(0,0,0,.34);
      }
      .hero { text-align: center; }
      h1 { margin: 0; font-size: 46px; color: #f5d27a; font-weight: 900; }
      h2 { margin: 0 0 22px; font-size: 30px; color: #f5d27a; font-weight: 900; text-align: right; }
      p, .hint { color: #aec6eb; line-height: 1.7; font-size: 20px; }
      .balance {
        width: fit-content;
        margin: 24px auto 8px;
        padding: 16px 34px;
        border-radius: 999px;
        color: #f5d27a;
        background: rgba(245,210,122,.14);
        border: 1px solid rgba(245,210,122,.28);
        font-size: 42px;
        font-weight: 900;
        direction: ltr;
      }
      .tradeBox {
        margin: 16px auto 0;
        padding: 18px;
        border-radius: 22px;
        background: rgba(255, 255, 255, .06);
        border: 1px solid rgba(255, 255, 255, .15);
        max-width: 860px;
      }
      .tradeBox.win { background: rgba(45, 212, 130, 0.16); border: 1px solid rgba(80, 255, 170, .45); }
      .tradeBox.loss { background: rgba(255, 80, 110, 0.16); border: 1px solid rgba(255, 80, 110, .50); }
      .tradeBox.idle { text-align: center; }
      .tradeTop { display: flex; align-items: center; justify-content: space-between; direction: ltr; }
      .dot { width: 12px; height: 12px; background: #9eb6dc; border-radius: 50%; margin-left: 8px; }
      .dot.win { background: #2ddb91; box-shadow: 0 0 10px #2ddb91; }
      .dot.loss { background: #ff596a; box-shadow: 0 0 10px #ff596a; }
      .arrow { font-size: 22px; margin-left: 8px; }
      .arrow.up { color: #2ddb91; }
      .arrow.down { color: #ff596a; }
      .seconds { font-size: 22px; font-weight: bold; }
      .timeText { margin-top: 6px; color: #9eb6dc; font-size: 18px; }
      .tradeAmount { margin-top: 10px; font-size: 24px; font-weight: 900; text-align: center; color: #ffffff; direction: ltr; }
      
      .power {
        margin-top: 30px;
        width: 200px;
        height: 200px;
        border-radius: 999px;
        border: 0;
        color: white;
        font-size: 40px;
        font-weight: 900;
        background: radial-gradient(circle, #22d983, #0877d9 72%, #061426);
        box-shadow: 0 0 60px rgba(34,217,131,.48);
        cursor: pointer;
        transition: transform 0.2s;
      }
      .power:active { transform: scale(0.95); }
      .power.stop {
        background: radial-gradient(circle, #ff5d6d, #bf1831 62%, #72111e);
        box-shadow: 0 0 55px rgba(255,68,96,.36);
      }
      
      .menuGrid, .stats, .infoGrid, .indicators {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 16px;
      }
      .menu, .stat, .smallBox, .indicator, .tradeLine {
        border-radius: 24px;
        padding: 22px;
        border: 1px solid rgba(255,215,120,.16);
        background: rgba(255,255,255,.075);
      }
      .menu { color: white; text-align: right; cursor: pointer; transition: background 0.2s; }
      .menu:hover { background: rgba(255,255,255,.12); }
      .menu strong { display: block; font-size: 26px; color: #f5d27a; }
      .menu span, .stat span, .smallBox span, .field span {
        display: block; color: #9eb6dc; font-size: 18px; margin-top: 8px; text-align: right;
      }
      .stat strong, .smallBox strong { display: block; margin-top: 10px; font-size: 28px; text-align: right; direction: ltr; }
      
      .back { max-width: 860px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: space-between; }
      .back button, .saveBtn {
        border: 0; border-radius: 18px; padding: 18px 24px; color: white;
        background: linear-gradient(135deg, #1685ff, #0d5db8); font-size: 22px; font-weight: 900; cursor: pointer;
      }
      .back h1 { color: #f5d27a; font-size: 34px; margin: 0; }
      
      .field { display: block; margin-bottom: 18px; text-align: right; }
      input, select {
        width: 100%; margin-top: 10px; padding: 20px; border-radius: 20px;
        border: 1px solid rgba(255,215,120,.18); color: white; background: rgba(255,255,255,.09);
        font-size: 22px; outline: none; text-align: left; direction: ltr;
      }
      option { color: black; }
      .saveBtn { width: 100%; margin-top: 14px; background: linear-gradient(135deg, #29d687, #0d76d6); }
      .saveBtn:disabled { opacity: 0.55; cursor: not-allowed; }
      
      .indicator { color: white; text-align: center; cursor: pointer; font-weight: 900; font-size: 20px; }
      .indicator.active { background: rgba(37,205,125,.3); border-color: rgba(80,255,170,.48); color: #8dffbd; }
      
      .walletBalance { margin-bottom: 18px; padding: 24px; border-radius: 26px; background: linear-gradient(135deg, rgba(245,210,122,.15), rgba(38,180,255,.15)); text-align: center; }
      .walletBalance span { color: #9eb6dc; font-size: 22px; }
      .walletBalance strong { display: block; font-size: 40px; color: #f5d27a; margin-top: 12px; direction: ltr; }
      
      .tradeLogs { display: grid; gap: 12px; }
      .tradeLine { display: flex; justify-content: space-between; align-items: center; direction: ltr; }
      .logLeft { display: flex; align-items: center; gap: 10px; text-align: left; }
      .tradeLine strong { display: block; font-size: 24px; }
      .tradeLine span { display: block; margin-top: 6px; color: #9eb6dc; font-size: 16px; }
      .tradeLine b { font-size: 26px; }
      .tradeLine.win { border-color: rgba(80,255,170,.42); color: #8dffbd; }
      .tradeLine.loss { border-color: rgba(255,80,110,.42); color: #ffb0bc; }
      
      .empty, .notice {
        max-width: 860px; margin: 0 auto 18px; border-radius: 18px; padding: 18px;
        color: #f5d27a; background: rgba(245,210,122,.1); text-align: center; font-size: 20px;
      }
      
      @media (max-width: 600px) {
        .app { padding: 16px; }
        .menuGrid, .stats, .infoGrid, .indicators { grid-template-columns: 1fr; }
        .power { width: 180px; height: 180px; font-size: 34px; }
        h1 { font-size: 34px; } h2 { font-size: 28px; } .balance { font-size: 32px; }
        .back h1 { font-size: 26px; } .back button { padding: 12px 16px; font-size: 18px; }
      }
    `}</style>
  );
}
