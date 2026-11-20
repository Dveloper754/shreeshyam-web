// Builds the Ledger content shown inside the app, and generates PDF downloads.
import { inr, ddmmyyyy, esc, todayISO } from "./format.js?v=26";
import { BUSINESS_NAME } from "../config.js";

const noSymbol = (x) => inr(x).replace("₹", ""); // jsPDF's font has no ₹ glyph

// Deliver a finished jsPDF doc without ever replacing the current page.
// Opens the PDF in a new tab (so it's viewable even where downloads are blocked);
// if a popup blocker stops that, falls back to a normal download anchor.
export function deliverPdf(doc, filename) {
  try {
    const url = doc.output("bloburl");
    const w = window.open(url, "_blank");
    if (!w) {
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  } catch (e) {
    doc.save(filename);   // last-resort fallback
  }
}

// Split parties into To Pay / To Receive with totals (shared by PDF + Excel).
export function trialSplit(parties) {
  const pay = parties.filter((p) => p.balance > 0.005).sort((a, b) => b.balance - a.balance);
  const recv = parties.filter((p) => p.balance < -0.005).sort((a, b) => a.balance - b.balance);
  const totPay = pay.reduce((s, p) => s + p.balance, 0);
  const totRecv = recv.reduce((s, p) => s + Math.abs(p.balance), 0);
  return { pay, recv, totPay, totRecv };
}

// Whole-book Trial Balance as a PDF download.
export function downloadTrialPDF(parties) {
  if (!window.jspdf || !window.jspdf.jsPDF) return false;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const { pay, recv, totPay, totRecv } = trialSplit(parties);

  const body = [
    ...pay.map((p) => [p.name, noSymbol(p.balance), ""]),
    ...recv.map((p) => [p.name, "", noSymbol(Math.abs(p.balance))]),
  ];

  doc.setFontSize(15); doc.setTextColor(31, 78, 95);
  doc.text(window.__BRAND || BUSINESS_NAME, 14, 16);
  doc.setFontSize(10); doc.setTextColor(90);
  doc.text(`Trial Balance as on ${ddmmyyyy(todayISO())}    |    All amounts in Indian Rupees (INR)`, 14, 23);

  doc.autoTable({
    startY: 28,
    head: [["Party", "Dena (we owe)", "Lena (owed to us)"]],
    body,
    foot: [["Total", noSymbol(totPay), noSymbol(totRecv)]],
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [31, 78, 95] },
    footStyles: { fillColor: [238, 244, 246], textColor: 20, fontStyle: "bold" },
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
  });

  deliverPdf(doc, `Trial_Balance_${todayISO()}.pdf`);
  return true;
}

// Day Book — all parties' net Dena / Lena, two columns side by side (matches the print reference).
export function downloadDayBookPDF(data, brand) {
  if (!window.jspdf || !window.jspdf.jsPDF) return false;
  const { jsPDF } = window.jspdf;
  const { pay, recv, totPay, totRecv } = data;
  const doc = new jsPDF();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = ddmmyyyy(todayISO());
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  // Header
  doc.setFont("helvetica", "bolditalic"); doc.setFontSize(14); doc.setTextColor(20);
  doc.text(brand || BUSINESS_NAME, 14, 15);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  doc.text(`Day Book For ${dateStr}`, 14, 21);
  doc.text(`Date : ${dateStr}`, 150, 13);
  doc.text(`Time : ${timeStr}`, 150, 18);
  doc.text(`Page No. :  1`, 150, 23);

  const denaBody = pay.map((p) => [p.name, noSymbol(p.balance)]);
  const lenaBody = recv.map((p) => [p.name, noSymbol(Math.abs(p.balance))]);
  const common = {
    startY: 28, theme: "grid",
    styles: { fontSize: 9, cellPadding: 1.8, textColor: 20, lineColor: [210, 210, 210] },
    headStyles: { fillColor: [255, 255, 255], textColor: 20, fontStyle: "bold", lineColor: [20, 20, 20] },
    footStyles: { fillColor: [255, 255, 255], textColor: 20, fontStyle: "bold", lineColor: [20, 20, 20] },
    columnStyles: { 1: { halign: "right" } },
  };
  doc.autoTable({ ...common, margin: { left: 14, right: 108 },
    head: [["Party Name", "Dena"]], body: denaBody,
    foot: [[{ content: "Total :", styles: { halign: "right" } }, noSymbol(totPay)]] });
  doc.autoTable({ ...common, margin: { left: 108, right: 14 },
    head: [["Party Name", "Lena"]], body: lenaBody,
    foot: [[{ content: "Total :", styles: { halign: "right" } }, noSymbol(totRecv)]] });

  deliverPdf(doc, `Day_Book_${todayISO()}.pdf`);
  return true;
}

// Generate a real PDF file the user can save (works without a print dialog).
export function downloadLedgerPDF(party, rows, from, to) {
  if (!window.jspdf || !window.jspdf.jsPDF) return false;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const isCap = !!party._capital;
  let run = 0, totR = 0, totP = 0;

  const c1 = isCap ? "Received" : "Dena", c2 = isCap ? "Paid" : "Lena";
  const body = rows.map((r) => {
    // Balance runs on the stored type. Columns: 'received' leg = Dena, 'paid' = Lena.
    run += (r.type === "received" ? Number(r.amount) : -Number(r.amount));
    const rec = r.type === "received" ? Number(r.amount) : 0;
    const paid = r.type === "paid" ? Number(r.amount) : 0;
    totR += rec; totP += paid;
    const other = isCap ? (r.party_name || "") : (r.counterparty || "");
    return [ddmmyyyy(r.entry_date), other || "-", r.remark || "-",
            rec ? noSymbol(rec) : "", paid ? noSymbol(paid) : "", noSymbol(run)];
  });

  const period = `${from ? ddmmyyyy(from) : "beginning"} to ${to ? ddmmyyyy(to) : "today"}`;
  doc.setFontSize(15); doc.setTextColor(31, 78, 95);
  doc.text(window.__BRAND || BUSINESS_NAME, 14, 16);
  doc.setFontSize(10); doc.setTextColor(90);
  doc.text(`Ledger — ${party.name}${party.phone ? " · " + party.phone : ""}`, 14, 23);
  doc.text(`Period: ${period}    |    All amounts in Indian Rupees (INR)`, 14, 28);

  doc.autoTable({
    startY: 33,
    head: [["Date", "Party", "Remark", c1, c2, "Balance"]],
    body,
    foot: [["Total", "", "", noSymbol(totR), noSymbol(totP), noSymbol(run)]],
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [31, 78, 95] },
    footStyles: { fillColor: [238, 244, 246], textColor: 20, fontStyle: "bold" },
    columnStyles: { 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
  });

  deliverPdf(doc, `Ledger_${party.name.replace(/[^a-z0-9]+/gi, "_")}.pdf`);
  return true;
}

export function ledgerHTML(party, rows, from, to) {
  const isCap = !!party._capital;
  let run = 0, totR = 0, totP = 0;
  const c1 = isCap ? "Received" : "Dena", c2 = isCap ? "Paid" : "Lena";
  const cls1 = isCap ? "g" : "r", cls2 = isCap ? "r" : "g";

  const body = rows.map((r) => {
    // Balance runs on the stored type. Columns: 'received' leg = Dena, 'paid' = Lena.
    run += (r.type === "received" ? Number(r.amount) : -Number(r.amount));
    const rec = r.type === "received" ? Number(r.amount) : 0;
    const paid = r.type === "paid" ? Number(r.amount) : 0;
    totR += rec; totP += paid;
    const other = isCap ? (r.party_name || "") : (r.counterparty || "");
    return `<tr>
      <td>${ddmmyyyy(r.entry_date)}</td>
      <td>${esc(other) || "-"}</td>
      <td>${esc(r.remark) || "-"}</td>
      <td class="num ${cls1}">${rec ? inr(rec) : ""}</td>
      <td class="num ${cls2}">${paid ? inr(paid) : ""}</td>
      <td class="num">${inr(run)}</td>
    </tr>`;
  }).join("");

  const period = `${from ? ddmmyyyy(from) : "beginning"} to ${to ? ddmmyyyy(to) : "today"}`;
  const net = run;

  return `
    <div class="lv-head">
      <h1>${esc(window.__BRAND || BUSINESS_NAME)}</h1>
      <p class="lv-sub">Ledger — ${esc(party.name)}${party.phone ? " · " + esc(party.phone) : ""}
        &nbsp;|&nbsp; Period: ${period}</p>
    </div>
    <table class="lv-table">
      <thead><tr>
        <th>Date</th><th>Party</th><th>Remark</th>
        <th class="num">${c1}</th><th class="num">${c2}</th><th class="num">Balance</th>
      </tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">No entries in this range.</td></tr>`}</tbody>
      <tfoot><tr>
        <td colspan="3"><b>Total</b></td>
        <td class="num ${cls1}"><b>${inr(totR)}</b></td>
        <td class="num ${cls2}"><b>${inr(totP)}</b></td>
        <td class="num"><b>${inr(net)}</b></td>
      </tr></tfoot>
    </table>`;
}
