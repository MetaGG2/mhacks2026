export const PRIVACY_MESSAGE = "Could not produce summary due to privacy concerns";

/**
 * Sites where page content is personal enough that WebHound never calls the API.
 * Entries with a dot match that domain and its subdomains; entries without a dot
 * match any site whose address contains the word (e.g. "mychart").
 */
export const DEFAULT_BLACKLIST = [
  // Banks and credit unions
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com",
  "usbank.com", "pnc.com", "truist.com", "capitalone.com", "td.com", "tdbank.com",
  "ally.com", "discover.com", "americanexpress.com", "synchronybank.com", "sofi.com",
  "chime.com", "citizensbank.com", "53.com", "key.com", "regions.com",
  "huntington.com", "mtb.com", "navyfederal.org", "usaa.com", "becu.org",
  "hsbc.com", "barclays.com", "barclays.co.uk", "santander.com", "lloydsbank.com",
  "natwest.com", "rbc.com", "scotiabank.com", "bmo.com", "cibc.com",
  // Investing, credit and payments
  "schwab.com", "fidelity.com", "vanguard.com", "etrade.com", "robinhood.com",
  "merrilledge.com", "wealthfront.com", "betterment.com", "morganstanley.com",
  "paypal.com", "venmo.com", "cash.app", "zellepay.com", "wise.com",
  "klarna.com", "affirm.com", "creditkarma.com", "experian.com", "equifax.com",
  "transunion.com",
  // Crypto
  "coinbase.com", "kraken.com", "binance.com", "binance.us", "crypto.com", "gemini.com",
  // Taxes, government IDs and benefits
  "irs.gov", "ssa.gov", "login.gov", "id.me", "healthcare.gov", "studentaid.gov",
  "va.gov", "turbotax.intuit.com", "hrblock.com",
  // Health records
  "mychart", "kaiserpermanente.org", "labcorp.com", "questdiagnostics.com",
  "followmyhealth.com",
  // Payroll and HR
  "adp.com", "myworkday.com", "paychex.com", "gusto.com",
  // Accounts, passwords and private mail
  "accounts.google.com", "myaccount.google.com", "mail.google.com",
  "login.microsoftonline.com", "account.microsoft.com", "login.live.com",
  "outlook.live.com", "outlook.office.com", "appleid.apple.com", "account.apple.com",
  "mail.yahoo.com", "mail.proton.me", "pass.proton.me", "okta.com",
  "1password.com", "lastpass.com", "bitwarden.com", "dashlane.com", "keepersecurity.com",
];

const MAX_BLACKLIST_BYTES = 7500; // chrome.storage.sync allows 8 KB per item.

export function normalizeEntry(entry) {
  return String(entry ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]/g, "");
}

export function normalizeBlacklist(entries) {
  const list = [...new Set((Array.isArray(entries) ? entries : []).map(normalizeEntry).filter(Boolean))];
  if (JSON.stringify(list).length > MAX_BLACKLIST_BYTES) {
    throw new Error("The blacklist is too long to save. Remove some entries and try again.");
  }
  return list;
}

export function effectiveBlacklist(stored) {
  return Array.isArray(stored) ? stored : DEFAULT_BLACKLIST;
}

export function isBlacklisted(url, list) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return effectiveBlacklist(list).some((entry) =>
    entry.includes(".") ? host === entry || host.endsWith(`.${entry}`) : host.includes(entry));
}
