import express from "express";
import fs from "fs";
import PDFDocument from "pdfkit";

const router = express.Router();
const STATE_FILE = "./bot-state.json";

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function getUserId(req) {
  return (
    req.headers["x-user-id"] ||
    req.headers["x-demo-user"] ||
    req.query.user_id ||
    "local-dev"
  );
}

function normalizeTradeLog(t, userId = "local-dev") {
  return {
    user_id: t.user_id || userId,
    time: t.time || new Date().toISOString(),
    result: t.result || "-",
    amount: Number(t.amount || 0),
    side: t.side || "-",
    strategy: t.strategy || "-",
    month:
      t.month ||
      (() => {
        try {
          return new Date(t.time || Date.now()).toLocaleString("en-US", {
            month: "long"
          });
        } catch {
          return "-";
        }
      })()
  };
}

function getLogs(req) {
  const state = readState();
  const userId = getUserId(req);
  const logs = [];

  if (Array.isArray(state.full_trade_logs)) {
    logs.push(...state.full_trade_logs.map((x) => normalizeTradeLog(x, "local-dev")));
  } else if (Array.isArray(state.trade_logs)) {
    logs.push(...state.trade_logs.map((x) => normalizeTradeLog(x, "local-dev")));
  }

  if (state.usersState && typeof state.usersState === "object") {
    const showAll = String(req.query.all || "false").toLowerCase() === "true";

    if (showAll) {
      for (const [uid, user] of Object.entries(state.usersState)) {
        if (Array.isArray(user?.full_trade_logs)) {
          logs.push(...user.full_trade_logs.map((x) => normalizeTradeLog(x, uid)));
        } else if (Array.isArray(user?.trade_logs)) {
          logs.push(...user.trade_logs.map((x) => normalizeTradeLog(x, uid)));
        }
      }
    } else {
      const user = state.usersState[userId];

      if (Array.isArray(user?.full_trade_logs)) {
        logs.push(...user.full_trade_logs.map((x) => normalizeTradeLog(x, userId)));
      } else if (Array.isArray(user?.trade_logs)) {
        logs.push(...user.trade_logs.map((x) => normalizeTradeLog(x, userId)));
      }
    }
  }

  const seen = new Set();
  const unique = [];

  for (const t of logs) {
    const key = `${t.user_id}-${t.time}-${t.result}-${t.amount}-${t.side}-${t.strategy}`;

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(t);
  }

  return unique.sort((a, b) => {
    return new Date(a.time).getTime() - new Date(b.time).getTime();
  });
}

function getStats(logs) {
  const total = logs.length;
  const wins = logs.filter((x) => x.result === "WIN").length;
  const losses = logs.filter((x) => x.result === "LOSS").length;

  const profit = logs
    .filter((x) => x.result === "WIN")
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  const loss = logs
    .filter((x) => x.result === "LOSS")
    .reduce((a, b) => a + Number(b.amount || 0), 0);

  return {
    total,
    wins,
    losses,
    profit,
    loss,
    net: profit - loss,
    winRate: total ? (wins / total) * 100 : 0,
    lossRate: total ? (losses / total) * 100 : 0
  };
}

function drawCard(doc, x, y, w, h, title, value, color) {
  doc.roundedRect(x, y, w, h, 14).fill("#0b1f35");
  doc.fillColor("#9fb4d0").fontSize(10).text(title, x + 14, y + 12);
  doc.fillColor(color).fontSize(18).text(value, x + 14, y + 30);
}

function buildEquity(logs) {
  let balance = 0;
  const points = [];

  for (const t of logs) {
    const amount = Number(t.amount || 0);

    if (t.result === "WIN") balance += amount;
    else if (t.result === "LOSS") balance -= amount;

    points.push(Math.round(balance * 100) / 100);
  }

  return points;
}

function drawChart(doc, logs, x, y, w, h) {
  const equity = buildEquity(logs);

  doc.fillColor("#07192b").roundedRect(x, y, w, h, 16).fill();
  doc.fillColor("#ffffff").fontSize(14).text("Equity Curve", x + 18, y + 14);

  const chartX = x + 35;
  const chartY = y + 48;
  const chartW = w - 70;
  const chartH = h - 80;

  doc.strokeColor("#24435f").lineWidth(1);
  doc.rect(chartX, chartY, chartW, chartH).stroke();

  if (equity.length < 2) {
    doc
      .fillColor("#9fb4d0")
      .fontSize(12)
      .text("Not enough trades for chart", chartX + 20, chartY + 40);
    return;
  }

  const min = Math.min(...equity, 0);
  const max = Math.max(...equity, 0);
  const range = max - min || 1;

  function px(i) {
    return chartX + (i / (equity.length - 1)) * chartW;
  }

  function py(v) {
    return chartY + chartH - ((v - min) / range) * chartH;
  }

  const zeroY = py(0);

  doc.strokeColor("#3b5f7f").lineWidth(1);
  doc.moveTo(chartX, zeroY).lineTo(chartX + chartW, zeroY).stroke();

  doc.strokeColor("#27d98b").lineWidth(3);
  doc.moveTo(px(0), py(equity[0]));

  for (let i = 1; i < equity.length; i++) {
    doc.lineTo(px(i), py(equity[i]));
  }

  doc.stroke();

  doc.fillColor("#9fb4d0").fontSize(9);
  doc.text(`Max: ${money(max)}`, chartX, chartY - 16);
  doc.text(`Min: ${money(min)}`, chartX + chartW - 80, chartY - 16);
}

function drawPageBackground(doc) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#061426");
}

function splitStrategies(strategy) {
  const text = String(strategy || "-").trim();

  if (!text || text === "-") return ["-"];

  return text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function drawTradeHeader(doc, y) {
  doc.font("Courier-Bold").fontSize(9).fillColor("#9fb4d0");

  doc.text("#", 36, y, { width: 30 });
  doc.text("RESULT", 70, y, { width: 60 });
  doc.text("AMOUNT", 135, y, { width: 65 });
  doc.text("SIDE", 210, y, { width: 50 });
  doc.text("STRATEGY", 270, y, { width: 100 });
  doc.text("DATE", 390, y, { width: 145 });

  return y + 18;
}

function drawTradeRow(doc, t, index, y) {
  const isWin = t.result === "WIN";
  const color = isWin ? "#7fffba" : "#ff9aaa";

  const dateText = (() => {
    try {
      return new Date(t.time).toLocaleString();
    } catch {
      return "-";
    }
  })();

  const strategies = splitStrategies(t.strategy);
  const rowHeight = Math.max(22, strategies.length * 14 + 8);

  doc
    .roundedRect(32, y - 4, 510, rowHeight, 8)
    .fill(isWin ? "#082b22" : "#2b1018");

  doc.font("Courier").fontSize(9).fillColor(color);

  doc.text(`#${index + 1}`, 36, y, { width: 30, lineBreak: false });
  doc.text(String(t.result || "-"), 70, y, { width: 60, lineBreak: false });
  doc.text(money(t.amount), 135, y, { width: 65, lineBreak: false });
  doc.text(String(t.side || "-").toUpperCase(), 210, y, {
    width: 50,
    lineBreak: false
  });

  strategies.forEach((name, idx) => {
    doc.text(name, 270, y + idx * 14, {
      width: 105,
      lineBreak: false
    });
  });

  doc.text(dateText, 390, y, {
    width: 145,
    lineBreak: false
  });

  return y + rowHeight + 6;
}

router.get("/api/report/pdf", (req, res) => {
  const logs = getLogs(req);
  const stats = getStats(logs);

  const doc = new PDFDocument({ size: "A4", margin: 36 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    "inline; filename=trook-trading-report.pdf"
  );

  doc.pipe(res);

  drawPageBackground(doc);

  doc.fillColor("#f5d27a").fontSize(26).text("Trook Trading Report", 36, 36, {
    align: "center"
  });

  doc.fillColor("#9fb4d0").fontSize(10).text(
    `Generated: ${new Date().toLocaleString()}`,
    {
      align: "center"
    }
  );

  let y = 95;

  drawCard(doc, 36, y, 125, 64, "Total Trades", String(stats.total), "#ffffff");
  drawCard(doc, 176, y, 125, 64, "Wins", String(stats.wins), "#7fffba");
  drawCard(doc, 316, y, 125, 64, "Losses", String(stats.losses), "#ff9aaa");
  drawCard(
    doc,
    456,
    y,
    80,
    64,
    "Win Rate",
    `${stats.winRate.toFixed(1)}%`,
    "#f5d27a"
  );

  y += 84;

  drawCard(doc, 36, y, 160, 64, "Total Profit", money(stats.profit), "#7fffba");
  drawCard(doc, 216, y, 160, 64, "Total Loss", money(stats.loss), "#ff9aaa");
  drawCard(
    doc,
    396,
    y,
    140,
    64,
    "Net Profit",
    money(stats.net),
    stats.net >= 0 ? "#7fffba" : "#ff9aaa"
  );

  y += 90;

  drawChart(doc, logs, 36, y, 500, 230);

  y += 260;

  doc.fillColor("#f5d27a").fontSize(16).text("Trade History", 36, y);

  y += 30;

  let currentMonth = "";

  logs
    .slice()
    .reverse()
    .forEach((t, i) => {
      const strategies = splitStrategies(t.strategy);
      const expectedHeight = Math.max(22, strategies.length * 14 + 8) + 6;

      if (y + expectedHeight > 760) {
        doc.addPage();
        drawPageBackground(doc);
        y = 40;
      }

      const month =
        t.month ||
        new Date(t.time).toLocaleString("en-US", { month: "long" });

      if (month !== currentMonth) {
        currentMonth = month;

        y += 12;

        doc
          .fillColor("#f5d27a")
          .font("Helvetica-Bold")
          .fontSize(18)
          .text(`====== ${month} ======`, 36, y);

        y += 30;
        y = drawTradeHeader(doc, y);
      }

      if (y + expectedHeight > 760) {
        doc.addPage();
        drawPageBackground(doc);
        y = 40;
        y = drawTradeHeader(doc, y);
      }

      y = drawTradeRow(doc, t, i, y);
    });

  doc.end();
});

router.get("/api/report/json", (req, res) => {
  const logs = getLogs(req);
  const stats = getStats(logs);

  res.json({
    ok: true,
    total: logs.length,
    stats,
    logs
  });
});

export default router;
