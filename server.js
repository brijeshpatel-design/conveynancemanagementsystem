const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";
const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(process.cwd(), "public");
const SESSION_TTL_MS = 1000 * 60 * 60 * 10;

const sessions = new Map();
let initPromise;
let writeQueue = Promise.resolve();

const STATUS_FLOW = new Set(["submitted", "approved", "rejected", "paid"]);
const EMPLOYEE_ROLES = new Set(["admin", "employee"]);

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function datePartsInZone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: values.year, month: values.month, day: values.day };
}

function todayString() {
  const parts = datePartsInZone();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthString() {
  const parts = datePartsInZone();
  return `${parts.year}-${parts.month}`;
}

function dateToUtc(dateString) {
  const [year, month, day] = String(dateString).split("-").map(Number);
  if (!year || !month || !day) return NaN;
  return Date.UTC(year, month - 1, day);
}

function addDays(dateString, days) {
  const base = dateToUtc(dateString);
  const date = new Date(base + days * 86400000);
  return date.toISOString().slice(0, 10);
}

function diffDaysFromToday(dateString) {
  return Math.floor((dateToUtc(todayString()) - dateToUtc(dateString)) / 86400000);
}

function validDateString(dateString) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateString)) && !Number.isNaN(dateToUtc(dateString));
}

function firstDayOfMonth(month) {
  return `${month}-01`;
}

function lastDayOfMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function eachReportDay(month) {
  const start = firstDayOfMonth(month);
  const monthEnd = lastDayOfMonth(month);
  const today = todayString();
  const end = monthEnd < today ? monthEnd : today;
  const days = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    const dayOfWeek = new Date(`${current}T00:00:00.000Z`).getUTCDay();
    if (dayOfWeek !== 0) days.push(current);
  }
  return days;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
}

function makePassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, passwordHash: hashPassword(password, salt) };
}

function verifyPassword(user, password) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const actual = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, salt, ...safe } = user;
  return safe;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function money(value) {
  return Math.round(numeric(value) * 100) / 100;
}

function send(res, status, body, headers = {}) {
  const defaultHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  };
  res.writeHead(status, { ...defaultHeaders, ...headers });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8" });
}

function sendError(res, status, message, details = undefined) {
  sendJson(res, status, { error: message, details });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        return [decodeURIComponent(cookie.slice(0, index)), decodeURIComponent(cookie.slice(index + 1))];
      })
  );
}

function sessionCookie(value, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `sid=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function downloadName(value) {
  return String(value).replace(/[^a-z0-9_.-]/gi, "_");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tableHtml(title, rows) {
  const body = rows
    .map((row, rowIndex) => {
      const tag = rowIndex === 0 ? "th" : "td";
      return `<tr>${row.map((cell) => `<${tag}>${htmlEscape(cell)}</${tag}>`).join("")}</tr>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title></head><body><table border="1">${body}</table></body></html>`;
}

function seedDb() {
  const createdAt = nowIso();
  const today = todayString();
  const adminPassword = makePassword("admin123");
  const employeePassword = makePassword("employee123");
  const users = [
    {
      id: "usr_admin",
      name: "System Admin",
      email: "admin@company.com",
      role: "admin",
      department: "Accounts",
      site: "Head Office",
      bikeNumber: "",
      status: "active",
      createdAt,
      ...adminPassword
    },
    {
      id: "usr_rahul",
      name: "Rahul Sharma",
      email: "rahul@company.com",
      role: "employee",
      department: "Execution",
      site: "Solar EPC Site A",
      bikeNumber: "MH 12 AB 1234",
      status: "active",
      createdAt,
      ...employeePassword
    }
  ];
  const settings = {
    ratePerKm: numeric(process.env.RATE_PER_KM, 3),
    maxBackdatedDays: numeric(process.env.MAX_BACKDATED_DAYS, 3),
    duplicatePolicy: "warn",
    dailyKmLimit: 120,
    companyName: "EPC Petrol Allowance",
    currency: "INR"
  };
  const claimOne = {
    id: "clm_seed_1",
    employeeId: "usr_rahul",
    date: addDays(today, -1),
    from: "Site Office",
    to: "Substation Yard",
    site: "Solar EPC Site A",
    purpose: "Material coordination",
    remarks: "Vendor follow-up",
    km: 38,
    rate: settings.ratePerKm,
    amount: money(38 * settings.ratePerKm),
    status: "submitted",
    alerts: [],
    createdAt,
    updatedAt: createdAt
  };
  const claimTwo = {
    id: "clm_seed_2",
    employeeId: "usr_rahul",
    date: addDays(today, -2),
    from: "Warehouse",
    to: "Site Office",
    site: "Solar EPC Site A",
    purpose: "Document pickup",
    remarks: "",
    km: 22,
    rate: settings.ratePerKm,
    amount: money(22 * settings.ratePerKm),
    status: "approved",
    alerts: [],
    approvedAt: createdAt,
    approvedBy: "usr_admin",
    createdAt,
    updatedAt: createdAt
  };
  return {
    version: 1,
    createdAt,
    settings,
    users,
    claims: [claimOne, claimTwo],
    auditLogs: [
      {
        id: id("aud"),
        at: createdAt,
        actorId: "system",
        actorName: "System",
        action: "seed",
        targetType: "database",
        targetId: "db",
        details: "Initial demo data created"
      }
    ]
  };
}

async function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      if (!fsSync.existsSync(DB_FILE)) {
        await fs.writeFile(DB_FILE, JSON.stringify(seedDb(), null, 2));
      }
    })();
  }
  return initPromise;
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await fs.readFile(DB_FILE, "utf8"));
}

async function writeDb(db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

async function updateDb(mutator) {
  const next = writeQueue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
  writeQueue = next.catch(() => {});
  return next;
}

function audit(db, actor, action, targetType, targetId, details) {
  db.auditLogs.unshift({
    id: id("aud"),
    at: nowIso(),
    actorId: actor?.id || "system",
    actorName: actor?.name || "System",
    action,
    targetType,
    targetId,
    details
  });
  db.auditLogs = db.auditLogs.slice(0, 1000);
}

async function authContext(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return { user: null, session: null };
  const session = sessions.get(sid);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sid);
    return { user: null, session: null };
  }
  const db = await readDb();
  const user = db.users.find((candidate) => candidate.id === session.userId && candidate.status !== "inactive");
  if (!user) {
    sessions.delete(sid);
    return { user: null, session: null };
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { user, session, db, sid };
}

function assertAuth(ctx) {
  if (!ctx.user) throw Object.assign(new Error("Login required"), { status: 401 });
}

function assertAdmin(ctx) {
  assertAuth(ctx);
  if (ctx.user.role !== "admin") throw Object.assign(new Error("Admin access required"), { status: 403 });
}

function employeeName(db, employeeId) {
  return db.users.find((user) => user.id === employeeId)?.name || "Unknown employee";
}

function safeSettings(settings) {
  return {
    ratePerKm: numeric(settings.ratePerKm, 3),
    maxBackdatedDays: numeric(settings.maxBackdatedDays, 3),
    duplicatePolicy: settings.duplicatePolicy || "warn",
    dailyKmLimit: numeric(settings.dailyKmLimit, 120),
    companyName: settings.companyName || "EPC Petrol Allowance",
    currency: settings.currency || "INR"
  };
}

function enrichClaim(db, claim) {
  const user = db.users.find((candidate) => candidate.id === claim.employeeId);
  return {
    ...claim,
    employeeName: user?.name || "Unknown employee",
    employeeEmail: user?.email || "",
    department: user?.department || "",
    bikeNumber: user?.bikeNumber || ""
  };
}

function visibleClaims(db, user, query = {}) {
  let claims = db.claims.map((claim) => enrichClaim(db, claim));
  if (user.role !== "admin") {
    claims = claims.filter((claim) => claim.employeeId === user.id);
  } else if (query.employeeId) {
    claims = claims.filter((claim) => claim.employeeId === query.employeeId);
  }
  if (query.month) claims = claims.filter((claim) => claim.date.startsWith(query.month));
  if (query.status) claims = claims.filter((claim) => claim.status === query.status);
  return claims.sort((a, b) => `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`));
}

function validationForClaim(db, input, employeeId, existingClaimId = null) {
  const settings = safeSettings(db.settings);
  const errors = [];
  const alerts = [];
  const date = String(input.date || "").trim();
  const from = String(input.from || "").trim();
  const to = String(input.to || "").trim();
  const site = String(input.site || "").trim();
  const purpose = String(input.purpose || "").trim();
  const remarks = String(input.remarks || "").trim();
  const km = numeric(input.km, NaN);

  if (!validDateString(date)) errors.push("Enter a valid claim date.");
  if (!from) errors.push("Enter the start location.");
  if (!to) errors.push("Enter the destination.");
  if (!site) errors.push("Enter the site.");
  if (!purpose) errors.push("Enter the purpose.");
  if (!Number.isFinite(km) || km <= 0) errors.push("Enter KM greater than zero.");
  if (km > 500) errors.push("KM cannot exceed 500 for a single claim.");

  if (!errors.length) {
    const age = diffDaysFromToday(date);
    if (age < 0) errors.push("Future claim dates are not allowed.");
    if (age > settings.maxBackdatedDays) {
      errors.push(`Claims can be backdated only up to ${settings.maxBackdatedDays} day(s).`);
    } else if (age > 0) {
      alerts.push(`Backdated entry: ${age} day(s) old.`);
    }

    const sameEmployeeClaims = db.claims.filter(
      (claim) => claim.employeeId === employeeId && claim.id !== existingClaimId && claim.status !== "rejected"
    );
    const exactDuplicate = sameEmployeeClaims.find(
      (claim) =>
        claim.date === date &&
        claim.from.toLowerCase() === from.toLowerCase() &&
        claim.to.toLowerCase() === to.toLowerCase() &&
        numeric(claim.km) === km
    );
    if (exactDuplicate && settings.duplicatePolicy === "block") {
      errors.push("A duplicate claim already exists for this route, date, and KM.");
    } else if (exactDuplicate && settings.duplicatePolicy !== "allow") {
      alerts.push("Possible duplicate claim for the same route, date, and KM.");
    }

    const repeatedRoute = sameEmployeeClaims.find(
      (claim) => claim.date === date && claim.from.toLowerCase() === from.toLowerCase() && claim.to.toLowerCase() === to.toLowerCase()
    );
    if (repeatedRoute && repeatedRoute.id !== exactDuplicate?.id) {
      alerts.push("Repeated route on the same day.");
    }

    const dayKm = sameEmployeeClaims
      .filter((claim) => claim.date === date)
      .reduce((total, claim) => total + numeric(claim.km), 0);
    if (dayKm + km > settings.dailyKmLimit) {
      alerts.push(`High KM alert: day total becomes ${dayKm + km} KM against ${settings.dailyKmLimit} KM limit.`);
    }
  }

  return {
    errors,
    claim: {
      date,
      from,
      to,
      site,
      purpose,
      remarks,
      km,
      rate: settings.ratePerKm,
      amount: money(km * settings.ratePerKm),
      alerts
    }
  };
}

function reportForEmployee(db, employeeId, month) {
  const claims = visibleClaims(db, { id: employeeId, role: "employee" }, { month });
  const claimDates = new Set(claims.map((claim) => claim.date));
  const missingDays = eachReportDay(month).filter((day) => !claimDates.has(day));
  const totals = claims.reduce(
    (summary, claim) => {
      summary.km += numeric(claim.km);
      summary.amount += numeric(claim.amount);
      summary.count += 1;
      summary.byStatus[claim.status] = (summary.byStatus[claim.status] || 0) + numeric(claim.amount);
      return summary;
    },
    { km: 0, amount: 0, count: 0, byStatus: {} }
  );
  totals.km = money(totals.km);
  totals.amount = money(totals.amount);
  for (const key of Object.keys(totals.byStatus)) totals.byStatus[key] = money(totals.byStatus[key]);
  return { employee: publicUser(db.users.find((user) => user.id === employeeId)), month, claims, totals, missingDays };
}

function claimsRows(claims) {
  return [
    ["Date", "Employee", "Email", "Department", "From", "To", "Site", "Purpose", "KM", "Rate", "Amount", "Status", "Alerts", "Remarks"],
    ...claims.map((claim) => [
      claim.date,
      claim.employeeName,
      claim.employeeEmail,
      claim.department,
      claim.from,
      claim.to,
      claim.site,
      claim.purpose,
      claim.km,
      claim.rate,
      claim.amount,
      claim.status,
      (claim.alerts || []).join("; "),
      claim.remarks
    ])
  ];
}

function monthlyRows(report) {
  return [
    ["Employee", report.employee?.name || "", "Month", report.month],
    ["Total claims", report.totals.count, "Total KM", report.totals.km],
    ["Total amount", report.totals.amount, "Missing days", report.missingDays.length],
    [],
    ...claimsRows(report.claims)
  ];
}

async function routeLogin(req, res) {
  const body = await readBody(req);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const db = await readDb();
  const user = db.users.find((candidate) => candidate.email === email && candidate.status !== "inactive");
  if (!user || !verifyPassword(user, password)) return sendError(res, 401, "Invalid email or password.");
  const sid = crypto.randomBytes(32).toString("hex");
  sessions.set(sid, { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  await updateDb((writeDbInstance) => {
    audit(writeDbInstance, user, "login", "user", user.id, `${user.name} signed in`);
  });
  send(res, 200, JSON.stringify({ user: publicUser(user) }), {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": sessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000))
  });
}

async function routeLogout(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) sessions.delete(sid);
  send(res, 200, JSON.stringify({ ok: true }), {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": sessionCookie("", 0)
  });
}

async function routeBootstrap(ctx, res) {
  assertAuth(ctx);
  const db = await readDb();
  const employees = db.users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name));
  const payload = {
    user: publicUser(db.users.find((user) => user.id === ctx.user.id)),
    settings: safeSettings(db.settings),
    employees: ctx.user.role === "admin" ? employees : employees.filter((user) => user.id === ctx.user.id),
    claims: visibleClaims(db, ctx.user),
    auditLogs: ctx.user.role === "admin" ? db.auditLogs.slice(0, 250) : [],
    currentMonth: monthString()
  };
  sendJson(res, 200, payload);
}

async function routeClaims(ctx, req, res, url) {
  assertAuth(ctx);
  const db = await readDb();
  if (req.method === "GET") {
    return sendJson(res, 200, { claims: visibleClaims(db, ctx.user, Object.fromEntries(url.searchParams.entries())) });
  }
  if (req.method !== "POST") return sendError(res, 405, "Method not allowed.");

  const body = await readBody(req);
  const employeeId = ctx.user.role === "admin" && body.employeeId ? String(body.employeeId) : ctx.user.id;
  const employee = db.users.find((user) => user.id === employeeId && user.role === "employee" && user.status !== "inactive");
  if (!employee) return sendError(res, 400, "Select an active employee.");

  const result = validationForClaim(db, body, employeeId);
  if (result.errors.length) return sendError(res, 400, result.errors[0], result.errors);

  const created = await updateDb((writeDbInstance) => {
    const freshValidation = validationForClaim(writeDbInstance, body, employeeId);
    if (freshValidation.errors.length) throw Object.assign(new Error(freshValidation.errors[0]), { status: 400, details: freshValidation.errors });
    const claim = {
      id: id("clm"),
      employeeId,
      ...freshValidation.claim,
      status: "submitted",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    writeDbInstance.claims.push(claim);
    audit(writeDbInstance, ctx.user, "create", "claim", claim.id, `${employeeName(writeDbInstance, employeeId)} submitted ${claim.km} KM for ${claim.date}`);
    return enrichClaim(writeDbInstance, claim);
  });
  sendJson(res, 201, { claim: created });
}

async function routeClaimById(ctx, req, res, claimId) {
  assertAdmin(ctx);
  if (req.method === "DELETE") {
    const deleted = await updateDb((db) => {
      const index = db.claims.findIndex((claim) => claim.id === claimId);
      if (index === -1) throw Object.assign(new Error("Claim not found."), { status: 404 });
      const [claim] = db.claims.splice(index, 1);
      audit(db, ctx.user, "delete", "claim", claim.id, `${employeeName(db, claim.employeeId)} claim for ${claim.date} deleted`);
      return claim;
    });
    return sendJson(res, 200, { claim: deleted });
  }
  if (req.method !== "PATCH") return sendError(res, 405, "Method not allowed.");

  const body = await readBody(req);
  const updated = await updateDb((db) => {
    const claim = db.claims.find((candidate) => candidate.id === claimId);
    if (!claim) throw Object.assign(new Error("Claim not found."), { status: 404 });

    if (body.edit) {
      const validation = validationForClaim(db, { ...claim, ...body.edit }, claim.employeeId, claim.id);
      if (validation.errors.length) throw Object.assign(new Error(validation.errors[0]), { status: 400, details: validation.errors });
      Object.assign(claim, validation.claim);
    }

    if (body.status) {
      const nextStatus = String(body.status);
      if (!STATUS_FLOW.has(nextStatus)) throw Object.assign(new Error("Invalid claim status."), { status: 400 });
      claim.status = nextStatus;
      if (nextStatus === "approved") {
        claim.approvedAt = nowIso();
        claim.approvedBy = ctx.user.id;
        delete claim.rejectedAt;
        delete claim.rejectionReason;
      }
      if (nextStatus === "rejected") {
        claim.rejectedAt = nowIso();
        claim.rejectedBy = ctx.user.id;
        claim.rejectionReason = String(body.rejectionReason || "Rejected by admin").trim();
      }
      if (nextStatus === "paid") {
        claim.paidAt = nowIso();
        claim.paidBy = ctx.user.id;
      }
    }

    claim.updatedAt = nowIso();
    audit(db, ctx.user, body.status || body.edit ? "update" : "review", "claim", claim.id, `Claim ${claim.id} updated`);
    return enrichClaim(db, claim);
  });
  sendJson(res, 200, { claim: updated });
}

async function routeBulkClaims(ctx, req, res) {
  assertAdmin(ctx);
  if (req.method !== "POST") return sendError(res, 405, "Method not allowed.");
  const body = await readBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const action = String(body.action || "");
  if (!ids.length) return sendError(res, 400, "Select at least one claim.");
  if (!["approved", "rejected", "paid", "delete"].includes(action)) return sendError(res, 400, "Select a valid bulk action.");

  const result = await updateDb((db) => {
    let count = 0;
    if (action === "delete") {
      db.claims = db.claims.filter((claim) => {
        if (ids.includes(claim.id)) {
          count += 1;
          return false;
        }
        return true;
      });
    } else {
      for (const claim of db.claims) {
        if (!ids.includes(claim.id)) continue;
        claim.status = action;
        claim.updatedAt = nowIso();
        if (action === "approved") {
          claim.approvedAt = nowIso();
          claim.approvedBy = ctx.user.id;
        }
        if (action === "rejected") {
          claim.rejectedAt = nowIso();
          claim.rejectedBy = ctx.user.id;
          claim.rejectionReason = String(body.rejectionReason || "Bulk rejected").trim();
        }
        if (action === "paid") {
          claim.paidAt = nowIso();
          claim.paidBy = ctx.user.id;
        }
        count += 1;
      }
    }
    audit(db, ctx.user, "bulk", "claim", ids.join(","), `${count} claim(s) changed to ${action}`);
    return { count };
  });
  sendJson(res, 200, result);
}

async function routeEmployees(ctx, req, res) {
  assertAdmin(ctx);
  if (req.method === "GET") {
    const db = await readDb();
    return sendJson(res, 200, { employees: db.users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (req.method !== "POST") return sendError(res, 405, "Method not allowed.");

  const body = await readBody(req);
  const email = normalizeEmail(body.email);
  const name = String(body.name || "").trim();
  const role = EMPLOYEE_ROLES.has(body.role) ? body.role : "employee";
  if (!name) return sendError(res, 400, "Employee name is required.");
  if (!email || !email.includes("@")) return sendError(res, 400, "Valid email is required.");
  if (!body.password || String(body.password).length < 6) return sendError(res, 400, "Password must be at least 6 characters.");

  const employee = await updateDb((db) => {
    if (db.users.some((user) => user.email === email)) throw Object.assign(new Error("Email already exists."), { status: 409 });
    const password = makePassword(body.password);
    const user = {
      id: id("usr"),
      name,
      email,
      role,
      department: String(body.department || "").trim(),
      site: String(body.site || "").trim(),
      bikeNumber: String(body.bikeNumber || "").trim(),
      status: body.status === "inactive" ? "inactive" : "active",
      createdAt: nowIso(),
      ...password
    };
    db.users.push(user);
    audit(db, ctx.user, "create", "user", user.id, `${user.name} created`);
    return publicUser(user);
  });
  sendJson(res, 201, { employee });
}

async function routeEmployeeById(ctx, req, res, employeeId) {
  assertAdmin(ctx);
  if (req.method === "DELETE") {
    const employee = await updateDb((db) => {
      const user = db.users.find((candidate) => candidate.id === employeeId);
      if (!user) throw Object.assign(new Error("Employee not found."), { status: 404 });
      if (user.id === ctx.user.id) throw Object.assign(new Error("You cannot deactivate your own account."), { status: 400 });
      user.status = "inactive";
      audit(db, ctx.user, "deactivate", "user", user.id, `${user.name} deactivated`);
      return publicUser(user);
    });
    return sendJson(res, 200, { employee });
  }
  if (req.method !== "PATCH") return sendError(res, 405, "Method not allowed.");
  const body = await readBody(req);
  const employee = await updateDb((db) => {
    const user = db.users.find((candidate) => candidate.id === employeeId);
    if (!user) throw Object.assign(new Error("Employee not found."), { status: 404 });
    const email = normalizeEmail(body.email ?? user.email);
    if (!email.includes("@")) throw Object.assign(new Error("Valid email is required."), { status: 400 });
    if (db.users.some((candidate) => candidate.id !== employeeId && candidate.email === email)) {
      throw Object.assign(new Error("Email already exists."), { status: 409 });
    }
    user.name = String(body.name ?? user.name).trim() || user.name;
    user.email = email;
    user.role = EMPLOYEE_ROLES.has(body.role) ? body.role : user.role;
    user.department = String(body.department ?? user.department ?? "").trim();
    user.site = String(body.site ?? user.site ?? "").trim();
    user.bikeNumber = String(body.bikeNumber ?? user.bikeNumber ?? "").trim();
    user.status = body.status === "inactive" ? "inactive" : "active";
    if (body.password) {
      if (String(body.password).length < 6) throw Object.assign(new Error("Password must be at least 6 characters."), { status: 400 });
      Object.assign(user, makePassword(body.password));
    }
    audit(db, ctx.user, "update", "user", user.id, `${user.name} updated`);
    return publicUser(user);
  });
  sendJson(res, 200, { employee });
}

async function routeSettings(ctx, req, res) {
  assertAuth(ctx);
  if (req.method === "GET") {
    const db = await readDb();
    return sendJson(res, 200, { settings: safeSettings(db.settings) });
  }
  assertAdmin(ctx);
  if (req.method !== "PATCH") return sendError(res, 405, "Method not allowed.");
  const body = await readBody(req);
  const settings = await updateDb((db) => {
    db.settings = {
      ...safeSettings(db.settings),
      ratePerKm: Math.max(0, numeric(body.ratePerKm, db.settings.ratePerKm)),
      maxBackdatedDays: Math.max(0, Math.floor(numeric(body.maxBackdatedDays, db.settings.maxBackdatedDays))),
      duplicatePolicy: ["allow", "warn", "block"].includes(body.duplicatePolicy) ? body.duplicatePolicy : db.settings.duplicatePolicy,
      dailyKmLimit: Math.max(1, Math.floor(numeric(body.dailyKmLimit, db.settings.dailyKmLimit))),
      companyName: String(body.companyName || db.settings.companyName || "EPC Petrol Allowance").trim(),
      currency: String(body.currency || db.settings.currency || "INR").trim().toUpperCase()
    };
    audit(db, ctx.user, "update", "settings", "global", "Settings updated");
    return safeSettings(db.settings);
  });
  sendJson(res, 200, { settings });
}

async function routeAudit(ctx, req, res) {
  assertAdmin(ctx);
  if (req.method !== "GET") return sendError(res, 405, "Method not allowed.");
  const db = await readDb();
  sendJson(res, 200, { auditLogs: db.auditLogs.slice(0, 500) });
}

async function routeMonthlyReport(ctx, req, res, url, format) {
  assertAuth(ctx);
  const db = await readDb();
  const month = url.searchParams.get("month") || monthString();
  const requestedEmployeeId = url.searchParams.get("employeeId") || ctx.user.id;
  const employeeId = ctx.user.role === "admin" ? requestedEmployeeId : ctx.user.id;
  const employee = db.users.find((user) => user.id === employeeId);
  if (!employee) return sendError(res, 404, "Employee not found.");
  const report = reportForEmployee(db, employeeId, month);
  if (format === "csv") {
    const filename = downloadName(`monthly-${employee.name}-${month}.csv`);
    return send(res, 200, toCsv(monthlyRows(report)), {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    });
  }
  if (format === "xls") {
    const filename = downloadName(`monthly-${employee.name}-${month}.xls`);
    return send(res, 200, tableHtml(`Monthly Report ${month}`, monthlyRows(report)), {
      "Content-Type": "application/vnd.ms-excel; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    });
  }
  sendJson(res, 200, { report });
}

async function routeAllClaimsCsv(ctx, res, url) {
  assertAdmin(ctx);
  const db = await readDb();
  const claims = visibleClaims(db, ctx.user, Object.fromEntries(url.searchParams.entries()));
  const filename = downloadName(`all-claims-${url.searchParams.get("month") || "full"}.csv`);
  send(res, 200, toCsv(claimsRows(claims)), {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
}

async function routeBackup(ctx, res) {
  assertAdmin(ctx);
  const db = await readDb();
  const filename = downloadName(`petrol-allowance-backup-${todayString()}.json`);
  send(res, 200, JSON.stringify(db, null, 2), {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/login" && req.method === "POST") return routeLogin(req, res);
  if (url.pathname === "/api/logout" && req.method === "POST") return routeLogout(req, res);

  const ctx = await authContext(req);
  if (url.pathname === "/api/session" && req.method === "GET") {
    return sendJson(res, 200, { user: publicUser(ctx.user) });
  }
  if (url.pathname === "/api/bootstrap" && req.method === "GET") return routeBootstrap(ctx, res);
  if (url.pathname === "/api/claims") return routeClaims(ctx, req, res, url);
  if (url.pathname === "/api/claims/bulk") return routeBulkClaims(ctx, req, res);
  if (url.pathname.startsWith("/api/claims/")) return routeClaimById(ctx, req, res, decodeURIComponent(url.pathname.split("/").pop()));
  if (url.pathname === "/api/employees") return routeEmployees(ctx, req, res);
  if (url.pathname.startsWith("/api/employees/")) return routeEmployeeById(ctx, req, res, decodeURIComponent(url.pathname.split("/").pop()));
  if (url.pathname === "/api/settings") return routeSettings(ctx, req, res);
  if (url.pathname === "/api/audit") return routeAudit(ctx, req, res);
  if (url.pathname === "/api/reports/monthly") return routeMonthlyReport(ctx, req, res, url);
  if (url.pathname === "/api/reports/monthly.csv") return routeMonthlyReport(ctx, req, res, url, "csv");
  if (url.pathname === "/api/reports/monthly.xls") return routeMonthlyReport(ctx, req, res, url, "xls");
  if (url.pathname === "/api/reports/claims.csv") return routeAllClaimsCsv(ctx, res, url);
  if (url.pathname === "/api/backup") return routeBackup(ctx, res);
  sendError(res, 404, "API route not found.");
}

async function serveStatic(req, res, url) {
  const cleanPath = decodeURIComponent(url.pathname.split("?")[0]);
  let requested = cleanPath === "/" ? "/index.html" : cleanPath;
  const absolute = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!absolute.startsWith(PUBLIC_DIR)) return sendError(res, 403, "Forbidden.");
  let filePath = absolute;
  if (!fsSync.existsSync(filePath) || fsSync.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }
  const extension = path.extname(filePath).toLowerCase();
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  }[extension] || "application/octet-stream";
  send(res, 200, await fs.readFile(filePath), {
    "Content-Type": mime,
    "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600"
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    sendError(res, status, error.message || "Server error.", error.details);
  }
});

ensureDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Petrol Allowance Management running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize data store", error);
    process.exit(1);
  });
