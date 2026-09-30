const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const requestedFile = args.find(a => !a.startsWith('-')) || 'emails.txt';
const emailFile = path.resolve(__dirname, requestedFile);
if (!fs.existsSync(emailFile)) {
  console.error(`File not found: ${requestedFile}`);
  process.exit(1);
}

// Check if @gmail.com addresses should be allowed via CLI argument, env var, or settings.json
let settings = {};
try {
  const settingsFile = path.resolve(__dirname, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  }
} catch (e) {}

const allowGmail = args.includes('--allow-gmail') ||
  args.includes('--include-gmail') ||
  args.includes('-g') ||
  process.env.ALLOW_GMAIL === 'true' ||
  (settings.skipPersonalGmail === false);

const DUMMY_EMAILS = new Set([
  'user@example.com',
  'user+tag@email.com',
  'your@gmail.com',
  'your-email@gmail.com',
  'recruiter@company.com',
  'test@test.com',
]);

const SELF_EMAILS = new Set([
  'milinchaware@gmail.com',
  'milinchaware9@gmail.com',
]);

function sanitizeEmailCandidate(str) {
  if (!str) return '';
  let clean = str.trim().toLowerCase();
  clean = clean.replace(/^[<"'\s]+|[>"'\s]+$/g, '');
  clean = clean.replace(/^email\.+/i, '');
  clean = clean.replace(/[.,;:!?]+$/, '');
  return clean;
}

function isValidRfcEmail(email, skipGmail = !allowGmail) {
  if (!email || typeof email !== 'string') return false;
  const clean = email.trim().toLowerCase();
  if (skipGmail && (clean.endsWith('@gmail.com') || clean.includes('@gmail.'))) return false;
  if (DUMMY_EMAILS.has(clean) || SELF_EMAILS.has(clean)) return false;
  if (clean.length < 6 || clean.length > 254) return false;
  if (clean.includes(' ')) return false;

  const parts = clean.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;

  // Local-part checks (RFC 5321)
  if (!local || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.')) return false;
  if (local.includes('..')) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)) return false;

  // Domain checks (RFC 5321)
  if (!domain || domain.length > 255) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.startsWith('-') || domain.endsWith('-')) return false;
  if (domain.includes('..')) return false;
  if (!/^[a-z0-9.-]+$/i.test(domain)) return false;

  const domainParts = domain.split('.');
  if (domainParts.length < 2) return false;
  const tld = domainParts[domainParts.length - 1];
  if (!/^[a-z]{2,}$/i.test(tld)) return false;
  if (['png', 'jpg', 'jpeg', 'pdf', 'gif', 'txt', 'zip'].includes(tld)) return false;

  return true;
}

const rawEmails = fs.readFileSync(emailFile, 'utf8').split(/\r?\n/);

const uniqueEmails = new Set();
const cleanedLines = [];
let duplicateCount = 0;
let invalidCount = 0;
let dummyOrSelfCount = 0;
let repairedCount = 0;

for (const rawLine of rawEmails) {
  const line = rawLine.trim();
  if (!line) continue;
  if (line.startsWith('#')) {
    cleanedLines.push(line);
    continue;
  }

  let emailCandidate = line;
  let companyContext = '';
  if (line.includes(',')) {
    const parts = line.split(',');
    emailCandidate = parts[0].trim();
    companyContext = parts.slice(1).join(',').trim();
  } else if (line.includes(' ') && !line.includes('@')) {
    invalidCount++;
    continue;
  }

  const rawCandidate = emailCandidate;
  const sanitized = sanitizeEmailCandidate(rawCandidate);
  if (sanitized !== rawCandidate.toLowerCase()) {
    repairedCount++;
  }

  if (DUMMY_EMAILS.has(sanitized) || SELF_EMAILS.has(sanitized)) {
    dummyOrSelfCount++;
    continue;
  }

  if (!isValidRfcEmail(sanitized)) {
    invalidCount++;
    continue;
  }

  if (uniqueEmails.has(sanitized)) {
    duplicateCount++;
  } else {
    uniqueEmails.add(sanitized);
    if (companyContext) {
      cleanedLines.push(`${sanitized}, ${companyContext}`);
    } else {
      cleanedLines.push(sanitized);
    }
  }
}

fs.writeFileSync(emailFile, cleanedLines.join('\n') + (cleanedLines.length ? '\n' : ''), 'utf8');

console.log(`\n✓ Processing complete!`);
console.log(`File cleaned: ${requestedFile}`);
console.log(`Total unique valid emails: ${uniqueEmails.size}`);
console.log(`Duplicates removed: ${duplicateCount}`);
console.log(`Invalid RFC entries removed: ${invalidCount}`);
console.log(`Dummy / Self-emails removed: ${dummyOrSelfCount}`);
console.log(`@gmail.com leads: ${allowGmail ? 'ALLOWED (retained)' : 'SKIPPED (pass --allow-gmail to keep)'}`);
if (repairedCount > 0) {
  console.log(`Prefixes/typos auto-repaired: ${repairedCount}`);
}
