# Petrol Allowance Management System

Production-ready MVP for EPC employee bike petrol allowance claims.

## Features

- Employee login with registered email.
- Employee KM claim submission with from, to, site, purpose, and remarks.
- Employee claim history and monthly report.
- Admin claim review with edit, approve, reject, paid, and delete actions.
- Bulk approve, reject, paid, and delete.
- Configurable rate per KM, backdated day limit, duplicate policy, and daily KM limit.
- Validation alerts for duplicate claims, repeated routes, backdated entries, high KM, and missing report days.
- Employee management.
- Audit logs.
- Excel-compatible `.xls`, CSV, browser print/save PDF reports.
- Admin-only full database backup export as `.json`.
- Admin-only all-claims export as `.csv`.
- Render.com ready with `npm start`.

## Demo Login

Admin:

```text
Email: admin@company.com
Password: admin123
```

Employee:

```text
Email: rahul@company.com
Password: employee123
```

## Run Locally

```text
npm start
```

Open:

```text
http://localhost:3000
```

The app stores data in:

```text
data/db.json
```

If `data/db.json` does not exist, the server creates seed users, settings, sample claims, and audit logs automatically.

## Render.com Deployment

1. Push this folder to a GitHub repository.
2. Open Render.com.
3. Create a new Web Service from the repository, or use the included `render.yaml` as a blueprint.
4. Use these commands:

```text
Build Command: npm install
Start Command: npm start
```

5. Add or keep these environment variables:

```text
APP_TIMEZONE=Asia/Kolkata
DATA_DIR=data
RATE_PER_KM=3
MAX_BACKDATED_DAYS=3
```

The included `render.yaml` provisions a persistent disk mounted at `/opt/render/project/src/data`, so JSON data survives deploys and restarts.

## Production Notes

- Login credentials are not displayed in the application UI.
- Change demo passwords before live use.
- Keep the Render persistent disk if using JSON storage.
- For larger teams or concurrent accounting workflows, migrate storage to PostgreSQL.
- Keep approved and paid claim edits restricted to admins.
- Export monthly approved reports for accounts before marking claims as paid.
