const app = document.getElementById("app");
const toastHost = document.getElementById("toast");

const state = {
  data: null,
  tab: "claims",
  selectedClaims: new Set(),
  modal: null,
  filters: { month: "", status: "", employeeId: "" },
  report: null,
  reportMonth: "",
  reportEmployeeId: ""
};

const tabs = {
  admin: [
    ["claims", "Claims"],
    ["employees", "Employees"],
    ["settings", "Settings"],
    ["reports", "Reports"],
    ["audit", "Audit"]
  ],
  employee: [
    ["claims", "Claims"],
    ["reports", "Monthly Report"]
  ]
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function money(value) {
  return Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function employeeOptions(selected = "") {
  return activeEmployees()
    .map((employee) => `<option value="${employee.id}" ${employee.id === selected ? "selected" : ""}>${escapeHtml(employee.name)}</option>`)
    .join("");
}

function activeEmployees() {
  return (state.data?.employees || []).filter((employee) => employee.role === "employee" && employee.status !== "inactive");
}

function allEmployees() {
  return state.data?.employees || [];
}

function claimById(id) {
  return (state.data?.claims || []).find((claim) => claim.id === id);
}

function employeeById(id) {
  return (state.data?.employees || []).find((employee) => employee.id === id);
}

async function api(path, options = {}) {
  const init = {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  };
  if (options.body && typeof options.body !== "string") init.body = JSON.stringify(options.body);
  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === "object" ? payload.error : payload;
    throw new Error(message || "Request failed.");
  }
  return payload;
}

function toast(message) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  toastHost.appendChild(item);
  setTimeout(() => item.remove(), 3200);
}

function formJson(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function ensureReportDefaults() {
  if (!state.reportMonth) state.reportMonth = state.data?.currentMonth || "";
  if (!state.filters.month) state.filters.month = state.data?.currentMonth || "";
  if (state.data?.user?.role === "admin") {
    const firstEmployee = activeEmployees()[0];
    if (!state.reportEmployeeId || !employeeById(state.reportEmployeeId)) {
      state.reportEmployeeId = firstEmployee?.id || "";
    }
  } else {
    state.reportEmployeeId = state.data?.user?.id || "";
  }
}

async function loadReport(shouldRender = true) {
  if (!state.data?.user) return;
  ensureReportDefaults();
  if (!state.reportMonth || !state.reportEmployeeId) {
    state.report = null;
    if (shouldRender) render();
    return;
  }
  const params = new URLSearchParams({ month: state.reportMonth, employeeId: state.reportEmployeeId });
  state.report = (await api(`/api/reports/monthly?${params.toString()}`)).report;
  if (shouldRender) render();
}

async function loadData() {
  state.data = await api("/api/bootstrap");
  ensureReportDefaults();
  await loadReport(false);
  render();
}

function renderLogin() {
  return `
    <main class="login-shell">
      <section class="login-panel">
        <div class="brand">
          <h1>Petrol Allowance Management</h1>
          <span>Employee KM claims and account review</span>
        </div>
        <form class="login-form" data-form="login">
          <label>Email
            <input name="email" type="email" autocomplete="username" required>
          </label>
          <label>Password
            <input name="password" type="password" autocomplete="current-password" required>
          </label>
          <button class="primary" type="submit">Sign in</button>
        </form>
      </section>
    </main>
  `;
}

function renderShell() {
  const user = state.data.user;
  const roleTabs = tabs[user.role] || tabs.employee;
  if (!roleTabs.some(([key]) => key === state.tab)) state.tab = roleTabs[0][0];
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <h1>${escapeHtml(state.data.settings.companyName)}</h1>
          <span>${user.role === "admin" ? "Admin Console" : "Employee Desk"}</span>
        </div>
        <nav class="nav">
          ${roleTabs
            .map(([key, label]) => `<button type="button" data-action="tab" data-tab="${key}" class="${state.tab === key ? "active" : ""}">${label}</button>`)
            .join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="user-chip">
            <strong>${escapeHtml(user.name)}</strong>
            <span>${escapeHtml(user.email)}</span>
          </div>
          <button type="button" data-action="logout">Sign out</button>
        </div>
      </aside>
      <main class="main">
        ${renderCurrentTab()}
      </main>
      ${renderModal()}
    </div>
  `;
}

function renderCurrentTab() {
  const role = state.data.user.role;
  if (role === "admin" && state.tab === "employees") return renderEmployees();
  if (role === "admin" && state.tab === "settings") return renderSettings();
  if (role === "admin" && state.tab === "audit") return renderAudit();
  if (state.tab === "reports") return renderReports();
  return role === "admin" ? renderAdminClaims() : renderEmployeeClaims();
}

function claimMetrics(claims) {
  return claims.reduce(
    (summary, claim) => {
      summary.count += 1;
      summary.km += Number(claim.km || 0);
      summary.amount += Number(claim.amount || 0);
      summary[claim.status] = (summary[claim.status] || 0) + 1;
      return summary;
    },
    { count: 0, km: 0, amount: 0, submitted: 0, approved: 0, rejected: 0, paid: 0 }
  );
}

function visibleClaims() {
  let claims = [...(state.data?.claims || [])];
  if (state.filters.month) claims = claims.filter((claim) => claim.date.startsWith(state.filters.month));
  if (state.filters.status) claims = claims.filter((claim) => claim.status === state.filters.status);
  if (state.filters.employeeId) claims = claims.filter((claim) => claim.employeeId === state.filters.employeeId);
  return claims;
}

function renderMetrics(metrics) {
  return `
    <section class="metrics">
      <div class="metric"><span>Claims</span><strong>${metrics.count}</strong></div>
      <div class="metric"><span>Total KM</span><strong>${money(metrics.km)}</strong></div>
      <div class="metric"><span>Amount</span><strong>${money(metrics.amount)}</strong></div>
      <div class="metric"><span>Submitted</span><strong>${metrics.submitted}</strong></div>
    </section>
  `;
}

function renderAdminClaims() {
  const claims = visibleClaims();
  return `
    <div class="page-head">
      <div>
        <h2>Claims</h2>
        <p>${claims.length} claim(s) in view</p>
      </div>
      <div class="actions">
        <button type="button" data-action="refresh">Refresh</button>
      </div>
    </div>
    ${renderMetrics(claimMetrics(claims))}
    <section class="panel">
      <div class="toolbar">
        <label>Month
          <input type="month" data-filter="month" value="${escapeHtml(state.filters.month)}">
        </label>
        <label>Employee
          <select data-filter="employeeId">
            <option value="">All employees</option>
            ${employeeOptions(state.filters.employeeId)}
          </select>
        </label>
        <label>Status
          <select data-filter="status">
            ${["", "submitted", "approved", "rejected", "paid"]
              .map((status) => `<option value="${status}" ${state.filters.status === status ? "selected" : ""}>${status ? titleCase(status) : "All statuses"}</option>`)
              .join("")}
          </select>
        </label>
        <button type="button" data-action="clear-filters">Clear</button>
      </div>
      <div class="toolbar" style="margin: 12px 0;">
        <button type="button" data-action="bulk" data-bulk="approved">Approve</button>
        <button type="button" data-action="bulk" data-bulk="rejected">Reject</button>
        <button type="button" data-action="bulk" data-bulk="paid">Mark paid</button>
        <button type="button" class="danger" data-action="bulk" data-bulk="delete">Delete</button>
      </div>
      ${renderClaimTable(claims, true)}
    </section>
  `;
}

function renderEmployeeClaims() {
  const claims = visibleClaims();
  const user = state.data.user;
  return `
    <div class="page-head">
      <div>
        <h2>Claims</h2>
        <p>${escapeHtml(user.department || user.site || "Employee")}</p>
      </div>
      <div class="actions">
        <button type="button" data-action="refresh">Refresh</button>
      </div>
    </div>
    ${renderMetrics(claimMetrics(claims))}
    <section class="grid two-col">
      <div class="panel">
        <h3>New Claim</h3>
        <form class="form-grid" data-form="claim">
          <div class="field-row">
            <label>Date
              <input name="date" type="date" value="${todayInputValue()}" required>
            </label>
            <label>KM
              <input name="km" type="number" min="0.1" step="0.1" required>
            </label>
          </div>
          <div class="field-row">
            <label>From
              <input name="from" required>
            </label>
            <label>To
              <input name="to" required>
            </label>
          </div>
          <label>Site
            <input name="site" value="${escapeHtml(user.site || "")}" required>
          </label>
          <label>Purpose
            <input name="purpose" required>
          </label>
          <label>Remarks
            <textarea name="remarks"></textarea>
          </label>
          <button class="primary" type="submit">Submit claim</button>
        </form>
      </div>
      <div class="panel">
        <div class="toolbar" style="margin-bottom: 12px;">
          <label>Month
            <input type="month" data-filter="month" value="${escapeHtml(state.filters.month)}">
          </label>
          <label>Status
            <select data-filter="status">
              ${["", "submitted", "approved", "rejected", "paid"]
                .map((status) => `<option value="${status}" ${state.filters.status === status ? "selected" : ""}>${status ? titleCase(status) : "All statuses"}</option>`)
                .join("")}
            </select>
          </label>
        </div>
        ${renderClaimTable(claims, false)}
      </div>
    </section>
  `;
}

function renderClaimTable(claims, admin) {
  if (!claims.length) return `<div class="empty">No claims found.</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            ${admin ? "<th>Select</th>" : ""}
            <th>Date</th>
            ${admin ? "<th>Employee</th>" : ""}
            <th>Route</th>
            <th>Site</th>
            <th>Purpose</th>
            <th>KM</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Alerts</th>
            ${admin ? "<th>Actions</th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${claims
            .map(
              (claim) => `
                <tr>
                  ${admin ? `<td><input type="checkbox" data-select-claim="${claim.id}" ${state.selectedClaims.has(claim.id) ? "checked" : ""}></td>` : ""}
                  <td>${escapeHtml(claim.date)}</td>
                  ${admin ? `<td><strong>${escapeHtml(claim.employeeName)}</strong><br><span class="muted">${escapeHtml(claim.employeeEmail)}</span></td>` : ""}
                  <td>${escapeHtml(claim.from)}<br><span class="muted">${escapeHtml(claim.to)}</span></td>
                  <td>${escapeHtml(claim.site)}</td>
                  <td>${escapeHtml(claim.purpose)}${claim.remarks ? `<br><span class="muted">${escapeHtml(claim.remarks)}</span>` : ""}</td>
                  <td>${money(claim.km)}</td>
                  <td>${money(claim.amount)}</td>
                  <td><span class="status ${claim.status}">${escapeHtml(claim.status)}</span></td>
                  <td>${(claim.alerts || []).map((alert) => `<span class="alert-pill">${escapeHtml(alert)}</span>`).join("") || '<span class="muted">None</span>'}</td>
                  ${
                    admin
                      ? `<td>
                          <div class="actions">
                            <button type="button" data-action="edit-claim" data-id="${claim.id}">Edit</button>
                            <button type="button" data-action="claim-status" data-status="approved" data-id="${claim.id}">Approve</button>
                            <button type="button" data-action="claim-status" data-status="rejected" data-id="${claim.id}">Reject</button>
                            <button type="button" data-action="claim-status" data-status="paid" data-id="${claim.id}">Paid</button>
                            <button type="button" class="danger" data-action="delete-claim" data-id="${claim.id}">Delete</button>
                          </div>
                        </td>`
                      : ""
                  }
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderEmployees() {
  const employees = allEmployees();
  return `
    <div class="page-head">
      <div>
        <h2>Employees</h2>
        <p>${employees.length} account(s)</p>
      </div>
    </div>
    <section class="grid two-col">
      <div class="panel">
        <h3>Add Employee</h3>
        <form class="form-grid" data-form="employee">
          <label>Name
            <input name="name" required>
          </label>
          <label>Email
            <input name="email" type="email" required>
          </label>
          <div class="field-row">
            <label>Role
              <select name="role">
                <option value="employee">Employee</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label>Password
              <input name="password" type="password" minlength="6" required>
            </label>
          </div>
          <div class="field-row">
            <label>Department
              <input name="department">
            </label>
            <label>Bike Number
              <input name="bikeNumber">
            </label>
          </div>
          <label>Site
            <input name="site">
          </label>
          <button class="primary" type="submit">Create employee</button>
        </form>
      </div>
      <div class="panel">
        ${renderEmployeeTable(employees)}
      </div>
    </section>
  `;
}

function renderEmployeeTable(employees) {
  if (!employees.length) return `<div class="empty">No employees found.</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Department</th>
            <th>Site</th>
            <th>Bike</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${employees
            .map(
              (employee) => `
                <tr>
                  <td><strong>${escapeHtml(employee.name)}</strong><br><span class="muted">${escapeHtml(employee.email)}</span></td>
                  <td>${escapeHtml(titleCase(employee.role))}</td>
                  <td>${escapeHtml(employee.department || "")}</td>
                  <td>${escapeHtml(employee.site || "")}</td>
                  <td>${escapeHtml(employee.bikeNumber || "")}</td>
                  <td><span class="status ${employee.status === "inactive" ? "rejected" : "approved"}">${escapeHtml(employee.status)}</span></td>
                  <td>
                    <div class="actions">
                      <button type="button" data-action="edit-employee" data-id="${employee.id}">Edit</button>
                      <button type="button" class="danger" data-action="deactivate-employee" data-id="${employee.id}">Deactivate</button>
                    </div>
                  </td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSettings() {
  const settings = state.data.settings;
  return `
    <div class="page-head">
      <div>
        <h2>Settings</h2>
        <p>Rates and claim validation</p>
      </div>
    </div>
    <section class="panel">
      <form class="form-grid" data-form="settings">
        <div class="field-row">
          <label>Company Name
            <input name="companyName" value="${escapeHtml(settings.companyName)}" required>
          </label>
          <label>Currency
            <input name="currency" value="${escapeHtml(settings.currency)}" required>
          </label>
        </div>
        <div class="field-row three">
          <label>Rate per KM
            <input name="ratePerKm" type="number" min="0" step="0.01" value="${escapeHtml(settings.ratePerKm)}" required>
          </label>
          <label>Backdated Days
            <input name="maxBackdatedDays" type="number" min="0" step="1" value="${escapeHtml(settings.maxBackdatedDays)}" required>
          </label>
          <label>Daily KM Limit
            <input name="dailyKmLimit" type="number" min="1" step="1" value="${escapeHtml(settings.dailyKmLimit)}" required>
          </label>
        </div>
        <label>Duplicate Policy
          <select name="duplicatePolicy">
            ${["allow", "warn", "block"]
              .map((policy) => `<option value="${policy}" ${settings.duplicatePolicy === policy ? "selected" : ""}>${titleCase(policy)}</option>`)
              .join("")}
          </select>
        </label>
        <button class="primary" type="submit">Save settings</button>
      </form>
    </section>
  `;
}

function renderReports() {
  const report = state.report;
  const params = new URLSearchParams({ month: state.reportMonth, employeeId: state.reportEmployeeId });
  return `
    <div class="page-head">
      <div>
        <h2>Reports</h2>
        <p>Monthly claim totals and exports</p>
      </div>
      <div class="actions">
        <button type="button" data-action="print">Print</button>
        ${report ? `<a class="button" href="/api/reports/monthly.csv?${params.toString()}">CSV</a>` : ""}
        ${report ? `<a class="button" href="/api/reports/monthly.xls?${params.toString()}">Excel</a>` : ""}
        ${state.data.user.role === "admin" ? `<a class="button" href="/api/reports/claims.csv">All claims CSV</a><a class="button" href="/api/backup">Backup JSON</a>` : ""}
      </div>
    </div>
    <section class="panel">
      <div class="toolbar">
        <label>Month
          <input type="month" data-report="month" value="${escapeHtml(state.reportMonth)}">
        </label>
        ${
          state.data.user.role === "admin"
            ? `<label>Employee
                <select data-report="employeeId">${employeeOptions(state.reportEmployeeId)}</select>
              </label>`
            : ""
        }
      </div>
    </section>
    ${report ? renderReportPanel(report) : '<section class="panel"><div class="empty">No report available.</div></section>'}
  `;
}

function renderReportPanel(report) {
  return `
    <section class="panel printable">
      <div class="print-title">
        <h2>${escapeHtml(state.data.settings.companyName)}</h2>
        <p>${escapeHtml(report.employee?.name || "")} - ${escapeHtml(report.month)}</p>
      </div>
      <section class="metrics">
        <div class="metric"><span>Total Claims</span><strong>${report.totals.count}</strong></div>
        <div class="metric"><span>Total KM</span><strong>${money(report.totals.km)}</strong></div>
        <div class="metric"><span>Total Amount</span><strong>${money(report.totals.amount)}</strong></div>
        <div class="metric"><span>Missing Days</span><strong>${report.missingDays.length}</strong></div>
      </section>
      ${report.missingDays.length ? `<p class="muted">Missing: ${escapeHtml(report.missingDays.slice(0, 18).join(", "))}${report.missingDays.length > 18 ? " ..." : ""}</p>` : ""}
      ${renderClaimTable(report.claims, false)}
    </section>
  `;
}

function renderAudit() {
  const logs = state.data.auditLogs || [];
  return `
    <div class="page-head">
      <div>
        <h2>Audit</h2>
        <p>${logs.length} recent event(s)</p>
      </div>
    </div>
    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            ${logs
              .map(
                (log) => `
                  <tr>
                    <td>${escapeHtml(new Date(log.at).toLocaleString())}</td>
                    <td>${escapeHtml(log.actorName)}</td>
                    <td>${escapeHtml(log.action)}</td>
                    <td>${escapeHtml(log.targetType)} / ${escapeHtml(log.targetId)}</td>
                    <td>${escapeHtml(log.details)}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderModal() {
  if (!state.modal) return "";
  if (state.modal.type === "claim") return renderClaimModal();
  if (state.modal.type === "employee") return renderEmployeeModal();
  return "";
}

function renderClaimModal() {
  const claim = claimById(state.modal.id);
  if (!claim) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <h3>Edit Claim</h3>
          <button type="button" data-action="close-modal">Close</button>
        </div>
        <form class="form-grid" data-form="claim-edit" data-id="${claim.id}">
          <div class="field-row">
            <label>Date
              <input name="date" type="date" value="${escapeHtml(claim.date)}" required>
            </label>
            <label>KM
              <input name="km" type="number" min="0.1" step="0.1" value="${escapeHtml(claim.km)}" required>
            </label>
          </div>
          <div class="field-row">
            <label>From
              <input name="from" value="${escapeHtml(claim.from)}" required>
            </label>
            <label>To
              <input name="to" value="${escapeHtml(claim.to)}" required>
            </label>
          </div>
          <label>Site
            <input name="site" value="${escapeHtml(claim.site)}" required>
          </label>
          <label>Purpose
            <input name="purpose" value="${escapeHtml(claim.purpose)}" required>
          </label>
          <label>Remarks
            <textarea name="remarks">${escapeHtml(claim.remarks || "")}</textarea>
          </label>
          <button class="primary" type="submit">Save claim</button>
        </form>
      </section>
    </div>
  `;
}

function renderEmployeeModal() {
  const employee = employeeById(state.modal.id);
  if (!employee) return "";
  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <h3>Edit Employee</h3>
          <button type="button" data-action="close-modal">Close</button>
        </div>
        <form class="form-grid" data-form="employee-edit" data-id="${employee.id}">
          <label>Name
            <input name="name" value="${escapeHtml(employee.name)}" required>
          </label>
          <label>Email
            <input name="email" type="email" value="${escapeHtml(employee.email)}" required>
          </label>
          <div class="field-row">
            <label>Role
              <select name="role">
                <option value="employee" ${employee.role === "employee" ? "selected" : ""}>Employee</option>
                <option value="admin" ${employee.role === "admin" ? "selected" : ""}>Admin</option>
              </select>
            </label>
            <label>Status
              <select name="status">
                <option value="active" ${employee.status === "active" ? "selected" : ""}>Active</option>
                <option value="inactive" ${employee.status === "inactive" ? "selected" : ""}>Inactive</option>
              </select>
            </label>
          </div>
          <div class="field-row">
            <label>Department
              <input name="department" value="${escapeHtml(employee.department || "")}">
            </label>
            <label>Bike Number
              <input name="bikeNumber" value="${escapeHtml(employee.bikeNumber || "")}">
            </label>
          </div>
          <label>Site
            <input name="site" value="${escapeHtml(employee.site || "")}">
          </label>
          <label>New Password
            <input name="password" type="password" minlength="6">
          </label>
          <button class="primary" type="submit">Save employee</button>
        </form>
      </section>
    </div>
  `;
}

function render() {
  app.innerHTML = state.data?.user ? renderShell() : renderLogin();
}

async function submitLogin(form) {
  await api("/api/login", { method: "POST", body: formJson(form) });
  state.tab = "claims";
  await loadData();
  toast("Signed in.");
}

async function submitClaim(form) {
  await api("/api/claims", { method: "POST", body: formJson(form) });
  form.reset();
  await loadData();
  toast("Claim submitted.");
}

async function submitEmployee(form) {
  await api("/api/employees", { method: "POST", body: formJson(form) });
  form.reset();
  await loadData();
  toast("Employee created.");
}

async function submitSettings(form) {
  await api("/api/settings", { method: "PATCH", body: formJson(form) });
  await loadData();
  toast("Settings saved.");
}

async function submitClaimEdit(form) {
  const id = form.dataset.id;
  await api(`/api/claims/${encodeURIComponent(id)}`, { method: "PATCH", body: { edit: formJson(form) } });
  state.modal = null;
  await loadData();
  toast("Claim updated.");
}

async function submitEmployeeEdit(form) {
  const id = form.dataset.id;
  const body = formJson(form);
  if (!body.password) delete body.password;
  await api(`/api/employees/${encodeURIComponent(id)}`, { method: "PATCH", body });
  state.modal = null;
  await loadData();
  toast("Employee updated.");
}

async function updateClaimStatus(id, status) {
  const body = { status };
  if (status === "rejected") {
    const reason = window.prompt("Reject reason", "Not approved");
    if (reason === null) return;
    body.rejectionReason = reason;
  }
  await api(`/api/claims/${encodeURIComponent(id)}`, { method: "PATCH", body });
  await loadData();
  toast(`Claim marked ${status}.`);
}

async function deleteClaim(id) {
  if (!window.confirm("Delete this claim?")) return;
  await api(`/api/claims/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.selectedClaims.delete(id);
  await loadData();
  toast("Claim deleted.");
}

async function bulkClaims(action) {
  const ids = [...state.selectedClaims];
  if (!ids.length) return toast("Select claims first.");
  const body = { ids, action };
  if (action === "rejected") {
    const reason = window.prompt("Reject reason", "Bulk rejected");
    if (reason === null) return;
    body.rejectionReason = reason;
  }
  if (action === "delete" && !window.confirm(`Delete ${ids.length} claim(s)?`)) return;
  await api("/api/claims/bulk", { method: "POST", body });
  state.selectedClaims.clear();
  await loadData();
  toast("Bulk action complete.");
}

async function deactivateEmployee(id) {
  const employee = employeeById(id);
  if (!window.confirm(`Deactivate ${employee?.name || "this employee"}?`)) return;
  await api(`/api/employees/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadData();
  toast("Employee deactivated.");
}

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  try {
    const type = form.dataset.form;
    if (type === "login") await submitLogin(form);
    if (type === "claim") await submitClaim(form);
    if (type === "employee") await submitEmployee(form);
    if (type === "settings") await submitSettings(form);
    if (type === "claim-edit") await submitClaimEdit(form);
    if (type === "employee-edit") await submitEmployeeEdit(form);
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "tab") {
      state.tab = button.dataset.tab;
      state.selectedClaims.clear();
      if (state.tab === "reports") await loadReport(false);
      render();
    }
    if (action === "logout") {
      await api("/api/logout", { method: "POST" });
      state.data = null;
      state.report = null;
      state.tab = "claims";
      render();
    }
    if (action === "refresh") await loadData();
    if (action === "clear-filters") {
      state.filters = { month: "", status: "", employeeId: "" };
      state.selectedClaims.clear();
      render();
    }
    if (action === "edit-claim") {
      state.modal = { type: "claim", id: button.dataset.id };
      render();
    }
    if (action === "claim-status") await updateClaimStatus(button.dataset.id, button.dataset.status);
    if (action === "delete-claim") await deleteClaim(button.dataset.id);
    if (action === "bulk") await bulkClaims(button.dataset.bulk);
    if (action === "edit-employee") {
      state.modal = { type: "employee", id: button.dataset.id };
      render();
    }
    if (action === "deactivate-employee") await deactivateEmployee(button.dataset.id);
    if (action === "close-modal") {
      state.modal = null;
      render();
    }
    if (action === "print") window.print();
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.matches("[data-select-claim]")) {
    if (target.checked) state.selectedClaims.add(target.dataset.selectClaim);
    else state.selectedClaims.delete(target.dataset.selectClaim);
  }
  if (target.matches("[data-filter]")) {
    state.filters[target.dataset.filter] = target.value;
    state.selectedClaims.clear();
    render();
  }
  if (target.matches("[data-report]")) {
    if (target.dataset.report === "month") state.reportMonth = target.value;
    if (target.dataset.report === "employeeId") state.reportEmployeeId = target.value;
    await loadReport();
  }
});

(async function init() {
  try {
    const session = await api("/api/session");
    if (session.user) await loadData();
    else render();
  } catch {
    render();
  }
})();
