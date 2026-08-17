use base64::Engine as _;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, path::PathBuf};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Step { id: i64, procedure_id: i64, order_index: i64, title: String, description: String, command: Option<String>, requires_evidence: bool }
#[derive(Debug, Serialize, Deserialize, Clone)]
struct Procedure { id: i64, name: String, description: String, category: Option<String>, created_at: String, updated_at: String, steps: Vec<Step> }
#[derive(Debug, Deserialize)]
struct StepInput { id: Option<i64>, title: String, description: String, command: Option<String>, requires_evidence: bool }
#[derive(Debug, Deserialize)]
struct ProcedureInput { id: Option<i64>, name: String, description: String, category: Option<String>, steps: Vec<StepInput> }
#[derive(Debug, Serialize, Clone)]
struct Run { id: String, procedure_id: i64, status: String, started_at: String, completed_at: Option<String>, operator_name: Option<String>, procedure_name: Option<String>, confirmed_count: Option<i64>, evidence_count: Option<i64> }
#[derive(Debug, Serialize)]
struct Execution { id: i64, run_id: String, step_id: i64, confirmed_at: Option<String>, notes: Option<String>, evidence_path: Option<String>, captured_at: Option<String>, evidence_hash: Option<String> }
#[derive(Debug, Serialize)]
struct RunDetails { run: Run, procedure: Procedure, executions: Vec<Execution> }

// Phiên đăng nhập trả cho frontend. Cố ý KHÔNG có `token`: chỉ phía Rust giữ token thô và
// tự gắn header, đúng §13 của docs/spec/login-report-sharing.md.
#[derive(Debug, Serialize, Clone)]
struct AuthSession { user_id: i64, username: String, display_name: String, role: String, expires_at: String, server_url: String, must_change_password: bool }
// Phiên đầy đủ dùng nội bộ, có token để gọi API.
struct StoredSession { session: AuthSession, token: String }
#[derive(Debug, Serialize, Clone)]
struct Member { id: i64, username: String, display_name: String, role: String, is_active: bool, must_change_password: bool }
// Người nhận trong bộ chọn. Server trả cho member đúng hai field này, cho admin trả nhiều hơn —
// ở đây chỉ lấy phần dùng chung để một kiểu chạy được cho cả hai vai.
#[derive(Debug, Serialize, Clone)]
struct Recipient { id: i64, display_name: String }
#[derive(Debug, Serialize, Clone)]
struct SharedReport { report_id: String, share_url: String, local_path: String, size_bytes: u64, recipients: Vec<Recipient> }
#[derive(Debug, Serialize, Clone)]
struct InboxItem { report_id: String, run_id: String, procedure_name: String, operator_display_name: String, sender_display_name: String, run_status: String, created_at: String, size_bytes: u64, first_viewed_at: Option<String>, share_url: String }

#[cfg(not(target_os = "windows"))]
fn home_dir() -> Result<PathBuf, String> { std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "Không xác định được thư mục người dùng (thiếu biến HOME).".to_string()) }
// Thư mục dữ liệu theo quy ước của từng hệ điều hành. Trên macOS KHÔNG được rơi về
// current_dir(): bundle .app mở từ Finder có thư mục làm việc là `/`, ghi vào đó sẽ bị chặn.
fn app_dir() -> Result<PathBuf, String> {
  #[cfg(target_os = "windows")]
  let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
  #[cfg(target_os = "macos")]
  let base = home_dir()?.join("Library").join("Application Support");
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  let base = home_dir()?.join(".local").join("share");
  let dir = base.join("NTA").join("SOP Widget");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}
fn db() -> Result<Connection, String> {
  let conn = Connection::open(app_dir()?.join("sop-widget.db")).map_err(|e| e.to_string())?;
  conn.execute_batch("PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS procedures (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS steps (id INTEGER PRIMARY KEY, procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE, order_index INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', command TEXT, requires_evidence INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, procedure_id INTEGER NOT NULL REFERENCES procedures(id), status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, operator_name TEXT);
    CREATE TABLE IF NOT EXISTS step_executions (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_id INTEGER NOT NULL REFERENCES steps(id), confirmed_at TEXT, notes TEXT, evidence_path TEXT, captured_at TEXT, evidence_hash TEXT, UNIQUE(run_id, step_id));
    CREATE TABLE IF NOT EXISTS auth_session (id INTEGER PRIMARY KEY CHECK (id = 1), user_id INTEGER NOT NULL, username TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL, expires_at TEXT NOT NULL, server_url TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  ").map_err(|e| e.to_string())?;
  let _ = conn.execute("ALTER TABLE procedures ADD COLUMN archived INTEGER NOT NULL DEFAULT 0", []);
  let _ = conn.execute("ALTER TABLE steps ADD COLUMN archived INTEGER NOT NULL DEFAULT 0", []);
  let _ = conn.execute("ALTER TABLE runs ADD COLUMN operator_name TEXT", []);
  let _ = conn.execute("ALTER TABLE step_executions ADD COLUMN evidence_hash TEXT", []);
  let _ = conn.execute("ALTER TABLE runs ADD COLUMN operator_user_id INTEGER", []);
  let _ = conn.execute("ALTER TABLE runs ADD COLUMN shared_report_id TEXT", []);
  let _ = conn.execute("ALTER TABLE runs ADD COLUMN shared_at TEXT", []);
  // BR-12: paused là giá trị cũ, trùng ngữ nghĩa với cancelled. Chuẩn hóa một chiều,
  // idempotent — sau lần đầu câu này khớp 0 row.
  conn.execute("UPDATE runs SET status='cancelled' WHERE status='paused'", []).map_err(|e| e.to_string())?;
  seed(&conn)?;
  Ok(conn)
}
// BR-13: run đã kết thúc không nhận thêm xác nhận hay bằng chứng.
fn run_status(conn: &Connection, run_id: &str) -> Result<String, String> {
  conn.query_row("SELECT status FROM runs WHERE id=?1", [run_id], |r| r.get(0)).map_err(|e| e.to_string())
}
fn sha256_file(path: &Path) -> Result<String, String> {
  let bytes = fs::read(path).map_err(|e| e.to_string())?;
  let mut hasher = Sha256::new();
  hasher.update(&bytes);
  Ok(format!("{:x}", hasher.finalize()))
}
fn now() -> String { Utc::now().to_rfc3339() }
fn seed(conn: &Connection) -> Result<(), String> {
  let count: i64 = conn.query_row("SELECT COUNT(*) FROM procedures", [], |r| r.get(0)).map_err(|e| e.to_string())?;
  if count != 0 { return Ok(()); }
  let samples = vec![
    ("Deploy Rails lên EC2", "Thực hiện triển khai Rails an toàn, có kiểm chứng từng bước.", "Deploy", vec![
      ("Pull code mới nhất", "Lấy code từ nhánh main về thư mục app trên server.", Some("git pull origin main"), false),
      ("Chạy migration", "Áp dụng thay đổi schema trước khi restart ứng dụng.", Some("RAILS_ENV=production bin/rails db:migrate"), true),
      ("Restart Puma", "Khởi động lại Puma để áp dụng code mới.", Some("sudo systemctl restart puma-app"), true),
      ("Kiểm tra và reload Nginx", "Test cấu hình trước khi reload Nginx.", Some("sudo nginx -t && sudo systemctl reload nginx"), true),
    ]),
    ("Backup Database trước thao tác rủi ro", "Tạo và xác nhận bản backup trước khi thực hiện thay đổi rủi ro.", "Backup", vec![
      ("Kiểm tra dung lượng ổ đĩa", "Đảm bảo còn đủ dung lượng trước khi tạo bản dump.", Some("df -h"), false),
      ("Dump database", "Tạo bản backup đầy đủ.", Some("mysqldump -u root -p app_production > backup_$(date +%F).sql"), true),
      ("Kiểm tra file backup", "Xác nhận file backup hợp lệ và không rỗng.", Some("ls -lh backup_*.sql"), true),
      ("Xác nhận sẵn sàng", "Đã có backup an toàn trước thao tác chính.", None, false),
    ]),
    ("Setup server mới trên EC2", "Thiết lập server Rails mới theo từng bước chuẩn hóa.", "Setup", vec![
      ("Cập nhật hệ thống", "Cập nhật danh sách gói và các gói hiện có.", Some("sudo apt update && sudo apt upgrade -y"), false),
      ("Cài rbenv và Ruby", "Cài đúng phiên bản Ruby theo Gemfile.", Some("rbenv install 3.2.2 && rbenv global 3.2.2"), false),
      ("Cài MariaDB", "Cài đặt và cấu hình bảo mật ban đầu.", Some("sudo apt install mariadb-server && sudo mysql_secure_installation"), true),
      ("Test end-to-end", "Xác minh app phản hồi đúng qua Nginx.", None, true),
    ]),
  ];
  for (name, description, category, steps) in samples {
    let stamp = now(); conn.execute("INSERT INTO procedures (name,description,category,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)", params![name,description,category,stamp]).map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    for (index, (title, description, command, requires)) in steps.iter().enumerate() { conn.execute("INSERT INTO steps (procedure_id,order_index,title,description,command,requires_evidence) VALUES (?1,?2,?3,?4,?5,?6)", params![id,index as i64,title,description,command,requires]).map_err(|e| e.to_string())?; }
  } Ok(())
}
fn procedure(conn: &Connection, id: i64) -> Result<Procedure, String> { procedure_scoped(conn, id, None, false) }
// Lần chạy đang diễn ra: bước đang dùng, cộng thêm bước đã archived nhưng đã thực hiện
// trong lần chạy đó. Lần chạy đã kết thúc (only_executed): chỉ bước thực sự đã thực hiện,
// để bước thêm mới sau này không lọt vào báo cáo cũ.
fn procedure_scoped(conn: &Connection, id: i64, run_id: Option<&str>, only_executed: bool) -> Result<Procedure, String> {
  let mut p = conn.query_row("SELECT id,name,description,category,created_at,updated_at FROM procedures WHERE id=?1", [id], |r| Ok(Procedure { id:r.get(0)?, name:r.get(1)?, description:r.get(2)?, category:r.get(3)?, created_at:r.get(4)?, updated_at:r.get(5)?, steps: vec![] })).map_err(|e| e.to_string())?;
  let executed = "id IN (SELECT step_id FROM step_executions WHERE run_id=?2)";
  let filter = if only_executed { executed.to_string() } else { format!("(archived=0 OR {executed})") };
  let mut statement = conn.prepare(&format!("SELECT id,procedure_id,order_index,title,description,command,requires_evidence FROM steps WHERE procedure_id=?1 AND {filter} ORDER BY order_index, id")).map_err(|e| e.to_string())?;
  p.steps = statement.query_map(params![id, run_id], |r| Ok(Step { id:r.get(0)?, procedure_id:r.get(1)?, order_index:r.get(2)?, title:r.get(3)?, description:r.get(4)?, command:r.get(5)?, requires_evidence:r.get(6)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?; Ok(p)
}

fn normalize_url(raw: &str) -> String { raw.trim().trim_end_matches('/').to_string() }
const DEFAULT_SERVER_URL: &str = "http://localhost:8080";
const SERVER_ENV_FILE: &str = "server.env";
fn parse_env_value(text: &str, key: &str) -> Option<String> {
  text.lines()
    .map(str::trim)
    .filter(|line| !line.is_empty() && !line.starts_with('#'))
    .find_map(|line| line.strip_prefix(key)?.strip_prefix('=').map(|value| value.trim().trim_matches('"').to_string()))
    .filter(|value| !value.is_empty())
}
/// Địa chỉ máy chủ **không** do người dùng nhập ở màn hình đăng nhập. Thứ tự ưu tiên:
/// 1. biến môi trường `SOP_SERVER_URL` — tiện khi dev hoặc chạy thử nhiều máy chủ
/// 2. file `server.env` trong thư mục dữ liệu app — người quản trị sửa được sau khi cài,
///    không cần build lại installer
/// 3. mặc định `http://localhost:8080`
fn configured_server_url() -> String {
  if let Ok(value) = std::env::var("SOP_SERVER_URL") {
    if !value.trim().is_empty() { return normalize_url(&value); }
  }
  if let Ok(dir) = app_dir() {
    if let Ok(text) = fs::read_to_string(dir.join(SERVER_ENV_FILE)) {
      if let Some(value) = parse_env_value(&text, "SOP_SERVER_URL") { return normalize_url(&value); }
    }
  }
  DEFAULT_SERVER_URL.to_string()
}
/// Tạo sẵn file cấu hình kèm hướng dẫn ở lần chạy đầu, để người quản trị biết sửa ở đâu.
fn ensure_server_env_file() {
  let Ok(dir) = app_dir() else { return };
  let path = dir.join(SERVER_ENV_FILE);
  if path.exists() { return; }
  let _ = fs::write(&path, format!(
    "# Địa chỉ máy chủ SOP Widget. Sửa dòng dưới rồi mở lại ứng dụng.\n\
     # Biến môi trường SOP_SERVER_URL (nếu có) sẽ được ưu tiên hơn file này.\n\
     SOP_SERVER_URL={DEFAULT_SERVER_URL}\n"));
}
#[tauri::command]
fn server_url() -> String { configured_server_url() }
// Đọc phiên đang lưu. Phiên quá hạn bị xóa ngay tại đây — BR-19: token 30 ngày, không gia hạn,
// nên hết hạn là phải đăng nhập lại chứ không có đường vòng nào.
fn read_session(conn: &Connection) -> Result<Option<StoredSession>, String> {
  let row = conn.query_row("SELECT user_id,username,display_name,role,token,expires_at,server_url,must_change_password FROM auth_session WHERE id=1", [], |r| Ok(StoredSession {
    session: AuthSession { user_id:r.get(0)?, username:r.get(1)?, display_name:r.get(2)?, role:r.get(3)?, expires_at:r.get(5)?, server_url:r.get(6)?, must_change_password:r.get::<_,i64>(7)? == 1 },
    token: r.get(4)?
  })).optional().map_err(|e| e.to_string())?;
  let Some(stored) = row else { return Ok(None) };
  let expired = chrono::DateTime::parse_from_rfc3339(&stored.session.expires_at).map(|at| at < Utc::now()).unwrap_or(true);
  if expired { clear_session(conn)?; return Ok(None); }
  Ok(Some(stored))
}
fn require_session(conn: &Connection) -> Result<StoredSession, String> {
  read_session(conn)?.ok_or_else(|| "Bạn cần đăng nhập trước khi thực hiện thao tác này.".to_string())
}
fn clear_session(conn: &Connection) -> Result<(), String> { conn.execute("DELETE FROM auth_session", []).map_err(|e| e.to_string())?; Ok(()) }
fn save_session(conn: &Connection, stored: &StoredSession) -> Result<(), String> {
  clear_session(conn)?;
  conn.execute("INSERT INTO auth_session (id,user_id,username,display_name,role,token,expires_at,server_url,must_change_password,created_at) VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,?9)",
    params![stored.session.user_id, stored.session.username, stored.session.display_name, stored.session.role, stored.token, stored.session.expires_at, stored.session.server_url, stored.session.must_change_password as i64, now()]).map_err(|e| e.to_string())?;
  Ok(())
}
// Lỗi nghiệp vụ do server trả về đã là tiếng Việt hướng người dùng cuối, nên dùng thẳng.
// Chỉ khi không đọc được thân phản hồi mới ghép message chung theo mã HTTP.
fn api_message(status: reqwest::StatusCode, body: &str) -> String {
  if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
    if let Some(message) = value.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) { return message.to_string(); }
  }
  format!("Máy chủ trả lỗi {}.", status.as_u16())
}
fn network_message(error: reqwest::Error) -> String {
  if error.is_connect() || error.is_timeout() { "Không kết nối được máy chủ. Kiểm tra mạng hoặc địa chỉ máy chủ.".to_string() }
  else { format!("Lỗi khi gọi máy chủ: {error}") }
}

#[tauri::command]
async fn login(username: String, password: String) -> Result<AuthSession, String> {
  let base = configured_server_url();
  if !base.starts_with("http://") && !base.starts_with("https://") {
    return Err(format!("Địa chỉ máy chủ trong cấu hình không hợp lệ: {base}"));
  }
  if username.trim().is_empty() || password.is_empty() { return Err("Vui lòng nhập tên đăng nhập và mật khẩu.".into()); }
  let response = reqwest::Client::new().post(format!("{base}/api/v1/auth/login"))
    .json(&serde_json::json!({ "username": username.trim(), "password": password }))
    .send().await.map_err(network_message)?;
  let status = response.status();
  let body = response.text().await.map_err(network_message)?;
  if !status.is_success() { return Err(api_message(status, &body)); }
  let payload: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("Phản hồi của máy chủ không hợp lệ: {e}"))?;
  let data = payload.get("data").ok_or("Phản hồi của máy chủ thiếu dữ liệu đăng nhập.")?;
  let user = data.get("user").ok_or("Phản hồi của máy chủ thiếu thông tin tài khoản.")?;
  let stored = StoredSession {
    session: AuthSession {
      user_id: user.get("id").and_then(|v| v.as_i64()).ok_or("Phản hồi của máy chủ thiếu mã tài khoản.")?,
      username: user.get("username").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
      display_name: user.get("display_name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
      role: user.get("role").and_then(|v| v.as_str()).unwrap_or("member").to_string(),
      expires_at: data.get("expires_at").and_then(|v| v.as_str()).ok_or("Phản hồi của máy chủ thiếu thời hạn phiên.")?.to_string(),
      server_url: base,
      must_change_password: user.get("must_change_password").and_then(|v| v.as_bool()).unwrap_or(false)
    },
    token: data.get("token").and_then(|v| v.as_str()).ok_or("Phản hồi của máy chủ thiếu token.")?.to_string()
  };
  let conn = db()?;
  save_session(&conn, &stored)?;
  Ok(stored.session)
}
#[tauri::command]
async fn logout() -> Result<(), String> {
  // Đóng connection trước khi gọi HTTP: rusqlite::Connection không `Send` nên không giữ
  // được qua `.await`. Mọi command async dưới đây theo cùng khuôn này.
  let Some((base, token)) = ({ let conn = db()?; read_session(&conn)?.map(|s| (s.session.server_url, s.token)) }) else { return Ok(()) };
  // Xóa phiên local bất kể server có phản hồi hay không: người dùng đã muốn thoát thì
  // không được giữ họ lại chỉ vì mất mạng. Phiên trên server sẽ tự hết hạn.
  let _ = reqwest::Client::new().post(format!("{base}/api/v1/auth/logout")).bearer_auth(&token).send().await;
  let conn = db()?;
  clear_session(&conn)
}
#[tauri::command]
fn current_session() -> Result<Option<AuthSession>, String> { let conn = db()?; Ok(read_session(&conn)?.map(|stored| stored.session)) }
// Gọi API có xác thực và trả về phần `data`.
// Lỗi trả kèm cờ "phiên không còn hợp lệ" để caller tự dọn phiên local — hàm này không giữ
// `Connection` vì rusqlite::Connection không `Send`, không mang qua `.await` được.
async fn authed_post(base: &str, token: &str, path: &str, body: serde_json::Value) -> Result<serde_json::Value, (bool, String)> {
  let response = reqwest::Client::new().post(format!("{base}{path}"))
    .bearer_auth(token).json(&body).send().await.map_err(|e| (false, network_message(e)))?;
  let status = response.status();
  let text = response.text().await.map_err(|e| (false, network_message(e)))?;
  if !status.is_success() {
    return Err((status == reqwest::StatusCode::UNAUTHORIZED, api_message(status, &text)));
  }
  if text.trim().is_empty() { return Ok(serde_json::Value::Null); }
  let payload: serde_json::Value = serde_json::from_str(&text).map_err(|e| (false, format!("Phản hồi của máy chủ không hợp lệ: {e}")))?;
  Ok(payload.get("data").cloned().unwrap_or(serde_json::Value::Null))
}
async fn authed_get(base: &str, token: &str, path: &str) -> Result<serde_json::Value, (bool, String)> {
  let response = reqwest::Client::new().get(format!("{base}{path}"))
    .bearer_auth(token).send().await.map_err(|e| (false, network_message(e)))?;
  let status = response.status();
  let text = response.text().await.map_err(|e| (false, network_message(e)))?;
  if !status.is_success() {
    return Err((status == reqwest::StatusCode::UNAUTHORIZED, api_message(status, &text)));
  }
  let payload: serde_json::Value = serde_json::from_str(&text).map_err(|e| (false, format!("Phản hồi của máy chủ không hợp lệ: {e}")))?;
  Ok(payload.get("data").cloned().unwrap_or(serde_json::Value::Null))
}
/// Dọn phiên local khi server báo phiên không còn hợp lệ, rồi trả message cho UI.
fn handle_api_failure(unauthorized: bool, message: String) -> String {
  if unauthorized { if let Ok(conn) = db() { let _ = clear_session(&conn); } }
  message
}
fn parse_recipients(data: &serde_json::Value) -> Vec<Recipient> {
  data.as_array().map(|items| items.iter().filter_map(|item| Some(Recipient {
    id: item.get("id")?.as_i64()?,
    display_name: item.get("display_name")?.as_str()?.to_string()
  })).collect()).unwrap_or_default()
}
#[tauri::command]
async fn list_members() -> Result<Vec<Recipient>, String> {
  let stored = { let conn = db()?; require_session(&conn)? };
  let data = authed_get(&stored.session.server_url, &stored.token, "/api/v1/users").await
    .map_err(|(unauthorized, message)| handle_api_failure(unauthorized, message))?;
  Ok(parse_recipients(&data))
}
#[tauri::command]
async fn list_inbox() -> Result<Vec<InboxItem>, String> {
  let stored = { let conn = db()?; require_session(&conn)? };
  let data = authed_get(&stored.session.server_url, &stored.token, "/api/v1/reports/inbox?limit=50").await
    .map_err(|(unauthorized, message)| handle_api_failure(unauthorized, message))?;
  let base = stored.session.server_url;
  Ok(data.as_array().map(|items| items.iter().filter_map(|item| {
    let report_id = item.get("id")?.as_str()?.to_string();
    Some(InboxItem {
      share_url: format!("{base}/r/{report_id}"),
      report_id,
      run_id: item.get("run_id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
      procedure_name: item.get("procedure_name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
      operator_display_name: item.get("operator_display_name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
      sender_display_name: item.get("sender").and_then(|s| s.get("display_name")).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
      run_status: item.get("run_status").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
      created_at: item.get("created_at").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
      size_bytes: item.get("size_bytes").and_then(|v| v.as_u64()).unwrap_or(0),
      first_viewed_at: item.get("first_viewed_at").and_then(|v| v.as_str()).map(|s| s.to_string())
    })
  }).collect()).unwrap_or_default())
}
// Mở link báo cáo bằng trình duyệt mặc định.
// Chỉ nhận `report_id` rồi tự dựng URL từ máy chủ của phiên hiện tại — frontend không truyền
// được URL tùy ý vào đây. Mỗi hệ điều hành có lệnh mở URL riêng: `rundll32 url.dll,FileProtocolHandler`
// trên Windows, `open` trên macOS. Tham số truyền trực tiếp cho tiến trình (không qua shell)
// nên không bị chèn lệnh.
#[tauri::command]
fn open_report_link(report_id: String) -> Result<String, String> {
  if report_id.is_empty() || !report_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
    return Err("Mã báo cáo không hợp lệ.".into());
  }
  let base = { let conn = db()?; require_session(&conn)?.session.server_url };
  if !base.starts_with("http://") && !base.starts_with("https://") {
    return Err("Địa chỉ máy chủ không hợp lệ.".into());
  }
  let url = format!("{base}/r/{report_id}");
  #[cfg(target_os = "windows")]
  let (program, leading): (&str, &[&str]) = ("rundll32", &["url.dll,FileProtocolHandler"]);
  #[cfg(target_os = "macos")]
  let (program, leading): (&str, &[&str]) = ("open", &[]);
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  let (program, leading): (&str, &[&str]) = ("xdg-open", &[]);
  std::process::Command::new(program).args(leading).arg(&url)
    .spawn().map_err(|e| format!("Không mở được trình duyệt: {e}"))?;
  Ok(url)
}
// D4/BR-22: xuất file HTML ra máy TRƯỚC, rồi mới tải lên. Tải lên lỗi thì người dùng vẫn còn
// file trong tay, không mất công chạy lại quy trình.
#[tauri::command]
async fn share_report(run_id: String, recipient_ids: Vec<i64>) -> Result<SharedReport, String> {
  if recipient_ids.is_empty() { return Err("Vui lòng chọn ít nhất một người nhận.".into()); }
  let local_path = export_report(run_id.clone())?;
  let (stored, procedure_name, operator_display_name, run_started_at, run_status) = {
    let conn = db()?;
    let stored = require_session(&conn)?;
    let details = get_run(run_id.clone())?;
    let operator = details.run.operator_name.clone().filter(|name| !name.trim().is_empty())
      .unwrap_or_else(|| stored.session.display_name.clone());
    (stored, details.procedure.name, operator, details.run.started_at, details.run.status)
  };
  let bytes = fs::read(&local_path).map_err(|e| format!("Không đọc được tệp báo cáo vừa xuất: {e}"))?;
  let size_bytes = bytes.len() as u64;
  let file_name = Path::new(&local_path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| format!("report-{run_id}.html"));
  let ids = serde_json::to_string(&recipient_ids).map_err(|e| e.to_string())?;
  let form = reqwest::multipart::Form::new()
    .text("run_id", run_id.clone())
    .text("procedure_name", procedure_name)
    .text("operator_display_name", operator_display_name)
    .text("run_started_at", run_started_at)
    .text("run_status", run_status)
    .text("recipient_ids", ids)
    .part("file", reqwest::multipart::Part::bytes(bytes).file_name(file_name)
      .mime_str("text/html").map_err(|e| e.to_string())?);

  let response = reqwest::Client::new().post(format!("{}/api/v1/reports", stored.session.server_url))
    .bearer_auth(&stored.token).multipart(form).send().await.map_err(network_message)?;
  let status = response.status();
  let text = response.text().await.map_err(network_message)?;
  if !status.is_success() {
    return Err(handle_api_failure(status == reqwest::StatusCode::UNAUTHORIZED, api_message(status, &text)));
  }
  let payload: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Phản hồi của máy chủ không hợp lệ: {e}"))?;
  let data = payload.get("data").ok_or("Phản hồi của máy chủ thiếu dữ liệu báo cáo.")?;
  let report_id = data.get("id").and_then(|v| v.as_str()).ok_or("Phản hồi của máy chủ thiếu mã báo cáo.")?.to_string();
  let share_url = data.get("share_url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
  let recipients = parse_recipients(data.get("recipients").unwrap_or(&serde_json::Value::Null));
  {
    let conn = db()?;
    conn.execute("UPDATE runs SET shared_report_id=?1, shared_at=?2 WHERE id=?3", params![report_id, now(), run_id]).map_err(|e| e.to_string())?;
  }
  Ok(SharedReport { report_id, share_url, local_path, size_bytes, recipients })
}
#[tauri::command]
async fn create_member(username: String, display_name: String, password: String, role: String) -> Result<Member, String> {
  let username = username.trim().to_lowercase();
  let display_name = display_name.trim().to_string();
  if username.len() < 3 || username.len() > 64 || !username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-') {
    return Err("Tên đăng nhập chỉ gồm chữ thường, số và các ký tự . _ - (3–64 ký tự).".into());
  }
  if display_name.is_empty() || display_name.chars().count() > 128 { return Err("Tên hiển thị phải có từ 1 đến 128 ký tự.".into()); }
  if password.chars().count() < 8 { return Err("Mật khẩu phải có ít nhất 8 ký tự.".into()); }
  if role != "admin" && role != "member" { return Err("Quyền không hợp lệ.".into()); }
  let stored = { let conn = db()?; require_session(&conn)? };
  // Chặn sớm để báo lỗi tiếng Việt ngay; server vẫn kiểm lại và là nguồn quyết định cuối.
  if stored.session.role != "admin" { return Err("Chỉ quản trị viên mới tạo được tài khoản.".into()); }
  let body = serde_json::json!({ "username": username, "display_name": display_name, "password": password, "role": role });
  let data = authed_post(&stored.session.server_url, &stored.token, "/api/v1/users", body).await
    .map_err(|(unauthorized, message)| handle_api_failure(unauthorized, message))?;
  Ok(Member {
    id: data.get("id").and_then(|v| v.as_i64()).ok_or("Phản hồi của máy chủ thiếu mã tài khoản.")?,
    username: data.get("username").and_then(|v| v.as_str()).unwrap_or(&username).to_string(),
    display_name: data.get("display_name").and_then(|v| v.as_str()).unwrap_or(&display_name).to_string(),
    role: data.get("role").and_then(|v| v.as_str()).unwrap_or(&role).to_string(),
    is_active: data.get("is_active").and_then(|v| v.as_bool()).unwrap_or(true),
    must_change_password: data.get("must_change_password").and_then(|v| v.as_bool()).unwrap_or(true)
  })
}
#[tauri::command]
async fn change_own_password(current_password: String, new_password: String) -> Result<AuthSession, String> {
  if new_password.chars().count() < 8 { return Err("Mật khẩu mới phải có ít nhất 8 ký tự.".into()); }
  let stored = { let conn = db()?; require_session(&conn)? };
  let body = serde_json::json!({ "current_password": current_password, "new_password": new_password });
  // Sai mật khẩu hiện tại cũng trả 401 nhưng KHÔNG phải phiên hết hạn — không được dọn phiên,
  // nếu không người dùng bị đẩy về màn hình đăng nhập chỉ vì gõ sai một lần.
  if let Err((unauthorized, message)) = authed_post(&stored.session.server_url, &stored.token, "/api/v1/auth/password", body).await {
    let session_lost = unauthorized && !message.contains("Mật khẩu hiện tại");
    return Err(handle_api_failure(session_lost, message));
  }
  let updated = StoredSession { session: AuthSession { must_change_password: false, ..stored.session }, token: stored.token };
  let conn = db()?;
  save_session(&conn, &updated)?;
  Ok(updated.session)
}

#[tauri::command]
fn list_procedures() -> Result<Vec<Procedure>, String> { let conn=db()?; let ids=conn.prepare("SELECT id FROM procedures WHERE archived=0 ORDER BY updated_at DESC").map_err(|e|e.to_string())?.query_map([],|r|r.get(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<i64>,_>>().map_err(|e|e.to_string())?; ids.into_iter().map(|id|procedure(&conn,id)).collect() }
#[tauri::command]
fn save_procedure(input: ProcedureInput) -> Result<Procedure, String> {
  if input.name.trim().is_empty() || input.steps.is_empty() || input.steps.iter().any(|s|s.title.trim().is_empty()) { return Err("Quy trình cần có tên và ít nhất một bước hợp lệ.".into()); }
  let mut conn = db()?;
  let tx = conn.transaction().map_err(|e|e.to_string())?;
  let stamp = now();
  // Bước không bao giờ bị DELETE: step_executions tham chiếu steps(id) và foreign key
  // được bật, nên xóa bước đã có lần chạy sẽ vi phạm ràng buộc. Thay vào đó archive hết
  // rồi bật lại archived=0 cho những bước còn trong input — giữ nguyên id để ảnh bằng
  // chứng của lần chạy cũ không mất liên kết.
  let id = match input.id.filter(|id|*id>0) {
    Some(id) => { tx.execute("UPDATE procedures SET name=?1,description=?2,category=?3,updated_at=?4 WHERE id=?5",params![input.name,input.description,input.category,stamp,id]).map_err(|e|e.to_string())?; tx.execute("UPDATE steps SET archived=1 WHERE procedure_id=?1",[id]).map_err(|e|e.to_string())?; id },
    None => { tx.execute("INSERT INTO procedures(name,description,category,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",params![input.name,input.description,input.category,stamp]).map_err(|e|e.to_string())?; tx.last_insert_rowid() }
  };
  for (i,s) in input.steps.iter().enumerate() {
    let updated = match s.id.filter(|sid|*sid>0) {
      Some(sid) => tx.execute("UPDATE steps SET order_index=?1,title=?2,description=?3,command=?4,requires_evidence=?5,archived=0 WHERE id=?6 AND procedure_id=?7",params![i as i64,s.title,s.description,s.command,s.requires_evidence,sid,id]).map_err(|e|e.to_string())?,
      None => 0
    };
    if updated == 0 { tx.execute("INSERT INTO steps(procedure_id,order_index,title,description,command,requires_evidence) VALUES(?1,?2,?3,?4,?5,?6)",params![id,i as i64,s.title,s.description,s.command,s.requires_evidence]).map_err(|e|e.to_string())?; }
  }
  tx.commit().map_err(|e|e.to_string())?;
  procedure(&conn,id)
}
#[tauri::command]
fn delete_procedure(id: i64) -> Result<(), String> { let conn=db()?; conn.execute("UPDATE procedures SET archived=1,updated_at=?1 WHERE id=?2",params![now(),id]).map_err(|e|e.to_string())?; Ok(()) }
// BR-23: tên người thực hiện lấy từ tài khoản đang đăng nhập, KHÔNG nhận từ frontend.
// Đây là lý do tồn tại của tính năng đăng nhập — nếu tên vẫn do frontend truyền xuống thì
// vẫn khai được tên bất kỳ và mục tiêu chống khai gian không đạt.
#[tauri::command]
fn start_run(procedure_id: i64) -> Result<Run, String> {
  let conn = db()?;
  let stored = require_session(&conn)?;
  if stored.session.must_change_password { return Err("Bạn cần đổi mật khẩu trước khi chạy quy trình.".into()); }
  let _ = procedure(&conn, procedure_id)?;
  let run = Run { id:Uuid::new_v4().to_string(), procedure_id, status:"running".into(), started_at:now(), completed_at:None, operator_name:Some(stored.session.display_name.clone()), procedure_name:None, confirmed_count:None, evidence_count:None };
  conn.execute("INSERT INTO runs(id,procedure_id,status,started_at,operator_name,operator_user_id) VALUES(?1,?2,?3,?4,?5,?6)",
    params![run.id, run.procedure_id, run.status, run.started_at, run.operator_name, stored.session.user_id]).map_err(|e|e.to_string())?;
  Ok(run)
}
#[tauri::command]
fn get_run(run_id: String) -> Result<RunDetails, String> { let conn=db()?; let run=conn.query_row("SELECT id,procedure_id,status,started_at,completed_at,operator_name FROM runs WHERE id=?1",[&run_id],|r|Ok(Run{id:r.get(0)?,procedure_id:r.get(1)?,status:r.get(2)?,started_at:r.get(3)?,completed_at:r.get(4)?,operator_name:r.get(5)?,procedure_name:None,confirmed_count:None,evidence_count:None})).map_err(|e|e.to_string())?; let finished=run.status=="completed"||run.status=="cancelled"; let procedure=procedure_scoped(&conn,run.procedure_id,Some(run_id.as_str()),finished)?; let executions=conn.prepare("SELECT id,run_id,step_id,confirmed_at,notes,evidence_path,captured_at,evidence_hash FROM step_executions WHERE run_id=?1").map_err(|e|e.to_string())?.query_map([&run_id],|r|Ok(Execution{id:r.get(0)?,run_id:r.get(1)?,step_id:r.get(2)?,confirmed_at:r.get(3)?,notes:r.get(4)?,evidence_path:r.get(5)?,captured_at:r.get(6)?,evidence_hash:r.get(7)?})).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?; Ok(RunDetails {run,procedure,executions}) }
#[tauri::command]
fn confirm_step(run_id: String, step_id: i64, notes: String) -> Result<(), String> { let conn=db()?; if run_status(&conn,&run_id)?!="running" { return Err("Lần chạy này đã kết thúc, không thể xác nhận thêm bước.".into()); } let requires:bool=conn.query_row("SELECT requires_evidence FROM steps WHERE id=?1",[step_id],|r|r.get(0)).map_err(|e|e.to_string())?; let evidence:Option<String>=conn.query_row("SELECT evidence_path FROM step_executions WHERE run_id=?1 AND step_id=?2",params![run_id,step_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?.flatten(); if requires && evidence.is_none() { return Err("Bước này yêu cầu ảnh bằng chứng trước khi xác nhận.".into()); } conn.execute("INSERT INTO step_executions(run_id,step_id,confirmed_at,notes) VALUES(?1,?2,?3,?4) ON CONFLICT(run_id,step_id) DO UPDATE SET confirmed_at=excluded.confirmed_at,notes=excluded.notes",params![run_id,step_id,now(),notes]).map_err(|e|e.to_string())?; Ok(()) }
#[tauri::command]
fn set_run_status(run_id: String, status: String) -> Result<(), String> { if !["running","completed","cancelled"].contains(&status.as_str()) {return Err("Trạng thái không hợp lệ.".into())} let conn=db()?; let completed=if status=="completed" {Some(now())} else {None}; conn.execute("UPDATE runs SET status=?1,completed_at=?2 WHERE id=?3",params![status,completed,run_id]).map_err(|e|e.to_string())?; Ok(()) }
#[tauri::command]
fn capture_evidence(run_id: String, step_id: i64) -> Result<String, String> {
  let conn = db()?;
  // Kiểm tra trạng thái TRƯỚC khi chụp để không sinh file PNG rác cho run đã đóng.
  if run_status(&conn,&run_id)?!="running" { return Err("Lần chạy này đã kết thúc, không thể chụp thêm bằng chứng.".into()); }
  let evidence_dir=app_dir()?.join("evidence").join(&run_id);
  fs::create_dir_all(&evidence_dir).map_err(|e|e.to_string())?;
  let screen=screenshots::Screen::all().map_err(|e|format!("Không thể truy cập màn hình: {e}"))?.into_iter().next().ok_or("Không tìm thấy màn hình để chụp.")?;
  let image=screen.capture().map_err(|e|format!("Chụp màn hình thất bại: {e}"))?;
  let path=evidence_dir.join(format!("step-{step_id}-{}.png",Utc::now().format("%Y%m%d-%H%M%S")));
  image.save(&path).map_err(|e|e.to_string())?;
  let hash=sha256_file(&path)?;
  let path_string=path.to_string_lossy().to_string();
  conn.execute("INSERT INTO step_executions(run_id,step_id,evidence_path,captured_at,evidence_hash) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(run_id,step_id) DO UPDATE SET evidence_path=excluded.evidence_path,captured_at=excluded.captured_at,evidence_hash=excluded.evidence_hash",params![run_id,step_id,path_string,now(),hash]).map_err(|e|e.to_string())?;
  Ok(path_string)
}
#[tauri::command]
fn list_runs() -> Result<Vec<Run>, String> {
  let conn = db()?;
  // BR-14: cố ý KHÔNG lọc p.archived — archive quy trình không được giấu lần chạy cũ.
  let mut statement = conn.prepare("SELECT r.id,r.procedure_id,r.status,r.started_at,r.completed_at,r.operator_name,p.name,(SELECT COUNT(*) FROM step_executions e WHERE e.run_id=r.id AND e.confirmed_at IS NOT NULL),(SELECT COUNT(*) FROM step_executions e WHERE e.run_id=r.id AND e.evidence_path IS NOT NULL) FROM runs r JOIN procedures p ON p.id=r.procedure_id ORDER BY r.started_at DESC").map_err(|e| e.to_string())?;
  let runs = statement.query_map([], |r| Ok(Run { id:r.get(0)?, procedure_id:r.get(1)?, status:r.get(2)?, started_at:r.get(3)?, completed_at:r.get(4)?, operator_name:r.get(5)?, procedure_name:r.get(6)?, confirmed_count:r.get(7)?, evidence_count:r.get(8)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
  Ok(runs)
}
#[tauri::command]
fn export_report(run_id: String) -> Result<String, String> {
  // Cố ý cho phép xuất ở mọi trạng thái run, kể cả đang chạy — lấy báo cáo giữa chừng.
  let details = get_run(run_id)?;
  let mut rows = String::new();
  for step in &details.procedure.steps {
    let execution = details.executions.iter().find(|e|e.step_id==step.id);
    rows.push_str(&format!("<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
      step.order_index+1,
      html(&step.title),
      execution.and_then(|e|e.confirmed_at.as_ref()).map(|s|html(s)).unwrap_or_else(||"Chưa xác nhận".into()),
      execution.and_then(|e|e.notes.as_ref()).map(|s|html(s)).unwrap_or_else(||"—".into()),
      evidence_cell(execution)));
  }
  let report = format!("<!doctype html><html lang='vi'><meta charset='utf-8'><title>Báo cáo SOP</title><style>body{{font:14px Segoe UI,Arial;margin:40px;color:#172b4d}}table{{width:100%;border-collapse:collapse}}th,td{{border:1px solid #d0d5dd;padding:9px;text-align:left;vertical-align:top}}th{{background:#e8f1fb}}h1{{color:#0f6cbd}}img.evidence{{max-width:520px;height:auto;display:block;border:1px solid #d0d5dd}}.hash{{font:11px Consolas,monospace;color:#5e6c84;word-break:break-all;margin-top:4px}}.missing{{color:#a32d2d}}</style><h1>Báo cáo thực hiện SOP</h1><p><b>Quy trình:</b> {}<br><b>Người thực hiện:</b> {}<br><b>Lần chạy:</b> {}<br><b>Trạng thái:</b> {}<br><b>Bắt đầu:</b> {}<br><b>Hoàn tất:</b> {}</p><table><thead><tr><th>#</th><th>Bước</th><th>Xác nhận</th><th>Ghi chú</th><th>Ảnh bằng chứng</th></tr></thead><tbody>{}</tbody></table></html>",
    html(&details.procedure.name),
    details.run.operator_name.as_ref().filter(|s|!s.trim().is_empty()).map(|s|html(s)).unwrap_or_else(||"(chưa đặt tên)".into()),
    html(&details.run.id),
    html(status_label(&details.run.status)),
    html(&details.run.started_at),
    details.run.completed_at.as_ref().map(|s|html(s)).unwrap_or_else(||"—".into()),
    rows);
  let dir = app_dir()?.join("reports");
  fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
  let path = dir.join(format!("report-{}-{}.html",details.run.id,Utc::now().format("%Y%m%d-%H%M%S")));
  fs::write(&path,report).map_err(|e|e.to_string())?;
  Ok(path.to_string_lossy().to_string())
}
// BR-10: nhúng ảnh base64 để file HTML gửi đi xem được trên máy không có file gốc.
// Ảnh mất không làm fail cả báo cáo — chỉ in dòng cảnh báo tại đúng ô đó.
fn evidence_cell(execution: Option<&Execution>) -> String {
  let Some(execution) = execution else { return "—".into() };
  let Some(path) = execution.evidence_path.as_ref() else { return "—".into() };
  let hash = execution.evidence_hash.as_ref().map(|h|html(h)).unwrap_or_else(||"(chưa có hash)".into());
  match fs::read(path) {
    Ok(bytes) => format!("<img class='evidence' src='data:image/png;base64,{}' alt='Ảnh bằng chứng'><div class='hash'>SHA-256: {}</div>",base64::engine::general_purpose::STANDARD.encode(&bytes),hash),
    Err(_) => format!("<div class='missing'>Ảnh bằng chứng không tìm thấy tại: {}</div><div class='hash'>SHA-256: {}</div>",html(path),hash)
  }
}
fn status_label(status: &str) -> &'static str { match status { "completed"=>"Hoàn thành", "cancelled"=>"Đã hủy", _=>"Đang chạy" } }
fn html(value: &str) -> String { value.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;") }

pub fn run() { ensure_server_env_file(); tauri::Builder::default().invoke_handler(tauri::generate_handler![server_url,login,logout,current_session,change_own_password,create_member,list_members,share_report,list_inbox,open_report_link,list_procedures,save_procedure,delete_procedure,start_run,get_run,confirm_step,set_run_status,capture_evidence,list_runs,export_report]).run(tauri::generate_context!()).expect("error while running SOP Widget"); }
