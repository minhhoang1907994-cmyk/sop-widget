use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
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
struct Run { id: String, procedure_id: i64, status: String, started_at: String, completed_at: Option<String>, procedure_name: Option<String>, confirmed_count: Option<i64>, evidence_count: Option<i64> }
#[derive(Debug, Serialize)]
struct Execution { id: i64, run_id: String, step_id: i64, confirmed_at: Option<String>, notes: Option<String>, evidence_path: Option<String>, captured_at: Option<String> }
#[derive(Debug, Serialize)]
struct RunDetails { run: Run, procedure: Procedure, executions: Vec<Execution> }

fn app_dir() -> Result<PathBuf, String> {
  let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
  let dir = base.join("NTA").join("SOP Widget");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}
fn db() -> Result<Connection, String> {
  let conn = Connection::open(app_dir()?.join("sop-widget.db")).map_err(|e| e.to_string())?;
  conn.execute_batch("PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS procedures (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS steps (id INTEGER PRIMARY KEY, procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE, order_index INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', command TEXT, requires_evidence INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, procedure_id INTEGER NOT NULL REFERENCES procedures(id), status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE IF NOT EXISTS step_executions (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_id INTEGER NOT NULL REFERENCES steps(id), confirmed_at TEXT, notes TEXT, evidence_path TEXT, captured_at TEXT, UNIQUE(run_id, step_id));
  ").map_err(|e| e.to_string())?;
  let _ = conn.execute("ALTER TABLE procedures ADD COLUMN archived INTEGER NOT NULL DEFAULT 0", []);
  let _ = conn.execute("ALTER TABLE steps ADD COLUMN archived INTEGER NOT NULL DEFAULT 0", []);
  seed(&conn)?;
  Ok(conn)
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
#[tauri::command]
fn start_run(procedure_id: i64) -> Result<Run, String> { let conn=db()?; let _=procedure(&conn,procedure_id)?; let run=Run { id:Uuid::new_v4().to_string(), procedure_id, status:"running".into(), started_at:now(), completed_at:None, procedure_name:None, confirmed_count:None, evidence_count:None }; conn.execute("INSERT INTO runs(id,procedure_id,status,started_at) VALUES(?1,?2,?3,?4)",params![run.id,run.procedure_id,run.status,run.started_at]).map_err(|e|e.to_string())?; Ok(run) }
#[tauri::command]
fn get_run(run_id: String) -> Result<RunDetails, String> { let conn=db()?; let run=conn.query_row("SELECT id,procedure_id,status,started_at,completed_at FROM runs WHERE id=?1",[&run_id],|r|Ok(Run{id:r.get(0)?,procedure_id:r.get(1)?,status:r.get(2)?,started_at:r.get(3)?,completed_at:r.get(4)?,procedure_name:None,confirmed_count:None,evidence_count:None})).map_err(|e|e.to_string())?; let finished=run.status=="completed"||run.status=="cancelled"; let procedure=procedure_scoped(&conn,run.procedure_id,Some(run_id.as_str()),finished)?; let executions=conn.prepare("SELECT id,run_id,step_id,confirmed_at,notes,evidence_path,captured_at FROM step_executions WHERE run_id=?1").map_err(|e|e.to_string())?.query_map([&run_id],|r|Ok(Execution{id:r.get(0)?,run_id:r.get(1)?,step_id:r.get(2)?,confirmed_at:r.get(3)?,notes:r.get(4)?,evidence_path:r.get(5)?,captured_at:r.get(6)?})).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?; Ok(RunDetails {run,procedure,executions}) }
#[tauri::command]
fn confirm_step(run_id: String, step_id: i64, notes: String) -> Result<(), String> { let conn=db()?; let requires:bool=conn.query_row("SELECT requires_evidence FROM steps WHERE id=?1",[step_id],|r|r.get(0)).map_err(|e|e.to_string())?; let evidence:Option<String>=conn.query_row("SELECT evidence_path FROM step_executions WHERE run_id=?1 AND step_id=?2",params![run_id,step_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?.flatten(); if requires && evidence.is_none() { return Err("Bước này yêu cầu ảnh bằng chứng trước khi xác nhận.".into()); } conn.execute("INSERT INTO step_executions(run_id,step_id,confirmed_at,notes) VALUES(?1,?2,?3,?4) ON CONFLICT(run_id,step_id) DO UPDATE SET confirmed_at=excluded.confirmed_at,notes=excluded.notes",params![run_id,step_id,now(),notes]).map_err(|e|e.to_string())?; Ok(()) }
#[tauri::command]
fn set_run_status(run_id: String, status: String) -> Result<(), String> { if !["running","paused","completed","cancelled"].contains(&status.as_str()) {return Err("Trạng thái không hợp lệ.".into())} let conn=db()?; let completed=if status=="completed" {Some(now())} else {None}; conn.execute("UPDATE runs SET status=?1,completed_at=?2 WHERE id=?3",params![status,completed,run_id]).map_err(|e|e.to_string())?; Ok(()) }
#[tauri::command]
fn capture_evidence(run_id: String, step_id: i64) -> Result<String, String> { let evidence_dir=app_dir()?.join("evidence").join(&run_id); fs::create_dir_all(&evidence_dir).map_err(|e|e.to_string())?; let screen=screenshots::Screen::all().map_err(|e|format!("Không thể truy cập màn hình: {e}"))?.into_iter().next().ok_or("Không tìm thấy màn hình để chụp.")?; let image=screen.capture().map_err(|e|format!("Chụp màn hình thất bại: {e}"))?; let path=evidence_dir.join(format!("step-{step_id}-{}.png",Utc::now().format("%Y%m%d-%H%M%S"))); image.save(&path).map_err(|e|e.to_string())?; let path_string=path.to_string_lossy().to_string(); let conn=db()?; conn.execute("INSERT INTO step_executions(run_id,step_id,evidence_path,captured_at) VALUES(?1,?2,?3,?4) ON CONFLICT(run_id,step_id) DO UPDATE SET evidence_path=excluded.evidence_path,captured_at=excluded.captured_at",params![run_id,step_id,path_string,now()]).map_err(|e|e.to_string())?; Ok(path_string) }
#[tauri::command]
fn list_runs() -> Result<Vec<Run>, String> {
  let conn = db()?;
  let mut statement = conn.prepare("SELECT r.id,r.procedure_id,r.status,r.started_at,r.completed_at,p.name,(SELECT COUNT(*) FROM step_executions e WHERE e.run_id=r.id AND e.confirmed_at IS NOT NULL),(SELECT COUNT(*) FROM step_executions e WHERE e.run_id=r.id AND e.evidence_path IS NOT NULL) FROM runs r JOIN procedures p ON p.id=r.procedure_id ORDER BY r.started_at DESC").map_err(|e| e.to_string())?;
  let runs = statement.query_map([], |r| Ok(Run { id:r.get(0)?, procedure_id:r.get(1)?, status:r.get(2)?, started_at:r.get(3)?, completed_at:r.get(4)?, procedure_name:r.get(5)?, confirmed_count:r.get(6)?, evidence_count:r.get(7)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
  Ok(runs)
}
#[tauri::command]
fn export_report(run_id: String) -> Result<String, String> { let details=get_run(run_id)?; let mut rows=String::new(); for step in &details.procedure.steps { let execution=details.executions.iter().find(|e|e.step_id==step.id); rows.push_str(&format!("<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",step.order_index+1,html(&step.title),execution.and_then(|e|e.confirmed_at.as_ref()).map(|s|html(s)).unwrap_or_else(||"Chưa xác nhận".into()),execution.and_then(|e|e.notes.as_ref()).map(|s|html(s)).unwrap_or_else(||"—".into()),execution.and_then(|e|e.evidence_path.as_ref()).map(|s|html(s)).unwrap_or_else(||"—".into()))); } let report=format!("<!doctype html><html lang='vi'><meta charset='utf-8'><title>Báo cáo SOP</title><style>body{{font:14px Segoe UI,Arial;margin:40px;color:#172b4d}}table{{width:100%;border-collapse:collapse}}th,td{{border:1px solid #d0d5dd;padding:9px;text-align:left;vertical-align:top}}th{{background:#e8f1fb}}h1{{color:#0f6cbd}}</style><h1>Báo cáo thực hiện SOP</h1><p><b>Quy trình:</b> {}<br><b>Lần chạy:</b> {}<br><b>Trạng thái:</b> {}<br><b>Bắt đầu:</b> {}<br><b>Hoàn tất:</b> {}</p><table><thead><tr><th>#</th><th>Bước</th><th>Xác nhận</th><th>Ghi chú</th><th>Ảnh bằng chứng</th></tr></thead><tbody>{}</tbody></table></html>",html(&details.procedure.name),html(&details.run.id),html(&details.run.status),html(&details.run.started_at),details.run.completed_at.as_ref().map(|s|html(s)).unwrap_or_else(||"—".into()),rows); let dir=app_dir()?.join("reports"); fs::create_dir_all(&dir).map_err(|e|e.to_string())?; let path=dir.join(format!("report-{}-{}.html",details.run.id,Utc::now().format("%Y%m%d-%H%M%S"))); fs::write(&path,report).map_err(|e|e.to_string())?; Ok(path.to_string_lossy().to_string()) }
fn html(value: &str) -> String { value.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;") }

pub fn run() { tauri::Builder::default().invoke_handler(tauri::generate_handler![list_procedures,save_procedure,delete_procedure,start_run,get_run,confirm_step,set_run_status,capture_evidence,list_runs,export_report]).run(tauri::generate_context!()).expect("error while running SOP Widget"); }
