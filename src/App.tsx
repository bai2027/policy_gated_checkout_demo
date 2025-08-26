import React, { useMemo, useState, useEffect } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/**
 * Policy-Gated Checkout Sandbox (no prod changes)
 * ------------------------------------------------
 * Single-file React demo to host on any static site (Vercel/Netlify/S3/etc.).
 * No secrets, no network calls, no real money. Everything is sandboxed in-browser.
 *
 * Now with:
 *  - Quote lock + hold window + slippage bounds
 *  - Auto-fallback toggle: on quote breach/expiry, move USDC value → Card
 *
 * What it shows:
 *  - Country/policy gates (on/off, caps, time windows, disclosures)
 *  - Quote + brief rate-hold and fail-closed logic
 *  - Human-readable receipt specimen + matching JSON
 *  - Reconciliation CSV with a Reconciliation ID (RID) that ties to bank statement memo
 *  - Policy Matrix CSV (downloadable)
 */

// ---------- Sample Policy Matrix (illustrative only) ----------
const POLICY_MATRIX = [
  {
    version: "JP-1.4",
    country: "JP",
    use_case: "Domestic Retail",
    instrument: "Tochika",
    chain: "issuer-ledger",
    allow: "ON",
    max_txn_local: 15000,
    daily_cap_local: 30000,
    monthly_cap_local: 90000,
    local_currency: "JPY",
    time_window_local: "09:00-20:00",
    required_disclosures: ["JP-DISC-01", "JP-DISC-03"],
    kyc_level: "partner",
    travel_rule_required: true,
    sanctions_screen: true,
    allowed_mccs: "5311|5732|5812",
    fallback_on_fail: "Card",
    effective_from: "2025-08-01",
    approver: "Risk&Compliance",
    notes: "Fail-closed outside window; receipts embed policy snapshot",
  },
  {
    version: "JP-1.4",
    country: "JP",
    use_case: "Domestic Retail",
    instrument: "USDC",
    chain: "allowlisted",
    allow: "ON",
    max_txn_local: 5000,
    daily_cap_local: 15000,
    monthly_cap_local: 45000,
    local_currency: "JPY",
    time_window_local: "09:00-20:00",
    required_disclosures: ["JP-DISC-01", "JP-DISC-04"],
    kyc_level: "partner",
    travel_rule_required: true,
    sanctions_screen: true,
    allowed_mccs: "5311|5732|5812",
    fallback_on_fail: "Card",
    effective_from: "2025-08-01",
    approver: "Risk&Compliance",
    notes: "USDC only via licensed aggregator; merchant settles in JPY",
  },
  {
    version: "HK-0.9",
    country: "HK",
    use_case: "Inbound (JP→HK)",
    instrument: "USDC",
    chain: "allowlisted",
    allow: "OFF",
    max_txn_local: 0,
    daily_cap_local: 0,
    monthly_cap_local: 0,
    local_currency: "HKD",
    time_window_local: "10:00-18:00",
    required_disclosures: ["HK-DISC-02"],
    kyc_level: "partner",
    travel_rule_required: true,
    sanctions_screen: true,
    allowed_mccs: "*",
    fallback_on_fail: "Card",
    effective_from: "2025-08-01",
    approver: "Legal",
    notes: "HK regime evolving; use two-leg fiat to HKD payout",
  },
  {
    version: "JP-1.4",
    country: "JP",
    use_case: "Digital Vouchers",
    instrument: "Points",
    chain: "program-api",
    allow: "ON",
    max_txn_local: 8000,
    daily_cap_local: 15000,
    monthly_cap_local: 45000,
    local_currency: "JPY",
    time_window_local: "00:00-24:00",
    required_disclosures: ["JP-DISC-02"],
    kyc_level: "none",
    travel_rule_required: false,
    sanctions_screen: false,
    allowed_mccs: "5812|5942",
    fallback_on_fail: "Card",
    effective_from: "2025-08-01",
    approver: "Product",
    notes: "Points only where program T&Cs allow; no cash-out unless permitted",
  },
];

// ---------- Helpers ----------
function hhmm(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
function withinWindow(now, window) {
  const [start, end] = window.split("-");
  const nowHM = hhmm(now);
  return nowHM >= start && nowHM <= end;
}
function genRID(country, now, seq = 45) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `RID-${country}-${y}${m}${d}-${String(seq).padStart(6, "0")}`;
}
function csvEscape(s) {
  if (/[\",\\n]/.test(s)) return '"' + s.replace(/\"/g, '""') + '"';
  return s;
}
function buildPolicyCSV(rows) {
  const header = [
    "Version","Country","Use_Case","Instrument","Chain","Allow","Max_Txn_Local","Daily_Cap_Local","Monthly_Cap_Local","Local_Currency","Time_Window_Local","Required_Disclosures","KYC_Level","TravelRule_Required","Sanctions_Screen","Allowed_MCCs","Fallback_On_Fail","Effective_From","Effective_To","Approver","Notes"
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.version, r.country, r.use_case, r.instrument, r.chain, r.allow,
      r.max_txn_local, r.daily_cap_local, r.monthly_cap_local, r.local_currency,
      r.time_window_local, r.required_disclosures.join("|"), r.kyc_level,
      r.travel_rule_required ? "Yes" : "No", r.sanctions_screen ? "Yes" : "No",
      r.allowed_mccs, r.fallback_on_fail, r.effective_from, r.effective_to ?? "",
      r.approver, r.notes ?? ""
    ].map(v => csvEscape(String(v))).join(","));
  }
  return lines.join("\n");
}
function download(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------- PDF Generator ----------
function generateReceiptPDF(receiptJSON) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 40;
  let y = margin;

  doc.setFontSize(14);
  doc.text("Points2Perks Receipt — Policy-Gated Checkout (Illustrative)", margin, y);
  y += 18;
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text("Issuer-first • Aggregator-agnostic • Merchants settle in fiat • Sandbox only (no production changes)", margin, y);
  doc.setTextColor(0);
  y += 16;

  const k = receiptJSON;

  // Key lines
  [
    `ReceiptID: ${k.receipt_id}     ReconciliationID (RID): ${k.reconciliation_id}`,
    `OrderID: ${k.order_id}     Timestamp: ${new Date(k.timestamp).toLocaleString()}`,
    `Jurisdiction: ${k.jurisdiction}     Policy Version: ${k.policy?.version}`,
    `Merchant: ${k.merchant?.name} (${k.merchant?.id})     Payout Currency: ${k.merchant?.payout_currency}`,
  ].forEach(line => { doc.text(line, margin, y); y += 14; });
  y += 6;

  // Tenders table
  const tenders = (k.tenders || []).map((t) => {
    if (t.type === "tochika") return ["Tochika", `${t.amount_jpy}`, "—", `issuer: ${t.issuer}`];
    if (t.type === "usdc")    return ["USDC", `${t.amount} USDC`, `${t.quote?.value_jpy ?? ""} JPY`, `rate: ${t.quote?.rate_usdc_jpy}`];
    if (t.type === "card")    return ["Card", `${t.amount_jpy} JPY`, "—", `brand: ${t.brand}`];
    return [t.type, "", "", ""];
  });
  autoTable(doc, { startY: y, head: [["Tender","Amount","Value (JPY)","Details"]], body: tenders, styles: { fontSize: 9 } });
  // @ts-ignore
  y = doc.lastAutoTable.finalY + 12;

  // Policy snapshot
  const ps = k.policy?.snapshot || {};
  autoTable(doc, {
    startY: y,
    head: [["Policy Snapshot","Value"]],
    body: [
      ["On/Off", ps.on_off],
      ["Max per txn", `${ps.max_per_txn_local ?? ""}`],
      ["Time window", ps.time_window_local ?? ""],
      ["Disclosures", (ps.required_disclosures || []).join(", ")],
      ["KYC level", ps.kyc_level ?? ""],
      ["Travel Rule applied", String(ps.travel_rule_applied)],
      ["Sanctions screen", ps.sanctions_screen ?? ""],
    ],
    styles: { fontSize: 9 }, columnStyles: { 0: { cellWidth: 160 } }
  });
  // @ts-ignore
  y = doc.lastAutoTable.finalY + 12;

  // Counterparties
  autoTable(doc, {
    startY: y,
    head: [["Counterparty","Fields"]],
    body: [
      ["Aggregator", `id: ${k.counterparties?.aggregator?.id} | route: ${k.counterparties?.aggregator?.route_id} | txid: ${k.counterparties?.aggregator?.txid}`],
      ["Acquirer",   `id: ${k.counterparties?.acquirer?.id} | batch: ${k.counterparties?.acquirer?.payout_batch_id} | value date: ${k.counterparties?.acquirer?.value_date}`],
    ],
    styles: { fontSize: 9 }, columnStyles: { 0: { cellWidth: 120 } }
  });
  // @ts-ignore
  y = doc.lastAutoTable.finalY + 12;

  // Payout
  autoTable(doc, {
    startY: y,
    head: [["Payout","Amount / Notes"]],
    body: [
      ["Gross (JPY)", String(k.payout?.gross_jpy ?? "")],
      ["Fees (JPY)",  String(k.payout?.fees_jpy ?? "")],
      ["Net (JPY)",   String(k.payout?.net_jpy ?? "")],
      ["Bank last4",  String(k.payout?.bank_last4 ?? "")],
      ["Descriptor",  k.merchant?.bank_descriptor ?? ""],
    ],
    styles: { fontSize: 9 }, columnStyles: { 0: { cellWidth: 120 } }
  });
  // @ts-ignore
  y = doc.lastAutoTable.finalY + 16;

  // Footer
  doc.setFontSize(8);
  doc.setTextColor(90);
  doc.text("Illustrative specimen for discussion; not an offer of regulated services. Fields subject to change.", margin, y);

  doc.save("receipt.pdf");
}

// ---------- Component ----------
export default function App() {
  const [jurisdiction, setJurisdiction] = useState("JP");
  const [merchantName, setMerchantName] = useState("Sakura Electronics");
  const [tochikaJPY, setTochikaJPY] = useState(8000);
  const [usdcAmt, setUsdcAmt] = useState(20);
  const [cardJPY, setCardJPY] = useState(500);
  const [rateUSDCJPY, setRateUSDCJPY] = useState(150.75);
  const [holdSec, setHoldSec] = useState(90);
  const [slippageBps, setSlippageBps] = useState(50);
  const [now, setNow] = useState(new Date());

  // NEW: quote lock + auto-fallback
  const [quoteLocked, setQuoteLocked] = useState(false);
  const [quoteRate, setQuoteRate] = useState(null);
  const [quoteStart, setQuoteStart] = useState(null);
  const [autoFallback, setAutoFallback] = useState(true);

  const totalJPY = useMemo(() => Math.round((tochikaJPY + usdcAmt * rateUSDCJPY + cardJPY) * 100) / 100, [tochikaJPY, usdcAmt, cardJPY, rateUSDCJPY]);

  // Gate evaluation
  const jpTochika = POLICY_MATRIX.find(r => r.country === "JP" && r.instrument === "Tochika");
  const jpUsdc = POLICY_MATRIX.find(r => r.country === "JP" && r.instrument === "USDC");

  const policyApplied = {
    on_off: (jpTochika && jpTochika.allow === "ON") || (jpUsdc && jpUsdc.allow === "ON") ? "ON" : "OFF",
    max_per_txn_local: Math.max(jpTochika?.max_txn_local ?? 0, jpUsdc?.max_txn_local ?? 0),
    daily_cap_local: Math.max(jpTochika?.daily_cap_local ?? 0, jpUsdc?.daily_cap_local ?? 0),
    time_window_local: jpTochika?.time_window_local ?? "09:00-20:00",
    required_disclosures: Array.from(new Set([...(jpTochika?.required_disclosures ?? []), ...(jpUsdc?.required_disclosures ?? [])])),
    kyc_level: "partner",
    travel_rule_applied: true,
    sanctions_screen: "pass",
  };

  const windowOK = withinWindow(now, policyApplied.time_window_local);
  const perTxnOK = totalJPY <= policyApplied.max_per_txn_local || policyApplied.max_per_txn_local === 0;
  const policyOK = policyApplied.on_off === "ON" && windowOK && perTxnOK;

  // Quote validity
  const holdValid = !quoteLocked || (quoteStart && ((new Date().getTime() - new Date(quoteStart).getTime())/1000) <= holdSec) ? true : false;
  const slippageValid = !quoteLocked || (quoteRate !== null && Math.abs((rateUSDCJPY - quoteRate)/quoteRate) * 10000 <= slippageBps);
  const quoteOK = holdValid && slippageValid;

  // Auto-fallback effect: when quote breaches/expires, convert USDC leg to card
  useEffect(() => {
    if (autoFallback && quoteLocked && !quoteOK && usdcAmt > 0) {
      const addJPY = Math.round(usdcAmt * rateUSDCJPY);
      setCardJPY(prev => Math.round(prev + addJPY));
      setUsdcAmt(0);
    }
  }, [autoFallback, quoteLocked, quoteOK, usdcAmt, rateUSDCJPY]);

  // Build artifacts
  const rid = genRID(jurisdiction, now, 45);

  const receiptJSON = {
    receipt_id: `rcp_${now.toISOString().slice(0,10)}_00123`,
    reconciliation_id: rid,
    order_id: "ord_7f3a2c",
    timestamp: now.toISOString(),
    jurisdiction,
    policy: {
      version: "JP-1.4",
      hash: "a9f1...c2",
      snapshot: policyApplied,
    },
    merchant: {
      id: "MERCH-1029",
      name: merchantName,
      payout_currency: "JPY",
      bank_descriptor: `${merchantName.toUpperCase().split(" ").join("*")}*${rid}`,
    },
    tenders: [
      { type: "tochika", amount_jpy: tochikaJPY, issuer: "Hokkoku", route: policyOK ? "policy-approved" : "blocked" },
      { type: "usdc", amount: usdcAmt.toFixed(2), chain: "allowlisted", quote: {
        quote_id: "q-89aa", rate_usdc_jpy: rateUSDCJPY, value_jpy: Math.round(usdcAmt * rateUSDCJPY),
        hold_window_sec: holdSec, hold_start: now.toISOString(), hold_end: new Date(now.getTime()+holdSec*1000).toISOString(),
        slippage_max_bps: slippageBps, source_aggregator_id: "AGG-12"
      }},
      { type: "card", amount_jpy: cardJPY, brand: "visa", authorized: true }
    ],
    counterparties: {
      aggregator: { id: "AGG-12", route_id: "r-56f1", payin_address: "0x...e1f9", txid: "0x...ab87" },
      acquirer: { id: "ACQ-88", payout_batch_id: "POUT-2025-08-27-17", value_date: "T+1" }
    },
    payout: { gross_jpy: totalJPY, fees_jpy: 35, net_jpy: Math.round(totalJPY - 35), bank_last4: "1234" },
    evidence: { event_log_hash: "e3b0...98", attachments: ["policy_snapshot.pdf","quote.png"] }
  };

  const receiptText = `Points2Perks Receipt — Policy-Gated Checkout (Illustrative)
ReceiptID: ${receiptJSON.receipt_id}          ReconciliationID (RID): ${rid}
OrderID: ${receiptJSON.order_id}                      Timestamp (local): ${now.toLocaleString()}
Jurisdiction: ${jurisdiction} (Domestic)              Policy Version: JP-1.4 (hash: a9f1…c2)
Merchant: ${merchantName} (${receiptJSON.merchant.id})  Payout Currency: JPY

Tender Summary
• Tochika:     ${tochikaJPY.toLocaleString()} JPY (issuer: Hokkoku)                Route: ${policyOK ? "policy-approved" : "blocked"}
• USDC:        ${usdcAmt.toFixed(2)} USDC  → quoted ${(usdcAmt * rateUSDCJPY).toFixed(0)} JPY             QuoteID: q-89aa; Rate: 1 USDC=${rateUSDCJPY} JPY
• Card:        ${cardJPY} JPY (fallback)                          Brand: Visa; Auth: yes
Total:         ${totalJPY.toLocaleString()} JPY

Quote & Hold
• Hold Window: ${holdSec}s (start: ${quoteStart ? new Date(quoteStart).toLocaleTimeString() : "—"})
• Slippage Max: ${(slippageBps/100).toFixed(2)}%   Locked Rate: ${quoteRate ?? "—"}   Current Rate: ${rateUSDCJPY}
• Finalized At: ${now.toLocaleTimeString()}                  Source: Aggregator AGG-12 (licensed)
• If hold expired or slippage breached → fail-closed to card

Policy Snapshot (applied at checkout)
• On/Off=${policyApplied.on_off}; Max per txn=${policyApplied.max_per_txn_local} ${jurisdiction === "JP" ? "JPY" : "HKD"}; Time window=${policyApplied.time_window_local}
• Required disclosures: ${policyApplied.required_disclosures.join(", ")}
• KYC level=Partner; Travel Rule applied via aggregator; Sanctions screen=Pass

Counterparties & References
• Aggregator: AGG-12 / route r-56f1; pay-in addr (USDC): 0x…e1f9  TXID: 0x…ab87
• Acquirer/PSP: ACQ-88 / batch: POUT-2025-08-27-17  Value Date: T+1
• Statement Descriptor: ${merchantName.toUpperCase().split(" ").join("*")}*${rid}

Payout & Recon
• Payout Amount (net): ${(totalJPY - 35).toFixed(0)} JPY (fees: 35 JPY) to Bank ****1234
• T+1 recon: RID appears in acquirer file, aggregator report, and bank statement memo

Refunds/Disputes
• Refund path: original instruments per policy; evidence pack = receipt JSON + logs
• Support refs: ACQ-CASE-LINK, AGG-CASE-LINK`;

  const reconCSV = useMemo(() => {
    const hdr = [
      "RID","Order_ID","Receipt_ID","Merchant_ID","Merchant_Name","Payout_Batch_ID","Payout_Date","Value_Date","Payout_Currency","Amount_Gross","Fees_Aggregator","Fees_PSP","Fees_Mozgroup","Amount_Net","Bank_Account_Last4","Statement_Descriptor","Status","Dispute_Flag","Refund_Flag","Aggregator_ID","Aggregator_Route_ID","Acquirer_ID","Asset_In_Type","Asset_In_Amount","Asset_In_Chain","Asset_In_TXID","Quote_ID","Quote_Rate","Hold_Start","Hold_End","Policy_Version","Policy_Hash"
    ].join(",");

    const row = [
      rid,
      receiptJSON.order_id,
      receiptJSON.receipt_id,
      "MERCH-1029",
      merchantName,
      "POUT-2025-08-27-17",
      now.toISOString().slice(0,10),
      "T+1",
      "JPY",
      Math.round(totalJPY).toString(),
      "20","10","5",
      Math.round(totalJPY - 35).toString(),
      "1234",
      receiptJSON.merchant.bank_descriptor,
      "paid","no","no",
      "AGG-12","r-56f1","ACQ-88",
      usdcAmt > 0 ? "USDC" : "Card", usdcAmt > 0 ? usdcAmt.toFixed(2) : cardJPY.toFixed(0), usdcAmt > 0 ? "allowlisted" : "—", usdcAmt > 0 ? "0x...ab87" : "—",
      "q-89aa", rateUSDCJPY.toString(),
      quoteStart ? new Date(quoteStart).toISOString() : now.toISOString(), new Date(now.getTime()+holdSec*1000).toISOString(),
      "JP-1.4","a9f1...c2"
    ].map(v => csvEscape(String(v))).join(",");

    return [hdr, row].join("\n");
  }, [rid, receiptJSON, merchantName, now, totalJPY, usdcAmt, cardJPY, rateUSDCJPY, holdSec, quoteStart]);

  const policyCSV = useMemo(() => buildPolicyCSV(POLICY_MATRIX), []);

  // Gate message
  const gateMessage = !policyOK
    ? (policyApplied.on_off === "OFF" ? "Blocked: Policy OFF." : (!windowOK ? "Blocked: Outside time window." : !perTxnOK ? "Blocked: Exceeds per-txn cap." : "Blocked: Policy rule."))
    : (!quoteOK ? (!holdValid ? "Blocked: Quote hold expired → fail-closed to card." : "Blocked: Slippage bound breached → fail-closed to card.") : "Approved (rules satisfied).");

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">Policy-Gated Checkout — Sandbox Demo</h1>
          <p className="text-sm text-gray-600">Issuer-first • Aggregator-agnostic • Merchants settle in fiat • <span className="font-semibold">concept demo (no production changes)</span></p>
        </header>

        <div className="grid md:grid-cols-3 gap-4">
          {/* Inputs */}
          <section className="md:col-span-1 bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">1) Inputs</h2>
            <label className="block text-sm mb-1">Jurisdiction</label>
            <select value={jurisdiction} onChange={e=>setJurisdiction(e.target.value)} className="w-full border rounded px-2 py-1 mb-3">
              <option value="JP">Japan (JP)</option>
              <option value="HK">Hong Kong (HK)</option>
            </select>

            <label className="block text-sm mb-1">Merchant name</label>
            <input value={merchantName} onChange={e=>setMerchantName(e.target.value)} className="w-full border rounded px-2 py-1 mb-3" />

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-sm mb-1">Tochika (JPY)</label>
                <input type="number" value={tochikaJPY} onChange={e=>setTochikaJPY(parseFloat(e.target.value||"0"))} className="w-full border rounded px-2 py-1" />
              </div>
              <div>
                <label className="block text-sm mb-1">USDC (amt)</label>
                <input type="number" step="0.01" value={usdcAmt} onChange={e=>setUsdcAmt(parseFloat(e.target.value||"0"))} className="w-full border rounded px-2 py-1" />
              </div>
              <div>
                <label className="block text-sm mb-1">Card (JPY)</label>
                <input type="number" value={cardJPY} onChange={e=>setCardJPY(parseFloat(e.target.value||"0"))} className="w-full border rounded px-2 py-1" />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-3">
              <div>
                <label className="block text-sm mb-1">USDC→JPY rate</label>
                <input type="number" step="0.01" value={rateUSDCJPY} onChange={e=>setRateUSDCJPY(parseFloat(e.target.value||"0"))} className="w-full border rounded px-2 py-1" />
              </div>
              <div>
                <label className="block text-sm mb-1">Hold (sec)</label>
                <input type="number" value={holdSec} onChange={e=>setHoldSec(parseInt(e.target.value||"0"))} className="w-full border rounded px-2 py-1" />
              </div>
              <div>
                <label className="block text-sm mb-1">Slippage (bps)</label>
                <input type="number" value={slippageBps} onChange={e=>setSlippageBps(parseInt(e.target.value||"0"))} className="w-full border rounded px-2 py-1" />
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-sm mb-1">Demo time (local)</label>
              <input type="datetime-local" value={new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16)} onChange={e=>setNow(new Date(e.target.value))} className="w-full border rounded px-2 py-1" />
            </div>

            {/* Quote controls */}
            <div className="mt-3 flex gap-2 flex-wrap">
              <button className="px-3 py-1 rounded bg-gray-900 text-white text-xs" onClick={()=>{ setQuoteLocked(true); setQuoteRate(rateUSDCJPY); setQuoteStart(new Date()); }}>
                Lock quote
              </button>
              <button className="px-3 py-1 rounded bg-gray-200 text-gray-900 text-xs" onClick={()=>{ setQuoteLocked(false); setQuoteRate(null); setQuoteStart(null); }}>
                Reset quote
              </button>
              <label className="text-sm flex items-center gap-2">
                <input type="checkbox" checked={autoFallback} onChange={e=>setAutoFallback(e.target.checked)} />
                Auto-fallback to card on breach/expiry
              </label>
            </div>

            <div className="mt-4 text-sm text-gray-600">Total (JPY): <span className="font-semibold">{totalJPY.toLocaleString()}</span></div>
          </section>

          {/* Gates & artifacts */}
          <section className="md:col-span-2 bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-2">2) Policy Gate Result</h2>
            <div className={`rounded-xl p-3 mb-3 ${policyOK && quoteOK ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
              <div className="text-sm">{gateMessage}</div>
              <div className="text-xs text-gray-600 mt-1">
                Window {policyApplied.time_window_local}; Max/txn {policyApplied.max_per_txn_local} {jurisdiction === "JP" ? "JPY" : "HKD"}; Disclosures: {policyApplied.required_disclosures.join(", ") || "—"}
                {quoteLocked && (<span> • Locked rate {quoteRate ?? "—"} for {holdSec}s</span>)}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <div className="bg-gray-50 rounded-xl p-3">
                <h3 className="font-medium mb-1">Receipt (human-readable)</h3>
                <pre className="text-xs whitespace-pre-wrap leading-5">{receiptText}</pre>
                <div className="mt-2 flex gap-2 flex-wrap">
                  <button className="px-3 py-1 rounded bg-gray-900 text-white text-xs" onClick={()=>download("receipt.json", JSON.stringify(receiptJSON, null, 2), "application/json")}>Download JSON</button>
                  <button className="px-3 py-1 rounded bg-gray-200 text-gray-900 text-xs" onClick={()=>download("receipt.txt", receiptText, "text/plain;charset=utf-8")}>Download TXT</button>
                  <button className="px-3 py-1 rounded bg-indigo-600 text-white text-xs" onClick={()=>generateReceiptPDF(receiptJSON)}>Download PDF</button>
                </div>
              </div>
              <div className="bg-gray-50 rounded-xl p-3">
                <h3 className="font-medium mb-1">Reconciliation (CSV)</h3>
                <pre className="text-xs whitespace-pre leading-5 overflow-x-auto">{reconCSV}</pre>
                <div className="mt-2">
                  <button className="px-3 py-1 rounded bg-gray-900 text-white text-xs" onClick={()=>download("recon.csv", reconCSV, "text/csv;charset=utf-8")}>Download recon.csv</button>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-3 mt-3">
              <h3 className="font-medium mb-1">Policy Matrix (CSV)</h3>
              <pre className="text-xs whitespace-pre leading-5 overflow-x-auto">{policyCSV}</pre>
              <div className="mt-2">
                <button className="px-3 py-1 rounded bg-gray-900 text-white text-xs" onClick={()=>download("policy_matrix.csv", policyCSV, "text/csv;charset=utf-8")}>Download policy_matrix.csv</button>
              </div>
            </div>

            <p className="text-xs text-gray-500 mt-3">Illustrative sandbox only — no custody, no live keys, no production changes. Merchants settle in fiat. Travel Rule/AML handled by licensed partners in real deployments.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
