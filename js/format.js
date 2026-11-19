// Small formatting / helper utilities (no dependencies).

// Decimal places for money display (User Settings: .00 = 2, .000 = 3).
let DP = 2;
export function setDecimals(n) { DP = (Number(n) === 3) ? 3 : 2; }

// Indian-number format, e.g. 1234567.5 -> "₹12,34,567.50". Negatives keep sign.
export function inr(amount) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  let [w, f] = abs.toFixed(DP).split(".");
  let last3 = w.slice(-3);
  const rest = w.slice(0, -3);
  if (rest) last3 = "," + last3;
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + last3;
  return sign + "₹" + grouped + "." + f;
}

// Plain amount without the ₹ (for inputs / compact display).
export function num(amount) {
  return (Number(amount) || 0).toFixed(DP);
}

// Format an ISO date (YYYY-MM-DD) as DD-MM-YYYY to match the reference app.
export function ddmmyyyy(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

export function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

// Escape text before putting it into innerHTML.
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Label + css class for a party balance.
// Convention: balance = opening + received - paid.
//   > 0  we've net RECEIVED from them  -> we hold their money -> WE PAY  (liability)
//   < 0  we've net PAID them           -> they owe us         -> WE RECEIVE (asset)
export function balanceMeta(balance) {
  const b = Number(balance) || 0;
  if (Math.abs(b) < 0.005) return { label: "settled", cls: "bal-zero" };
  return b > 0
    ? { label: "dena", cls: "bal-neg" }        // we owe them / to pay (red)
    : { label: "lena", cls: "bal-pos" };       // they owe us / to receive (green)
}

// A party's own ledger shows the party's PHYSICAL cash movement. Money moved
// between two parties is stored as a transfer whose `type` is the business's
// balance view — the OPPOSITE of what the party physically did — so we flip
// received<->paid for display. Capital-account rows and any non-transfer entry
// are already physical and shown as stored.
export function physType(row, isCap = false) {
  const isTransfer = row && row.mode === "transfer";
  if (isCap || !isTransfer) return row.type;
  return row.type === "received" ? "paid" : "received";
}
