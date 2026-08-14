# SOP Widget — Login & Report Sharing — Specification

## 1. Tổng quan (Overview)
- **Mục đích**: Bổ sung định danh người dùng qua server và cho phép chia sẻ báo cáo SOP giữa các thành viên, thay cho việc tự gõ tên và tự gửi file HTML thủ công.
- **Actor**: Admin, Member (kỹ sư vận hành)
- **Priority**: High
- **Phase**: Phase 2 (Phase 1 + 1.1 là app offline đã hoàn thành)
- **Ngày soạn**: 2026-08-14
- **Version**: 1.3 (spec của feature; kéo theo `sop-widget.md` lên v1.3)
- **Trạng thái implement**: backend `server/` xong; phía app đã có đăng nhập, tạo tài khoản, gửi và nhận báo cáo. Còn lại xem §18.3
- **Nguồn**: `docs/clarify/clarify_login-report-sharing.md` v1.0 — 5 vòng clarify với PM

Thay đổi bản chất so với Phase 1: sản phẩm chuyển từ **desktop offline hoàn toàn** sang **desktop + server**. Dữ liệu chạy SOP vẫn ở local (D1); server chỉ giữ tài khoản và báo cáo (D2).

## 2. User Story
> As a **kỹ sư vận hành**, I want to **đăng nhập bằng tài khoản của mình và gửi báo cáo SOP thẳng cho đồng nghiệp qua server** so that **báo cáo mang đúng danh tính người thực hiện và người nhận xem được ngay mà tôi không phải gửi file thủ công**.

> As an **admin**, I want to **tạo và quản lý tài khoản member** so that **chỉ người trong team mới gửi/nhận được báo cáo và mỗi báo cáo truy được về đúng người**.

## 3. Actors & Permissions

| Actor | Quyền | Điều kiện |
|---|---|---|
| Admin | Toàn bộ quyền của Member + tạo tài khoản, đặt lại mật khẩu, vô hiệu hóa tài khoản, xem **mọi** báo cáo | Đăng nhập với `role = 'admin'` |
| Member | Chạy SOP (local), gửi báo cáo, xem báo cáo mình gửi và báo cáo được gửi cho mình, đổi mật khẩu của chính mình | Đăng nhập với `role = 'member'`, `is_active = 1` |
| Người phụ trách server | Sửa DB trực tiếp để khôi phục mật khẩu admin | Ngoài ứng dụng, có quyền truy cập MySQL |

Quyền tạo/sửa/xóa **quy trình SOP** vẫn là quyền local của mọi người dùng trên máy của họ — không đổi so với v1.1, vì `procedures`/`steps` không lên server (D1). Xem Q11.

## 4. Entity Schema

### 4.1 Affected entities

| Entity | Location | Operation | Note |
|---|---|---|---|
| `users` | Server (MySQL) | CREATE / READ / UPDATE | **New** |
| `sessions` | Server (MySQL) | CREATE / READ / UPDATE | **New** |
| `reports` | Server (MySQL) | CREATE / READ | **New** |
| `report_recipients` | Server (MySQL) | CREATE / READ / UPDATE | **New** |
| `auth_session` | Local (SQLite) | CREATE / READ / DELETE | **New** — holds the token of the signed-in user |
| `runs` | Local (SQLite) | UPDATE | Existing — 3 new columns |
| `procedures`, `steps`, `step_executions` | Local (SQLite) | — | Unchanged |

Local schema keeps the existing convention: `CREATE TABLE IF NOT EXISTS` inside `db()` plus `ALTER TABLE ADD COLUMN` guarded by `let _ =` (`src-tauri/src/lib.rs:32-41`). No migration tool. Server schema is created fresh by the backend's own migration files.

### 4.2 Server schema (MySQL 8 / MariaDB 10.6+)

**Một bảng phụ ngoài 4 bảng nghiệp vụ** `[v1.3]`: `schema_migrations (name PK, applied_at)` do `server/db/migrate.ts` tự tạo và quản lý, dùng để biết file migration nào đã chạy. Không thuộc nghiệp vụ, không có FK tới bảng nào.

**Time is stored in UTC everywhere.** MySQL `DATETIME` carries no offset, so this is a convention the server must enforce, not something the column type guarantees: the database process and the backend process both run with `TZ=UTC`, every `DATETIME(3)` column below holds UTC, and every timestamp crossing the API is RFC3339 with an explicit offset. Getting this wrong makes `sessions.expires_at` expire at the wrong moment — silently, and differently on each deployment. The local SQLite side already stores RFC3339 UTC strings produced by `now()` (`src-tauri/src/lib.rs:58`), so both sides agree.

**`users`** (new)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | BIGINT UNSIGNED | NO | AUTO_INCREMENT | PK | |
| username | VARCHAR(64) | NO | | UNIQUE | Login identifier. See Q1 |
| display_name | VARCHAR(128) | NO | | | Printed on the report as the operator |
| password_hash | VARCHAR(255) | NO | | | Argon2id (BR-24) |
| role | ENUM('admin','member') | NO | 'member' | | |
| is_active | TINYINT(1) | NO | 1 | | Soft disable — rows are never deleted |
| must_change_password | TINYINT(1) | NO | 0 | | Set to 1 when an admin creates or resets the account |
| created_at | DATETIME(3) | NO | | | UTC |
| updated_at | DATETIME(3) | NO | | | UTC |

Indexes: `uq_users_username` UNIQUE on `(username)`.

**`sessions`** (new)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | BIGINT UNSIGNED | NO | AUTO_INCREMENT | PK | |
| user_id | BIGINT UNSIGNED | NO | | FK → `users.id` RESTRICT | |
| token_hash | CHAR(64) | NO | | UNIQUE | SHA-256 of the opaque token. The raw token is never stored (BR-27) |
| client | ENUM('app','web') | NO | | | `app` = Bearer token, `web` = browser cookie |
| expires_at | DATETIME(3) | NO | | | Issued at + 30 days (D6) |
| revoked_at | DATETIME(3) | YES | NULL | | Set on logout or on password reset |
| created_at | DATETIME(3) | NO | | | |
| last_used_at | DATETIME(3) | YES | NULL | | |

Indexes: `uq_sessions_token` UNIQUE on `(token_hash)`; `idx_sessions_user` on `(user_id, revoked_at)`.

Opaque tokens in a table rather than stateless JWT, because an admin resetting a password must be able to revoke existing sessions immediately (BR-26).

**`reports`** (new)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | CHAR(36) | NO | | PK | UUID v4 generated by the server |
| run_id | CHAR(36) | NO | | | The local `runs.id` this report was produced from. Not unique — the same run may be shared more than once (BR-30) |
| sender_id | BIGINT UNSIGNED | NO | | FK → `users.id` RESTRICT | |
| procedure_name | VARCHAR(255) | NO | | | Copied at upload time for listing without opening the file |
| operator_display_name | VARCHAR(128) | NO | | | Snapshot of who ran the SOP |
| run_started_at | DATETIME(3) | NO | | | From the local run |
| run_status | ENUM('running','completed','cancelled') | NO | | | Status at the moment of sharing |
| storage_path | VARCHAR(512) | NO | | | `[v1.3]` Path of the HTML file **relative to `STORAGE_DIR`**, in the form `{yyyy}/{MM}/{report_id}.html`. Relative so that moving the storage root — or the whole server — does not break every existing report. Resolving to an absolute path always goes through `absolutePathFor()`, which rejects anything escaping the root |
| size_bytes | INT UNSIGNED | NO | | | |
| sha256 | CHAR(64) | NO | | | Hash of the uploaded HTML, computed server-side |
| created_at | DATETIME(3) | NO | | | |

Indexes: `idx_reports_sender` on `(sender_id, created_at)`; `idx_reports_run` on `(run_id)`.

**`report_recipients`** (new)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | BIGINT UNSIGNED | NO | AUTO_INCREMENT | PK | |
| report_id | CHAR(36) | NO | | FK → `reports.id` CASCADE, UNIQUE(report_id, user_id) | |
| user_id | BIGINT UNSIGNED | NO | | FK → `users.id` RESTRICT | |
| first_viewed_at | DATETIME(3) | YES | NULL | | Set on the first successful view/download |
| created_at | DATETIME(3) | NO | | | |

Indexes: `uq_report_recipient` UNIQUE on `(report_id, user_id)`; `idx_recipient_user` on `(user_id, created_at)`.

The HTML file itself is stored on disk, not as a BLOB — a single report reaches 3–13 MB (`sop-widget.md` §15) and MySQL is a poor fit for that volume of binary rows.

### 4.3 Local schema changes (SQLite)

**`auth_session`** (new, at most one row)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | INTEGER | NO | rowid | PK, always 1 | Single-row table |
| user_id | INTEGER | NO | | | Server-side user id |
| username | TEXT | NO | | | |
| display_name | TEXT | NO | | | Used as the operator name at `start_run` (BR-23) |
| role | TEXT | NO | | | `admin` / `member` |
| token | TEXT | NO | | | Raw opaque token, needed to call the API |
| expires_at | TEXT | NO | | | RFC3339 UTC |
| server_url | TEXT | NO | | | Which server this session belongs to. Copied from configuration at sign-in — see §4.4, not typed by the user |
| **must_change_password** | INTEGER | NO | 0 | | Mirrors the server flag so the app can force the change-password screen before anything else, and can hide actions the server would reject |
| created_at | TEXT | NO | | | RFC3339 UTC |

Kept in SQLite rather than `localStorage`, because the Rust side is what issues the HTTP calls and would otherwise need the token passed down on every command — the same problem that forced `operator_name` through a parameter in v1.1 (`sop-widget.md` §5.2).

**`runs`** (existing — 3 new columns via `ALTER TABLE ADD COLUMN`)

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| **operator_user_id** | INTEGER | YES | NULL | `[NEW]` Server-side user id captured at `start_run`. NULL for runs created before this feature |
| **shared_report_id** | TEXT | YES | NULL | `[NEW]` Server `reports.id` of the most recent successful share |
| **shared_at** | TEXT | YES | NULL | `[NEW]` RFC3339 UTC of the most recent successful share |

`runs.operator_name` stays as it is and keeps holding the snapshot of the display name, so BR-15 survives unchanged in spirit and old runs stay readable.

### 4.4 Server address configuration `[v1.3]`

The server address is **not** entered by the user. Tauri does not read `.env` files, so the Rust side resolves it in this order:

| # | Source | Purpose |
|---|---|---|
| 1 | Environment variable `SOP_SERVER_URL` | Development, or pointing one machine at a different server without editing files |
| 2 | File `%APPDATA%\NTA\SOP Widget\server.env`, key `SOP_SERVER_URL` | An administrator changes the server after installation — **no rebuild, no new installer** |
| 3 | `http://localhost:8080` | Fallback |

`server.env` is created on first launch with the default value and a comment explaining how to change it, so an administrator opening the data folder finds the right file without documentation. The parser ignores blank lines and lines starting with `#`, and strips surrounding double quotes.

A value that is neither `http://` nor `https://` is rejected at sign-in with a message naming the offending value, rather than failing later as a generic connection error.

The login screen shows the resolved address as read-only text. It is deliberately visible: when a user reports "cannot sign in", which server the app is talking to is the first thing worth knowing.

This supersedes Q13, which asked whether the address should be hard-coded at build time or typed at sign-in. Neither was chosen.

## 5. API Contract

Base URL: `<SERVER_URL>` — `http://localhost:8080` during Docker development, `http://54.178.76.191/` after deployment (must become HTTPS first, see §12).

All endpoints are prefixed `/api/v1`. All responses are JSON except the report viewer.

### 5.1 Endpoints

| Method | Path | Auth | Role | Description |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | — | — | Sign in, returns an opaque token |
| POST | `/api/v1/auth/logout` | Bearer | any | Revokes the current session |
| GET | `/api/v1/auth/me` | Bearer | any | Current user + remaining session validity |
| POST | `/api/v1/auth/password` | Bearer | any | Change one's own password |
| GET | `/api/v1/users` | Bearer | any | List active users — the recipient picker. Members receive only `id` and `display_name` |
| POST | `/api/v1/users` | Bearer | admin | Create an account |
| PATCH | `/api/v1/users/{id}` | Bearer | admin | Activate / deactivate, change `display_name` or `role` |
| POST | `/api/v1/users/{id}/password-reset` | Bearer | admin | Set a new password and revoke that user's sessions |
| POST | `/api/v1/reports` | Bearer | any | Upload an HTML report and name its recipients |
| GET | `/api/v1/reports/inbox` | Bearer | any | Reports addressed to me |
| GET | `/api/v1/reports/sent` | Bearer | any | Reports I sent |
| GET | `/api/v1/reports/{id}` | Bearer | sender / recipient / admin | Metadata of one report |
| GET | `/api/v1/reports/{id}/content` | Bearer | sender / recipient / admin | The HTML file itself |
| GET | `/r/{id}` | Cookie | sender / recipient / admin | Browser share link — renders the report, redirects to the web login when no valid cookie |
| GET | `/login` | — | — | Minimal web login page serving the share link |
| POST | `/login` | — | — | Web sign-in form target — validates credentials and sets the session cookie |
| POST | `/logout` | Cookie (optional) | any | Web sign-out — revokes the cookie session; thiếu cookie cũng trả `302` chứ không lỗi |
| GET | `/healthz` | — | — | `[v1.3]` Kiểm tra tiến trình còn sống, trả `{ "status": "ok" }`. Không chạm DB — dùng cho healthcheck của Docker và để xác nhận nhanh server đã lên |

**Two independent authentication channels.** The desktop app authenticates with `Authorization: Bearer <ACCESS_TOKEN>` obtained from `POST /api/v1/auth/login`; the browser authenticates with an `HttpOnly` cookie obtained from `POST /login`. They produce separate rows in `sessions`, distinguished by the `client` column, and are revoked independently. Signing in inside the app does **not** sign the user in on their browser: opening a share link for the first time always requires a web sign-in. Both channels are revoked together when an admin resets that user's password (BR-26).

### 5.2 Request / Response detail

**POST `/api/v1/auth/login`**

| Field | Type | Required | Validation |
|---|---|---|---|
| `username` | string | Yes | 1–64 chars |
| `password` | string | Yes | 1–256 chars |

Success `200`:
```json
{
  "data": {
    "token": "<ACCESS_TOKEN>",
    "expires_at": "2026-09-13T04:21:00.000Z",
    "user": { "id": 3, "username": "nguyenvana", "display_name": "Nguyễn Văn A", "role": "member", "must_change_password": false }
  }
}
```

| HTTP | Error Code | Condition | Message (shown to the user, Vietnamese) |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing field | `Vui lòng nhập tên đăng nhập và mật khẩu.` |
| 401 | `INVALID_CREDENTIALS` | Wrong username or password | `Tên đăng nhập hoặc mật khẩu không đúng.` |
| 403 | `ACCOUNT_DISABLED` | `is_active = 0` | `Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên.` |
| 429 | `TOO_MANY_REQUESTS` | Rate limit hit (§12) | `Bạn đã thử quá nhiều lần. Vui lòng đợi ít phút.` |

`INVALID_CREDENTIALS` is returned identically for an unknown username and a wrong password, so the endpoint cannot be used to enumerate accounts.

**POST `/api/v1/auth/logout`**

No body. Sets `revoked_at` on the session behind the presented token and returns `204 No Content`. Calling it with an already invalid token also returns `204` — logging out is idempotent and never reports failure back to a user who is trying to leave.

**GET `/api/v1/auth/me`**

No parameters. Success `200`:
```json
{ "data": { "id": 3, "username": "nguyenvana", "display_name": "Nguyễn Văn A", "role": "member", "must_change_password": false, "expires_at": "2026-09-13T04:21:00.000Z" } }
```
Used by the app to confirm a stored session is still valid and to refresh the cached role. Errors: the common auth errors below.

**POST `/api/v1/auth/password`**

| Field | Type | Required | Validation |
|---|---|---|---|
| `current_password` | string | Yes | Must match the stored hash |
| `new_password` | string | Yes | Same rules as account creation (Q2), must differ from the current one |

Success `204`. On success the server clears `must_change_password` and **revokes every other session of that user**, keeping only the one that made the call.

| HTTP | Error Code | Condition | Message |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | New password fails the rules or equals the old one | `Mật khẩu mới không hợp lệ hoặc trùng mật khẩu cũ.` |
| 401 | `INVALID_CREDENTIALS` | `current_password` wrong | `Mật khẩu hiện tại không đúng.` |

**POST `/api/v1/users`** (admin)

| Field | Type | Required | Validation |
|---|---|---|---|
| `username` | string | Yes | 3–64 chars, `^[a-z0-9._-]+$`, unique |
| `display_name` | string | Yes | 1–128 chars after trim |
| `password` | string | Yes | See Q2 — provisional: ≥ 8 chars |
| `role` | enum | No | `admin` / `member`, default `member` |

Success `201` returns the created user without `password_hash`. Errors: `409 USERNAME_TAKEN` → `Tên đăng nhập đã tồn tại.`; `403 FORBIDDEN` → `Chỉ quản trị viên mới tạo được tài khoản.`

**GET `/api/v1/users`**

Query: `include_inactive` (boolean, default `false`, admin only — a member passing it is ignored rather than rejected).

The response shape depends on the caller's role. A **member** receives only what the recipient picker needs:
```json
{ "data": [ { "id": 5, "display_name": "Trần Thị B" } ] }
```
An **admin** receives the management view:
```json
{ "data": [ { "id": 5, "username": "tranthib", "display_name": "Trần Thị B", "role": "member", "is_active": true, "must_change_password": false, "created_at": "2026-08-14T02:00:00.000Z" } ] }
```
Sorted by `display_name`. The caller is always excluded from a member's list (BR-29 makes them an invalid recipient anyway) but present in an admin's list. No pagination: this endpoint is bounded by team size, and §15 sizes the product for tens of accounts.

**PATCH `/api/v1/users/{id}`** (admin)

| Field | Type | Required | Validation |
|---|---|---|---|
| `display_name` | string | No | 1–128 chars after trim |
| `role` | enum | No | `admin` / `member` |
| `is_active` | boolean | No | |

At least one field must be present. Success `200` returns the updated user in the admin shape above. Deactivating a user also revokes all of their sessions.

| HTTP | Error Code | Condition | Message |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Empty body or invalid value | `Dữ liệu cập nhật không hợp lệ.` |
| 403 | `FORBIDDEN` | Caller is not an admin | `Bạn không có quyền thực hiện thao tác này.` |
| 404 | `NOT_FOUND` | Unknown id | `Không tìm thấy tài khoản.` |
| 409 | `LAST_ADMIN` | The change would leave no active admin | `Không thể vô hiệu hóa hoặc hạ quyền quản trị viên cuối cùng.` |

`LAST_ADMIN` covers both demoting and deactivating, and applies whether or not the target is the caller themselves — otherwise the system can be locked out of account management entirely (§16).

**POST `/api/v1/users/{id}/password-reset`** (admin)

| Field | Type | Required | Validation |
|---|---|---|---|
| `new_password` | string | Yes | Same rules as account creation (Q2) |

Success `200`:
```json
{ "data": { "id": 5, "revoked_sessions": 2 } }
```
Sets the new hash, sets `must_change_password = 1`, and revokes every session of that user (BR-26). Errors: `403 FORBIDDEN`, `404 NOT_FOUND` as above.

**POST `/api/v1/reports`** — `multipart/form-data`

| Part | Type | Required | Validation |
|---|---|---|---|
| `file` | file | Yes | `text/html`, ≤ 25 MB (Q5) |
| `run_id` | string | Yes | UUID v4 |
| `procedure_name` | string | Yes | 1–255 chars |
| `operator_display_name` | string | Yes | 1–128 chars |
| `run_started_at` | string | Yes | RFC3339 |
| `run_status` | enum | Yes | `running` / `completed` / `cancelled` |
| `recipient_ids` | int[] | Yes | Each element must be an active user. See the validation order below |

**Validation order for `recipient_ids`** — the steps run in this sequence, and the first failure wins:

1. Drop duplicates.
2. Drop the sender's own id (BR-29). A user sending only to themselves therefore ends up with an empty list.
3. If the list is now empty → `400 NO_RECIPIENT`. This covers both "no id was sent at all" and "the only id sent was the sender's own".
4. Every remaining id must exist and have `is_active = 1`, otherwise `404 RECIPIENT_NOT_FOUND`.

Steps 1–2 are silent: dropping a duplicate or the sender's own id is never reported as an error.

Success `201`:
```json
{
  "data": {
    "id": "7c1f...", "share_url": "<SERVER_URL>/r/7c1f...",
    "size_bytes": 4821330, "sha256": "9ab3...", "recipients": [{ "id": 5, "display_name": "Trần Thị B" }]
  }
}
```

| HTTP | Error Code | Condition | Message |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or malformed part | `Dữ liệu gửi lên không hợp lệ.` |
| 400 | `NO_RECIPIENT` | `recipient_ids` empty after step 2 above | `Vui lòng chọn ít nhất một người nhận.` |
| 404 | `RECIPIENT_NOT_FOUND` | A recipient id is unknown or inactive | `Người nhận không tồn tại hoặc đã bị vô hiệu hóa.` |
| 413 | `FILE_TOO_LARGE` | Over the limit | `Báo cáo vượt quá dung lượng cho phép ({n} MB).` |
| 415 | `UNSUPPORTED_TYPE` | Not HTML | `Chỉ chấp nhận tệp báo cáo HTML.` |
| 507 | `STORAGE_FULL` | Disk write failed | `Máy chủ không còn dung lượng lưu báo cáo.` |

**GET `/api/v1/reports/inbox`** and **GET `/api/v1/reports/sent`**

Query: `limit` (1–200, default 50), `cursor` (opaque string from the previous page). Ordered by `created_at DESC`.

`inbox` returns reports where the caller is a recipient; `sent` returns reports where the caller is the sender. An admin calling these gets **their own** reports, not everybody's — the blanket admin access of BR-18 applies to reading a specific report, not to browsing other people's lists.

```json
{
  "data": [
    {
      "id": "7c1f...", "run_id": "0b52...", "procedure_name": "Deploy Rails lên EC2",
      "operator_display_name": "Nguyễn Văn A", "run_started_at": "2026-08-14T01:10:00.000Z",
      "run_status": "completed", "size_bytes": 4821330, "created_at": "2026-08-14T01:42:00.000Z",
      "sender": { "id": 3, "display_name": "Nguyễn Văn A" },
      "first_viewed_at": null
    }
  ],
  "next_cursor": null
}
```

`first_viewed_at` is the caller's own view timestamp on `inbox`. On `sent` the field is replaced by `recipients`: an array of `{ id, display_name, first_viewed_at }`, so the sender can see who has opened the report.

**GET `/api/v1/reports/{id}`** — one report's metadata, same object shape as a `sent` entry (including the full `recipients` array). Readable by sender, recipients and admins; anyone else gets `404` (BR-31).

**GET `/api/v1/reports/{id}/content`** — returns `Content-Type: text/html` with the stored file. Access is checked against sender / recipient / admin (BR-18). `403 FORBIDDEN` → `Bạn không có quyền xem báo cáo này.`; `404 NOT_FOUND` → `Không tìm thấy báo cáo.` A non-recipient receives `404`, not `403`, so report ids cannot be probed. The first successful read by a recipient sets their `first_viewed_at`.

### 5.2b Web endpoints (share link)

These four exist only so that a share link opened in a browser can be authenticated. They are HTML, not JSON, and they use the cookie channel described in §5.1.

**GET `/r/{id}`**

| Condition | Response |
|---|---|
| Valid cookie session, caller is sender / recipient / admin | `200` — the stored HTML, served under the CSP of §12. `first_viewed_at` is set **only when the caller is a recipient**, on their first read; a sender or an admin viewing the report changes nothing (they have no `report_recipients` row) |
| Valid cookie session, no access | `404` HTML page — `Không tìm thấy báo cáo.` (BR-31) |
| No or expired cookie | `302` → `/login?next=/r/{id}` |

**GET `/login`**

Renders a minimal sign-in form (username, password, hidden `next`). Query `next` must be a **relative path starting with `/r/`**; anything else is discarded and replaced by `/`, so the parameter cannot be used as an open redirect. Already signed in → `302` to `next`.

**POST `/login`** — `application/x-www-form-urlencoded`

| Field | Type | Required | Validation |
|---|---|---|---|
| `username` | string | Yes | Same as the API |
| `password` | string | Yes | Same as the API |
| `next` | string | No | Relative path under `/r/`, otherwise ignored |

Success: creates a `sessions` row with `client = 'web'`, sets `Set-Cookie: sop_session=<TOKEN>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (`Secure` added once the server runs over HTTPS — §12), then `302` to `next` or `/`.

Failure: re-renders `/login` with `401` and the same Vietnamese messages as the API (`Tên đăng nhập hoặc mật khẩu không đúng.`, `Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên.`, `Bạn đã thử quá nhiều lần. Vui lòng đợi ít phút.`). The rate limit of §12 is shared with the API login — the two paths cannot be used to double the allowance.

**POST `/logout`** — revokes the cookie session, clears the cookie, `302` to `/login`. Requires the cookie to be present; missing cookie also returns `302` rather than an error.

**Common auth errors** on every Bearer endpoint:

| HTTP | Error Code | Condition | Message |
|---|---|---|---|
| 401 | `UNAUTHENTICATED` | Missing, unknown, revoked or expired token | `Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.` |
| 403 | `FORBIDDEN` | Role insufficient | `Bạn không có quyền thực hiện thao tác này.` |
| 403 | `PASSWORD_CHANGE_REQUIRED` | `[v1.3]` `users.must_change_password = 1` — áp cho mọi endpoint trừ `/auth/me`, `/auth/password`, `/auth/logout` (Q15) | `Bạn cần đổi mật khẩu trước khi tiếp tục.` |

**Ghi chú cho phía app**: sai mật khẩu hiện tại ở `POST /auth/password` cũng trả `401`, nhưng đó **không** phải phiên hết hạn. Đừng dọn phiên local trong trường hợp đó, nếu không người dùng bị đẩy về màn hình đăng nhập chỉ vì gõ sai một lần.

### 5.3 Tauri commands (local ↔ frontend)

Trạng thái implement tính đến v1.3 được ghi thẳng trong bảng, để người đọc không tưởng command chưa viết là đã có.

| Command | Params | Returns | Status | Description |
|---|---|---|---|---|
| `server_url` | — | `String` | **Done** | Địa chỉ máy chủ đã giải quyết theo §4.4, chỉ để hiển thị |
| `login` | `username, password` | `AuthSession` | **Done** | Gọi API, ghi `auth_session`. **Không nhận `serverUrl`** — xem §4.4 |
| `logout` | — | `void` | **Done** | Gọi API rồi xóa `auth_session`; vẫn xóa local nếu server không phản hồi |
| `current_session` | — | `AuthSession \| null` | **Done** | Đọc lúc khởi động; NULL hoặc quá hạn → view đăng nhập |
| `change_own_password` | `currentPassword, newPassword` | `AuthSession` | **Done** | Trả phiên đã cập nhật (`must_change_password = false`) |
| `create_member` | `username, displayName, password, role` | `Member` | **Done** | Chỉ admin |
| `list_members` | — | `Recipient[]` | **Done** | Bộ chọn người nhận; cần mạng |
| `share_report` | `runId, recipientIds` | `SharedReport` | **Done** | Xuất file ra máy trước, rồi upload (D4/BR-22) |
| `list_inbox` | — | `InboxItem[]` | **Done** | Báo cáo gửi cho mình. Gọi API với `limit=50` cố định — chưa phân trang ở phía app |
| `open_report_link` | `reportId` | `String` (URL) | **Done** | Mở link trong trình duyệt — xem ghi chú bảo mật dưới bảng |
| `list_sent` | `limit?, cursor?` | `ReportPage` | **Chưa làm** | Báo cáo mình đã gửi, kèm `recipients[].first_viewed_at` để biết ai đã xem |
| `download_report` | `reportId` | `String` (local path) | **Chưa làm** | Tải về `reports/received/` |
| `reset_member_password` | `userId, newPassword` | `void` | **Chưa làm** | Chỉ admin |
| `set_member_active` | `userId, isActive` | `void` | **Chưa làm** | Chỉ admin |

`AuthSession` trả cho frontend **không có field `token`**: token thô chỉ nằm ở phía Rust và trong `auth_session`, đúng §13. `Recipient` là `{ id, display_name }` — phần dùng chung giữa hai hình dạng mà `GET /api/v1/users` trả cho admin và cho member.

`ReportPage` (khi làm `list_sent`) mirror phản hồi API: `{ items: ReportSummary[], next_cursor: string | null }`.

**`open_report_link` cố ý chỉ nhận `report_id`, không nhận URL.** URL do Rust dựng từ `server_url` của phiên hiện tại, sau khi kiểm `report_id` chỉ gồm chữ/số/dấu gạch ngang và `server_url` bắt đầu bằng `http://` hoặc `https://`. Nếu nhận URL từ frontend thì command này trở thành đường mở đường dẫn tùy ý. Mở bằng `rundll32 url.dll,FileProtocolHandler` với tham số truyền trực tiếp cho tiến trình, không qua shell — không thêm dependency và không bị chèn lệnh. Đổi sang `tauri-plugin-opener` sẽ cần thêm crate và permission trong `capabilities/default.json`.

**Ràng buộc đã phát hiện khi implement**: `rusqlite::Connection` không `Send`, nên **không giữ được qua `.await`**. Mọi command async phải đóng scope DB trước khi gọi HTTP rồi mở lại sau — xem khuôn mẫu ở `logout`.

Mọi command mới theo đúng quy ước sẵn có: đăng ký trong `generate_handler!`, bọc trong `src/api.ts`, khai type trong `src/types.ts`, trả `Result<T, String>` với message nghiệp vụ tiếng Việt.

## 6. Điều kiện tiên quyết (Preconditions)
- [ ] Backend chạy được và truy cập được từ máy người dùng (Docker local ở giai đoạn này)
- [ ] MySQL/MariaDB đã khởi tạo schema và **đã seed 1 tài khoản admin**
- [ ] App đã biết `<SERVER_URL>` (cấu hình lúc build hoặc nhập ở màn hình đăng nhập — xem Q13)
- [ ] Người dùng đã được admin tạo tài khoản
- [ ] Với thao tác gửi báo cáo: có kết nối mạng tới server

## 7. Luồng chính (Main Flow)

| # | Actor | Hành động | System Response |
|---|---|---|---|
| 1 | Người dùng | Mở app | Đọc `auth_session`; token còn hạn → vào Picker, hết hạn/không có → màn hình đăng nhập |
| 2 | Người dùng | Nhập tên đăng nhập + mật khẩu | `login` → server trả token 30 ngày → ghi `auth_session` |
| 3 | Người dùng | Chọn quy trình, chạy SOP | Như v1.1; `start_run` ghi `operator_name` và `operator_user_id` **từ tài khoản đang đăng nhập** |
| 4 | System | Bước cuối được xác nhận | Run chuyển `completed`, hiện màn hình tổng kết |
| 5 | Người dùng | Bấm "Gửi báo cáo" | Hiện danh sách member lấy từ server, chọn một hoặc nhiều người nhận |
| 6 | Người dùng | Xác nhận gửi | `export_report` ghi file HTML ra máy trước (D4) → upload lên server → lưu `shared_report_id`, `shared_at` → hiện link chia sẻ |
| 7 | Người nhận | Mở SOP Widget, vào "Báo cáo nhận được" | `list_inbox` trả danh sách; chọn một báo cáo để xem/tải về |
| 8 | Người nhận | (hoặc) Mở link chia sẻ bằng trình duyệt | Server kiểm tra cookie phiên; chưa có cookie → chuyển tới `/login?next=/r/{id}`, đăng nhập xong quay lại đúng báo cáo; có cookie và có quyền → hiển thị HTML |

Bước 8 dùng **phiên đăng nhập riêng của trình duyệt**, không dùng chung với phiên trong app (§5.1). Người nhận đã đăng nhập trong SOP Widget vẫn phải đăng nhập một lần trên trình duyệt khi mở link lần đầu.

## 7b. Flow Diagram

```
([Người dùng]) → [Mở app] → <auth_session còn hạn?>
                                  ↓ Không                      ↓ Có
                          [Màn hình đăng nhập]                  │
                                  ↓                             │
                          <Có mạng?>                            │
                       ↓ Không        ↓ Có                      │
              [Chặn: báo lỗi]   [POST /auth/login]              │
                                      ↓                         │
                              <Thông tin đúng?>                 │
                           ↓ Không          ↓ Có                │
                  [Báo lỗi đăng nhập]  [Ghi auth_session]       │
                                              ↓                 │
                                              └────→ [Picker] ←──┘
                                                        ↓
                                        [Chạy SOP — toàn bộ local]
                                                        ↓
                                              [Run completed]
                                                        ↓
                                        [export_report → ghi file local]
                                                        ↓
                                                  <Có mạng?>
                                       ↓ Không                ↓ Có
                          [Giữ file local, báo chưa gửi]  [Chọn người nhận]
                                                                ↓
                                                    [POST /api/v1/reports]
                                                                ↓
                                                  [Lưu shared_report_id + link]
                                                                ↓
                                        ([Người nhận]) → [Inbox trong app]
                                                      → [hoặc mở /r/{id} trên web]
                                                                ↓
                                                    <Là sender/recipient/admin?>
                                                     ↓ Không          ↓ Có
                                                 [404]          [Hiển thị HTML]
```

> Mermaid source: [assets/login-report-sharing-img1.mmd](assets/login-report-sharing-img1.mmd) — render tại https://mermaid.live (máy chưa cài draw.io CLI nên chưa sinh được SVG)

## 8. Luồng thay thế (Alternative Flows)

### 8.1 Mất mạng khi đã đăng nhập
- Kích hoạt: app không gọi được server, `auth_session` còn hạn
- Luồng: hiện dải thông báo "Đang ngoại tuyến"; toàn bộ chức năng chạy SOP, xem lịch sử, xuất báo cáo ra máy **vẫn hoạt động**; các nút cần mạng (gửi báo cáo, quản lý tài khoản, hộp thư) bị vô hiệu kèm tooltip
- Kết quả: người dùng hoàn tất SOP và có file HTML trong tay, gửi lại sau khi có mạng

### 8.2 Mất mạng khi chưa đăng nhập
- Kích hoạt: `auth_session` không có hoặc đã hết hạn, không gọi được server
- Luồng: màn hình đăng nhập hiện thông báo không kết nối được; không có đường vòng
- Kết quả: **không dùng được app** — đúng quyết định của PM (clarify §1.1)

### 8.3 Gửi lại báo cáo của một run đã gửi
- Kích hoạt: người dùng mở History, chọn run đã có `shared_at`, bấm gửi lại
- Luồng: xuất file mới với timestamp mới → upload → tạo bản ghi `reports` mới → cập nhật `shared_report_id`, `shared_at`
- Kết quả: hai bản ghi cùng `run_id` tồn tại song song (BR-30), bản cũ vẫn xem được bằng link cũ

### 8.4 Admin đặt lại mật khẩu cho member
- Kích hoạt: member báo quên mật khẩu
- Luồng: admin mở màn hình quản lý tài khoản → đặt mật khẩu mới → server cập nhật `password_hash`, đặt `must_change_password = 1`, **revoke toàn bộ session** của user đó
- Kết quả: member đang đăng nhập ở máy khác bị đăng xuất ở lần gọi API kế tiếp; đăng nhập lại bằng mật khẩu mới và bị buộc đổi

### 8.5 Admin quên mật khẩu
- Kích hoạt: không còn admin nào đăng nhập được
- Luồng: người phụ trách server cập nhật `users.password_hash` trực tiếp trong MySQL bằng hash Argon2id sinh sẵn, rồi `UPDATE sessions SET revoked_at = NOW() WHERE user_id = ?`
- Kết quả: khôi phục được quyền admin. **Đây là thao tác thủ công ngoài ứng dụng, cần ghi thành quy trình vận hành có người chịu trách nhiệm** (Q9)

### 8.6 Upload thất bại giữa chừng
- Kích hoạt: đứt mạng hoặc server lỗi trong lúc upload
- Luồng: file HTML **đã nằm sẵn trên máy** (D4); app báo lỗi và cho thử lại; không ghi `shared_report_id`
- Kết quả: không mất dữ liệu, không tạo bản ghi rác trên server

## 9. Luồng lỗi (Exception Flows)
- Lỗi xác thực và phân quyền: đã mô tả ở §5.2
- Token hết hạn giữa phiên làm việc: lệnh API kế tiếp trả `401 UNAUTHENTICATED` → app xóa `auth_session`, chuyển về màn hình đăng nhập, **run đang chạy dở không bị hủy** (dữ liệu ở local)
- Token hết hạn khi đang ngoại tuyến: không gia hạn được, app rơi về luồng 8.2 ở lần mở kế tiếp
- Người nhận bị vô hiệu hóa sau khi đã nhận báo cáo: bản ghi `report_recipients` giữ nguyên; người đó không đăng nhập được nên không xem được (Q7)

## 10. Business Rules

- **BR-16**: Every endpoint requires a valid, non-revoked, non-expired session, except the four sign-in paths: `POST /api/v1/auth/login`, `GET /login`, `POST /login`, and `POST /logout` (which tolerates a missing cookie so that signing out never errors).
- **BR-17**: Only `role = 'admin'` may create accounts, reset another user's password, change a role, or toggle `is_active`. Enforced server-side; hiding the button in the app is not sufficient.
- **BR-18**: A report is readable only by its sender, its recipients, and any admin. Enforced in the server on every read path, including `/r/{id}`.
- **BR-19**: A session token is valid for 30 days from issue. There is no sliding renewal and no refresh token.
- **BR-20**: `procedures`, `steps`, `runs` and `step_executions` never leave the local database. The server stores accounts and finished report files only.
- **BR-21**: While a valid local session exists, every offline-capable feature keeps working without the network: running an SOP, capturing evidence, confirming steps, exporting a report to disk, browsing local history.
- **BR-22**: `export_report` always writes the HTML file to the local disk before any upload is attempted. An upload failure never costs the user the report.
- **BR-23**: The operator name recorded at `start_run` is the `display_name` of the signed-in account. It is no longer free text. This supersedes the Settings field described in `sop-widget.md` §5.2.
- **BR-24**: Passwords are stored as Argon2id hashes. SHA-256 is used only for evidence and file integrity, never for passwords.
- **BR-25**: An uploaded report file is immutable. Correcting a report means sharing a new one.
- **BR-26**: Resetting a password revokes every session belonging to that user.
- **BR-27**: The server stores only the SHA-256 hash of a session token. A leaked database does not yield usable tokens.
- **BR-28**: `users` rows are never deleted. Disabling an account sets `is_active = 0`, mirroring the `archived` pattern already used for `procedures` and `steps`.
- **BR-29**: The sender is always excluded from `recipient_ids`; a user cannot send a report to themselves. They retain access as the sender.
- **BR-30**: The same `run_id` may be shared more than once. Each share creates an independent `reports` row and share link; earlier links stay valid.
- **BR-31**: A request for a report the caller may not read returns `404`, never `403`, so report ids cannot be enumerated.
- **BR-32**: `runs.operator_name` on runs created before this feature stays NULL and keeps rendering as `(chưa đặt tên)`. No backfill.

BR-01 … BR-14 of `sop-widget.md` (v1.3) remain in force unchanged. **BR-15 is superseded by BR-23.**

## 11. State Machine

### 11.1 `sessions`

| Trạng thái | Event | Trạng thái tiếp theo | Điều kiện |
|---|---|---|---|
| — | `POST /auth/login` thành công | `active` | Tài khoản `is_active = 1` |
| `active` | `POST /auth/logout` (app) hoặc `POST /logout` (web) | `revoked` | Chỉ thu hồi đúng phiên gọi lệnh, không ảnh hưởng phiên của kênh còn lại |
| `active` | Chính user đổi mật khẩu qua `POST /auth/password` | `revoked` | Áp dụng cho mọi phiên khác của user đó, giữ lại phiên đang gọi |
| `active` | Admin vô hiệu hóa tài khoản (`PATCH /users/{id}`) | `revoked` | Toàn bộ phiên của user đó |
| `active` | Admin đặt lại mật khẩu của user đó | `revoked` | BR-26 |
| `active` | Quá `expires_at` | `expired` | Tự động, không cần job |
| `revoked` / `expired` | — | — | Trạng thái cuối, không hồi phục |

### 11.2 `report_recipients.first_viewed_at`

| Trạng thái | Event | Trạng thái tiếp theo |
|---|---|---|
| `NULL` (chưa xem) | Lần đầu gọi `/content` hoặc `/r/{id}` thành công | Ghi thời điểm |
| Đã có giá trị | Xem lại | Không đổi |

`runs.status` giữ nguyên state machine của `sop-widget.md` §11 — không đổi.

## 12. Security & Authorization

- **Authentication**: required for the whole application. The app is unusable without a valid session (clarify §1.1).
- **Authorization**: two roles. Admin ⊃ Member. Report access is per-object, not per-role (BR-18).
- **Transport**: the target server currently runs **plain `http://` on a public IP**. Passwords, session tokens and report files — which may embed screenshots containing credentials, tokens or customer data (`sop-widget.md` §12) — would travel unencrypted. **HTTPS, or restricting the server to a VPN, is a mandatory precondition for deployment.** Acceptable only while the stack runs on Docker locally.
- **Password storage**: Argon2id, per-user salt, parameters documented in the server README.
- **Token handling**: opaque 256-bit random tokens, stored hashed (BR-27), sent as `Authorization: Bearer <ACCESS_TOKEN>` from the app and as an `HttpOnly; SameSite=Lax` cookie for the web viewer.
- **Rate limiting**: both sign-in paths — `POST /api/v1/auth/login` and `POST /login` — are limited per IP and per username against a **shared** counter, so the two channels cannot be alternated to double the allowance (provisional: 10 attempts / 15 minutes — Q4). Other endpoints: 120 requests / minute per session.
- **Input validation**: parameterised SQL everywhere on both sides; `username` restricted to `^[a-z0-9._-]+$`; uploaded files accepted only as `text/html` within the size limit.
- **Stored HTML is served, never trusted**: the file is user-generated content. It must be served with `Content-Disposition` and a restrictive `Content-Security-Policy`, from a path that cannot execute scripts against the API origin — otherwise a hand-edited report becomes stored XSS against every viewer. See Q6.
- **Sensitive data**: report files are the sensitive asset. Evidence screenshots are not scanned or masked — that limitation from `sop-widget.md` §12 now applies to data leaving the machine.
- **Tamper resistance**: unchanged and still weak. `evidence_hash` sits inside the very file the operator can edit before uploading. The server records its own `sha256` at upload time, which proves only that the file has not changed **since** upload, not that its contents are truthful.
- **Account enumeration**: prevented by uniform `401` on login and `404` on unauthorised report reads (BR-31).

## 13. Integration Contract (Frontend)

- **Session storage**: the token lives in the local SQLite `auth_session` table, not in `localStorage`. The frontend never holds the raw token; it calls Tauri commands which attach the header.
- **Startup**: call `current_session` before rendering. NULL or expired → login view. This is the only navigation decision made before the first paint.
- **Token lifecycle**: 30 days, no refresh. `must_change_password = 1` → force the change-password view before anything else.
- **On `401`**: clear `auth_session`, return to the login view, keep any local run intact, show `Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.`
- **Offline detection**: a failed API call, not a heartbeat. Show a persistent offline banner and disable the network-dependent buttons; never block the SOP runner.
- **Retry**: only the report upload is retryable, manually, by the user. Login and account operations are not retried automatically.
- **Loading states**: the existing shared `busy` flag (`App.tsx:26`) covers login, member listing, upload and download.
- **No optimistic updates**: a report is shown as sent only after `201`.
- **New views** added to the `View` union (`App.tsx:6`): `'login'`, `'inbox'`, `'accounts'`. No router, no state manager — consistent with the current structure.

## 14. Audit & Logging

| Event | Level | Destination | Fields |
|---|---|---|---|
| Login success | INFO | server log | `user_id`, `ip`, `client`, `timestamp` |
| Login failure | WARN | server log | `username`, `ip`, `reason`, `timestamp` |
| Logout | INFO | server log | `user_id`, `session_id` |
| Account created | INFO | server log | `actor_user_id`, `target_user_id`, `role` |
| Password reset by admin | WARN | server log | `actor_user_id`, `target_user_id`, sessions revoked count |
| Account activated / deactivated | WARN | server log | `actor_user_id`, `target_user_id`, `is_active` |
| Report uploaded | INFO | server log + `reports` row | `report_id`, `sender_id`, `recipient_ids`, `size_bytes` |
| Report viewed / downloaded | INFO | server log + `report_recipients.first_viewed_at` | `report_id`, `user_id`, `ip` |
| Forbidden access attempt | WARN | server log | `user_id`, `report_id`, `path` |

Passwords and raw tokens are never written to any log. Retention: see Q8.

## 15. Non-functional Requirements

- **Performance targets** (to verify, not measured): login responds within 1 s; the member list within 500 ms for 100 accounts; a 13 MB upload completes within 60 s on a 10 Mbps link. Report viewing streams from disk rather than buffering the file in memory.
- **Upload size**: a run with 5 evidence images produces 3–13 MB of HTML (`sop-widget.md` §15). Provisional cap 25 MB (Q5). No compression or downscaling is applied — that remains an open item from Q1 of the v1.1 spec.
- **Storage growth**: at 10 MB per report and 20 reports a week, the server accumulates roughly 10 GB a year. A retention policy and a backup owner are required before real use (Q8).
- **Availability**: the server is a single point of failure for signing in and sharing, but not for running an SOP (BR-21). Server downtime degrades the product to its Phase 1 behaviour for anyone already signed in.
- **Scalability**: designed for a team of tens of users, not hundreds. No horizontal scaling, no CDN.
- **Backward compatibility**: existing local databases keep working. The three new `runs` columns are added with `ALTER TABLE ADD COLUMN` and default NULL; old runs remain viewable and exportable. `procedures`, `steps`, `step_executions` are untouched.
- **Accessibility**: unchanged and still unaddressed.

## 16. Edge Cases

### Security
- [ ] Brute force on login — rate limited per IP and per username (Q4)
- [ ] Stolen local database file — yields a usable 30-day token; mitigated only by the machine's own OS account
- [ ] Report id guessing — `404` for non-participants (BR-31)
- [ ] Hand-edited HTML uploaded as a report — accepted by design; served with CSP so it cannot attack viewers (Q6)
- [ ] Admin demoting or disabling themselves — must be rejected while they are the last active admin
- [ ] Privilege escalation via `PATCH /users/{id}` with `role` — admin-only, and the check must not rely on the request body

### Timing & State
- [ ] Token expires mid-upload — upload fails, local file survives (BR-22)
- [ ] Token expires while a run is in progress — run continues, sharing is blocked
- [ ] Admin resets a password while that user is uploading — the request fails with `401` (BR-26)
- [ ] Same report submitted twice by a double click — two `reports` rows unless the app disables the button via `busy`
- [ ] Clock skew between machine and server — `expires_at` is evaluated server-side, so a wrong local clock only affects the pre-flight check

### Data Integrity
- [ ] Recipient list containing the sender — silently removed (BR-29)
- [ ] Recipient deactivated between picking and submitting — `404 RECIPIENT_NOT_FOUND`
- [ ] Report row written but the file write fails — the upload is rejected and the row rolled back; no orphan metadata
- [ ] File on disk without a `reports` row — orphan cleanup job needed (Q10)
- [ ] Local run deleted or database reset after sharing — the server copy is unaffected and stays viewable

### Concurrency
- [ ] Same user signed in on two machines — allowed; two independent sessions (Q3)
- [ ] Two admins creating the same username — resolved by the UNIQUE constraint, surfaced as `409`
- [ ] Two uploads of the same run at once — both succeed, two reports (BR-30)

### External Dependencies
- [ ] Server unreachable — offline mode (8.1 / 8.2)
- [ ] Server disk full — `507 STORAGE_FULL`, local file retained
- [ ] MySQL connection lost mid-request — `500`, no partial write thanks to the transaction
- [ ] Reverse proxy body-size limit lower than the app's cap — must be aligned during deployment, otherwise uploads fail with a proxy error the app cannot explain

## 17. Test Scenarios

### Happy Path
1. Admin đăng nhập bằng tài khoản seed → tạo 2 member → cả 2 đăng nhập được trên 2 máy khác nhau
2. Member A chạy trọn 1 SOP có ảnh bằng chứng → gửi báo cáo cho member B → B mở app, thấy trong hộp thư, tải về, mở file thấy đủ ảnh và **tên người thực hiện là A**

### Edge Cases
1. Đăng nhập sai mật khẩu 10 lần → lần 11 bị chặn bởi rate limit, message đúng
2. Rút mạng khi đã đăng nhập → chạy trọn 1 SOP, chụp ảnh, xuất báo cáo ra máy đều thành công; nút gửi bị vô hiệu
3. Rút mạng khi chưa đăng nhập → không vào được app, hiện đúng thông báo
4. Gửi báo cáo trong lúc rút mạng giữa chừng → báo lỗi, file HTML vẫn nằm ở `%APPDATA%\NTA\SOP Widget\reports`, không tạo bản ghi trên server
5. Member C (không phải người gửi, không phải người nhận) gọi `GET /api/v1/reports/{id}/content` bằng token của mình → nhận `404`
6. Member C mở link `/r/{id}` sau khi đã đăng nhập web → nhận `404`
7. Admin đặt lại mật khẩu của member B khi B đang đăng nhập ở máy khác → thao tác kế tiếp của B trả `401`, B phải đăng nhập lại và bị buộc đổi mật khẩu
8. Gửi cùng một run 2 lần → 2 link khác nhau, cả 2 đều mở được
9. Upload file 30 MB (vượt cap) → `413`, message tiếng Việt đúng, không có file rác trên server
10. Run cũ tạo trước tính năng này (`operator_name` NULL) → vẫn xuất báo cáo được, in `(chưa đặt tên)`, vẫn gửi được
11. Token hết hạn (chỉnh `expires_at` về quá khứ trong DB) → mở app rơi về màn hình đăng nhập, dữ liệu local nguyên vẹn
12. Vô hiệu hóa tài khoản đang đăng nhập → thao tác kế tiếp trả `403 ACCOUNT_DISABLED`
13. Mở link `/r/{id}` trên trình duyệt chưa đăng nhập → chuyển tới `/login?next=/r/{id}` → đăng nhập → **quay lại đúng báo cáo đó**, không rơi về trang chủ
14. Đã đăng nhập trong app rồi mở link trên trình duyệt → vẫn phải đăng nhập một lần trên web (2 phiên độc lập)
15. Đăng xuất trên trình duyệt → phiên trong app **vẫn dùng được**; và ngược lại
16. Admin đặt lại mật khẩu → **cả** phiên app lẫn phiên web của user đó đều mất hiệu lực
17. Vô hiệu hóa admin cuối cùng, hoặc admin cuối cùng tự hạ quyền mình → `409 LAST_ADMIN`, không thực hiện
18. Đổi mật khẩu của chính mình → các phiên khác bị thu hồi, phiên đang thao tác vẫn dùng được
19. Inbox có 120 báo cáo → phân trang trả đúng `limit` mặc định 50 và `next_cursor` dùng được cho trang kế
20. Gửi báo cáo chỉ chọn **chính mình** làm người nhận → `400 NO_RECIPIENT`, không tạo bản ghi nào
21. Gửi báo cáo với danh sách người nhận có id trùng lặp → trùng bị loại âm thầm, mỗi người nhận đúng 1 bản ghi `report_recipients`, không báo lỗi
22. Đặt timezone của máy chủ lệch UTC rồi tạo phiên mới → `expires_at` vẫn đúng 30 ngày tính theo UTC, không lệch theo giờ máy

### Security Tests
1. Gọi mọi endpoint không kèm token → `401` toàn bộ, không endpoint nào lọt
2. Member gọi `POST /api/v1/users` → `403`, không tạo được tài khoản
3. Member gọi `PATCH /api/v1/users/{id}` đổi `role` của chính mình thành `admin` → `403`
4. Đăng nhập với username không tồn tại và với username tồn tại nhưng sai mật khẩu → response **giống hệt nhau** về cả mã lỗi lẫn thời gian phản hồi
5. Upload file HTML có `<script>` gọi API → mở bằng link chia sẻ, xác nhận CSP chặn, script không chạy được với quyền của người xem
6. Đọc DB server → xác nhận không có mật khẩu thô và không có token thô (BR-24, BR-27)
7. Bắt gói tin trên HTTP → **xác nhận đọc được mật khẩu**; đây là bằng chứng cho yêu cầu HTTPS ở §12, không phải test fail
8. `GET /login?next=https://evil.example` và `next=//evil.example` → tham số bị bỏ, sau khi đăng nhập chuyển về `/`, **không** chuyển ra ngoài (chống open redirect)
9. Đăng nhập sai liên tiếp xen kẽ giữa `POST /login` (web) và `POST /api/v1/auth/login` (app) → tổng số lần tính chung, không nhân đôi hạn mức
10. Đọc cookie bằng JavaScript trên trang báo cáo → không đọc được (`HttpOnly`)

### Performance Tests
1. 100 tài khoản → đo thời gian trả `GET /api/v1/users`
2. Upload báo cáo 13 MB trên mạng 10 Mbps → đo tổng thời gian, xác nhận không timeout ở cả app lẫn reverse proxy

## 18. Open Questions

### 18.1 Đã có giá trị trong code — cần PM xác nhận, không chặn `[v1.3]`

Những câu này ban đầu để mở, nhưng implement không thể chờ nên **đã chọn một giá trị và đưa vào code**. Đây là quyết định của Dev, chưa phải quyết định của PM. Mỗi giá trị đặt ở một chỗ duy nhất để đổi lại không phải sửa nhiều nơi.

| # | Câu hỏi | Giá trị đang dùng | Đặt ở đâu |
|---|---|---|---|
| Q1 | Đăng nhập bằng `username` hay email? | `username` — không có hạ tầng email, admin tạo tài khoản thủ công | `users.username` |
| Q2 | Yêu cầu độ mạnh mật khẩu? | ≥ 8 ký tự, không kiểm tra độ phức tạp | `MIN_PASSWORD_LENGTH` trong `server/src/auth/routes.ts` |
| Q4 | Ngưỡng rate limit khi đăng nhập sai? | 10 lần / 15 phút, tính chung theo IP **và** theo username | `LOGIN_RATE_LIMIT`, `LOGIN_RATE_WINDOW_MINUTES` trong `server/.env` |
| Q5 | Giới hạn dung lượng báo cáo? | 25 MB | `MAX_UPLOAD_MB` trong `server/.env` |
| Q6 | Chính sách phục vụ file HTML do người dùng tạo? | `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; …` + `Content-Disposition: attachment` cho `/content`. Chặn script, chặn mọi kết nối ra ngoài, chặn nhúng vào khung trang khác | `REPORT_CSP` trong `server/src/reports/routes.ts` |
| Q13 | Địa chỉ máy chủ lấy từ đâu? | **Không hardcode, cũng không cho nhập** — 3 tầng cấu hình, xem §4.4 | `configured_server_url()` trong `src-tauri/src/lib.rs` |
| Q15 | `must_change_password` có chặn ở server không? | **Có** — mọi endpoint trừ `/auth/me`, `/auth/password`, `/auth/logout` trả `403 PASSWORD_CHANGE_REQUIRED` | `requireAuth()` trong `server/src/auth/guard.ts` |
| Q18 | Recipient có thấy danh sách người nhận khác? | **Không** — chỉ sender và admin thấy `recipients`; recipient chỉ thấy mốc xem của chính mình | `reportDetail()` trong `server/src/reports/service.ts` |

### 18.2 Còn mở thật — chưa có câu trả lời và chưa có gì trong code

- [ ] **Q3**: Cho phép một tài khoản đăng nhập đồng thời nhiều máy không? Hiện cho phép. Đăng xuất ở một máy có thu hồi hết không? (hiện: không) → Hỏi [PM]
- [ ] **Q7**: Member nghỉ việc: vô hiệu hóa tài khoản thì báo cáo đã gửi cho họ xử lý sao? Admin có kế thừa quyền xem không? → Hỏi [PM]
- [ ] **Q8**: Báo cáo trên server giữ bao lâu, ai backup, ai theo dõi dung lượng đĩa? → Hỏi [PM + người phụ trách server]
- [ ] **Q9**: Tên người phụ trách server và SLA khôi phục mật khẩu admin? → Hỏi [PM]
- [ ] **Q10**: Có cần job dọn file orphan trên server, và dọn `sessions` quá hạn, không? → Hỏi [Dev]
- [ ] **Q11**: Quyền tạo/sửa/xóa quy trình SOP có cần phân biệt admin/member không, hay giữ là quyền local của mọi người? (hiện giữ như v1.1) → Hỏi [PM]
- [ ] **Q12**: Có cần thông báo trong app khi có báo cáo mới không, hay người nhận tự vào hộp thư kiểm tra? (hiện là tự kiểm tra) → Hỏi [PM]
- [ ] **Q14**: Logout khi đang có run `running` — cho phép, chặn, hay cảnh báo? (hiện cho phép, run giữ nguyên vì ở local) → Hỏi [PM]
- [ ] **Q16** `[v1.3]`: Token thô nằm trong `auth_session` của SQLite local, không mã hóa, hạn 30 ngày. Chấp nhận rủi ro này, hay rút ngắn hạn token? → Hỏi [PM]

### 18.3 Chức năng đã đặc tả nhưng chưa implement `[v1.3]`

Không phải câu hỏi, mà là việc còn lại — ghi ở đây để không bị lẫn với phần đã xong:
`list_sent`, `download_report`, `reset_member_password`, `set_member_active` (xem §5.3), phân trang phía app cho hộp thư, và toàn bộ 4 file trong `docs/diagram/` vẫn đang là kiến trúc offline của Phase 1.

## 19. Dependencies & Impact

- **Phụ thuộc vào**: `sop-widget.md` v1.3 (toàn bộ luồng chạy SOP và xuất báo cáo giữ nguyên)
- **Ảnh hưởng đến**: `export_report`, `start_run`, Settings, History, và toàn bộ điều hướng của app
- **Dependency đã dùng thực tế** `[v1.3]` (đã được duyệt theo quy tắc project #7):
  - App: crate `reqwest 0.12` với `default-features = false`, features `json`, `multipart`, `rustls-tls`.
    Chọn `rustls` thay `native-tls` để không phụ thuộc OpenSSL khi build trên Windows.
    **Không** dùng `@tauri-apps/plugin-http` — gọi HTTP từ Rust để token thô không phải đi lên frontend (§13)
  - Server: `fastify`, `@fastify/cookie`, `@fastify/multipart`, `@fastify/rate-limit`, `mysql2`,
    `@node-rs/argon2`, `dotenv`; dev: `typescript`, `tsx`, `vitest`, `@types/node`.
    Dùng `@node-rs/argon2` thay `argon2` vì có binary dựng sẵn, không cần C++ build tools.
    **Không** thêm `@fastify/formbody` — parser `application/x-www-form-urlencoded` tự viết bằng
    `URLSearchParams` trong `src/app.ts`, chỉ phục vụ một endpoint
  - Hạ tầng dev: Docker + Docker Compose (MySQL + api)
- **Permission** `[v1.3 — sửa]`: **không cần** thêm permission network vào
  `src-tauri/capabilities/default.json`. Permission của Tauri chỉ áp cho API gọi từ JS; ở đây
  HTTP do Rust gọi bằng `reqwest` nên không đi qua lớp permission đó. v1.2 dự đoán sai điểm này.
- **Migration cần thiết**: YES
  - Local: 3 câu `ALTER TABLE runs ADD COLUMN` (`operator_user_id`, `shared_report_id`, `shared_at`) + `CREATE TABLE IF NOT EXISTS auth_session`
  - Server: schema mới hoàn toàn + seed 1 tài khoản admin. Migration chạy qua `server/db/migrate.ts`,
    ghi tên file đã chạy vào bảng `schema_migrations` nên gọi lại nhiều lần là an toàn
- **Breaking change**: YES — app không dùng được nếu chưa đăng nhập. Người dùng hiện tại sau khi cập nhật **phải có tài khoản mới mở được app**. Dữ liệu local không mất gì.
- **Tài liệu phải cập nhật cùng lúc**: `CLAUDE.md` (đã làm — Tech Stack, cấu trúc thư mục, convention boundary HTTP, DB conventions cho MySQL, test conventions), `.gitignore` (đã làm — `.env`, `server/storage/`), 4 file trong `docs/diagram/` (**chưa làm**)

## 20. Change Log

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.3 | 2026-08-14 | Dev | **Đồng bộ spec với code sau khi implement.** §4.2: `storage_path` lưu tương đối kèm chặn path traversal, ghi nhận bảng phụ `schema_migrations`. §4.3: thêm cột `auth_session.must_change_password`. **§4.4 mới**: cơ chế 3 tầng cấu hình địa chỉ máy chủ (env var → `server.env` tự sinh → mặc định) — **đảo Q13**, không hardcode cũng không cho người dùng nhập. §5.1: thêm `GET /healthz`, sửa cột Auth của `POST /logout` thành optional. §5.2: thêm `403 PASSWORD_CHANGE_REQUIRED` và ghi chú phân biệt hai loại 401. §5.3: viết lại bảng command — thêm cột **Status** đánh dấu 10 command đã làm / 4 chưa làm, sửa chữ ký `login` (bỏ `serverUrl`), thêm `server_url` và `open_report_link` kèm lý do chỉ nhận `report_id`, ghi lại ràng buộc `rusqlite::Connection` không `Send`. §18: tách thành 18.1 (8 câu đã có giá trị trong code, kèm nơi đặt giá trị), 18.2 (8 câu còn mở thật, thêm Q16 về token thô trong SQLite), 18.3 (việc chưa implement). §19: cập nhật dependency thực tế, **sửa nhận định sai của v1.2** về permission network, ghi rõ migration qua `schema_migrations` |
| 1.0 | 2026-08-14 | Dev | Bản đầu, soạn từ `docs/clarify/clarify_login-report-sharing.md` v1.0 sau 5 vòng clarify với PM |
| 1.2 | 2026-08-14 | Dev | Fix 5 warning ưu tiên từ lần review thứ hai: §5.2b làm rõ `first_viewed_at` chỉ ghi khi người xem là recipient (sender/admin không có row trong `report_recipients`); §5.3 thêm command `list_sent` và cho `list_inbox`/`list_sent` nhận `limit`/`cursor` khớp API, định nghĩa `ReportPage`; §5.2 thêm thứ tự validate `recipient_ids` 4 bước (loại trùng → loại sender → kiểm rỗng → kiểm tồn tại/active), làm rõ `NO_RECIPIENT` bao gồm trường hợp chỉ chọn chính mình; §4.2 quy định toàn bộ thời gian lưu UTC và `TZ=UTC` cho cả DB lẫn backend; thêm 4 test scenario tương ứng |
| 1.1 | 2026-08-14 | Dev | Fix 2 blocker từ `/nta-spec-review`. **Blocker 1**: bổ sung luồng đăng nhập web — thêm `POST /login`, `POST /logout`, §5.2b đặc tả 4 endpoint web, quy tắc 2 kênh xác thực độc lập (Bearer cho app, cookie cho trình duyệt), chống open redirect ở tham số `next`, rate limit dùng chung với API. **Blocker 2**: bổ sung request/response schema cho 11 endpoint còn thiếu (`/auth/logout`, `/auth/me`, `/auth/password`, `GET /users` hai biến thể theo role, `PATCH /users/{id}`, `/users/{id}/password-reset`, `/reports/inbox`, `/reports/sent`, `GET /reports/{id}`, và 4 endpoint web). Kèm theo: thêm phân trang cursor cho `inbox`/`sent` (warning #1), thêm lỗi `409 LAST_ADMIN`, mở rộng state machine phiên ở §11.1, thêm 7 test edge case và 3 security test cho luồng web |

---

## 21. Tóm tắt xác nhận *(nội bộ — xóa trước khi gửi khách hàng)*

**Tính năng:** Đăng nhập bằng tài khoản trên server + gửi báo cáo SOP cho đồng nghiệp

**Mục đích:** Báo cáo mang đúng danh tính người thực hiện (không còn tự gõ tên), và người nhận xem được ngay trong app hoặc qua link, thay cho việc gửi file thủ công

**Cần team xác nhận:**
- [ ] **BR-23** thay thế BR-15: bỏ ô "Tên người thực hiện" tự nhập, lấy từ tài khoản đăng nhập
- [ ] **BR-19**: token 30 ngày, không gia hạn tự động — hết hạn khi đang ngoại tuyến thì không vào được app
- [ ] **BR-21 + luồng 8.2**: chưa đăng nhập mà mất mạng thì **không dùng được app**
- [ ] **Breaking change**: người dùng hiện tại phải có tài khoản mới mở được app sau khi cập nhật
- [ ] **§12 Transport**: HTTPS hoặc VPN là điều kiện bắt buộc trước khi deploy lên `54.178.76.191`
- [ ] **Q6**: chính sách phục vụ file HTML người dùng tạo (nguy cơ stored XSS nếu render inline không có CSP)
- [ ] Q1–Q14 ở §18 chưa có câu trả lời

**Ảnh hưởng phần khác:** `export_report`, `start_run`, Settings, History, điều hướng app; `sop-widget.md` phải lên v1.2; `CLAUDE.md`, `.gitignore`, 4 diagram phải cập nhật

**Không nằm trong scope lần này:**
- Đồng bộ quy trình SOP giữa các máy — mỗi máy vẫn giữ bản riêng
- Đồng bộ ảnh bằng chứng gốc lên server (chỉ file HTML đã nhúng base64)
- Thông báo đẩy khi có báo cáo mới (Q12)
- Chống can thiệp mức B/C/D — báo cáo vẫn không đáng tin với bên thứ ba
- Snapshot step theo từng run (vẫn là hạn chế đã biết từ v1.1)
- Đổi mật khẩu tự phục vụ khi quên (phải qua admin)

---

## 22. Đồng bộ với `sop-widget.md` — đã hoàn tất

Spec này không thay thế spec cũ. Toàn bộ 9 mục dưới đây **đã được sửa** trong `sop-widget.md`:
v1.2 làm 8 mục, v1.3 làm mục §5.2 (v1.2 sửa nhưng sửa sai — xem cột ghi chú).

| Mục | Nội dung cũ | Đã sửa thành | Ở bản |
|---|---|---|---|
| §1 Tổng quan | "chạy offline" | Nêu rõ phụ thuộc server cho đăng nhập và chia sẻ | v1.2 ✅ |
| §3 Actors | *"App không có cơ chế đăng nhập hay phân quyền"* | Trỏ sang spec này; bổ sung Admin / Member | v1.2 ✅ |
| §5.2 `start_run` | `operatorName` lấy từ Settings (`localStorage`) | **Bỏ hẳn tham số `operatorName`** | v1.3 ✅ — v1.2 ghi "chữ ký không đổi", sai |
| §6 Preconditions | "đã điền tên trong Settings" | "đã đăng nhập" | v1.2 ✅ |
| §10 BR-15 | Tên chốt tại `start_run` từ Settings | Được BR-23 thay thế | v1.2 ✅ |
| §12 Security | *"Authentication: not required"*, *"Authorization: none"* | Viết lại theo §12 của spec này, thêm mục Data in transit | v1.2 ✅ |
| §15 | *"fully offline, no external dependency"* | Tách rõ phần offline và phần cần server (BR-21) | v1.2 ✅ |
| §18 Q1 | Ngưỡng kích thước báo cáo — chưa cấp thiết | Nâng ưu tiên: file nay phải đi qua mạng | v1.2 ✅ |
| §21 | *"Định danh người dùng tập trung"* nằm ngoài scope | Chuyển vào scope Phase 2, ghi ngày và owner là PM | v1.2 ✅ |

Còn lại **chưa đồng bộ**: 4 file trong `docs/diagram/` vẫn mô tả kiến trúc offline của Phase 1 — không có đăng nhập, không có server, không có luồng gửi/nhận báo cáo.
