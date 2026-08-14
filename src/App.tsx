import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from './api';
import type { AuthSession, InboxItem, Member, Procedure, ProcedureInput, Recipient, Run, RunDetails, SharedReport, StepInput } from './types';

type View = 'picker' | 'runner' | 'done' | 'builder' | 'history' | 'new-account' | 'share-report' | 'inbox';
type ConfirmRequest = { title: string; message: string; confirmLabel?: string; cancelLabel?: string; tone?: 'danger' | 'primary' };
type AskConfirm = (request: ConfirmRequest) => Promise<boolean>;
const newStep = (): StepInput => ({ title: '', description: '', command: '', requires_evidence: false });
const newProcedure = (): ProcedureInput => ({ name: '', description: '', category: '', steps: [newStep()] });
const appearance = (category?: string | null) => {
  const value = (category ?? '').toLowerCase();
  if (value.includes('backup')) return { icon: '🗄️', color: 'amber' };
  if (value.includes('setup')) return { icon: '🖥️', color: 'teal' };
  return { icon: '🚀', color: 'blue' };
};

export default function App() {
  const [view, setView] = useState<View>('picker');
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [details, setDetails] = useState<RunDetails | null>(null);
  const [finished, setFinished] = useState<RunDetails | null>(null);
  const [editor, setEditor] = useState<ProcedureInput>(newProcedure());
  const [runs, setRuns] = useState<Run[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // Lần chạy đang được gửi. Đặt ở App vì cả màn hình tổng kết và Lịch sử đều mở được view gửi.
  const [shareRunId, setShareRunId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);
  const [transparency, setTransparency] = useState(() => Number(localStorage.getItem('sop-widget-transparency') ?? 20));
  const [backgroundColor, setBackgroundColor] = useState(() => localStorage.getItem('sop-widget-background-color') ?? '#abf1f2');
  const [session, setSession] = useState<AuthSession | null>(null);
  // Chưa biết có phiên hay không thì chưa vẽ gì — tránh nhoáng màn hình đăng nhập rồi lại nhảy
  // vào danh sách quy trình khi phiên vẫn còn hiệu lực.
  const [sessionReady, setSessionReady] = useState(false);
  const loadProcedures = async () => setProcedures(await api.listProcedures());
  useEffect(() => {
    void (async () => {
      try {
        const current = await api.currentSession();
        setSession(current);
        if (current && !current.must_change_password) await loadProcedures();
      } catch (e) {
        setNotice(String(e));
      } finally {
        setSessionReady(true);
      }
    })();
  }, []);
  useEffect(() => {
    localStorage.setItem('sop-widget-transparency', String(transparency));
    localStorage.setItem('sop-widget-background-color', backgroundColor);
  }, [transparency, backgroundColor]);
  const onSignedIn = async (next: AuthSession) => {
    setSession(next);
    setNotice('');
    if (!next.must_change_password) {
      await loadProcedures();
      setView('picker');
    }
  };
  const signOut = async () => {
    try {
      setBusy(true);
      await api.logout();
    } catch (e) {
      setNotice(String(e));
    } finally {
      setSession(null);
      setProcedures([]);
      setDetails(null);
      setFinished(null);
      setSettingsOpen(false);
      setView('picker');
      setBusy(false);
    }
  };
  const goPicker = () => { setView('picker'); setDetails(null); setFinished(null); };
  const askConfirm: AskConfirm = request => new Promise(resolve => setConfirmState({ ...request, resolve }));
  const resolveConfirm = (ok: boolean) => { confirmState?.resolve(ok); setConfirmState(null); };
  const isTauriWindow = () => typeof window !== 'undefined' && !!(window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  const minimizeWindow = async () => {
    try {
      if (isTauriWindow()) {
        await getCurrentWindow().minimize();
        return;
      }
      window.blur();
    } catch {
      /* fallback when the app is not running in a Tauri window */
    }
  };
  const closeWindow = async () => {
    try {
      if (isTauriWindow()) {
        await getCurrentWindow().close();
        return;
      }
      window.close();
    } catch {
      const root = document.getElementById('root');
      if (root) root.style.display = 'none';
    }
  };
  const start = async (id: number) => { try { setBusy(true); const run = await api.startRun(id); setDetails(await api.getRun(run.id)); setView('runner'); } catch (e) { setNotice(String(e)); } finally { setBusy(false); } };
  const removeProcedure = async () => { if (!editor.id) return; if (!await askConfirm({ title: 'Xóa quy trình này khỏi danh sách?', message: 'Lịch sử và ảnh bằng chứng của các lần đã chạy vẫn được giữ nguyên và xem lại được trong Lịch sử.', confirmLabel: 'Xóa quy trình', cancelLabel: 'Giữ lại', tone: 'danger' })) return; try { setBusy(true); await api.deleteProcedure(editor.id); await loadProcedures(); goPicker(); } catch (e) { setNotice(String(e)); } finally { setBusy(false); } };
  const openEditor = (procedure?: Procedure) => { setEditor(procedure ? { id: procedure.id, name: procedure.name, description: procedure.description, category: procedure.category ?? '', steps: procedure.steps.map(s => ({ id: s.id, title: s.title, description: s.description, command: s.command, requires_evidence: s.requires_evidence })) } : newProcedure()); setView('builder'); };
  const save = async () => { if (!editor.name.trim() || editor.steps.some(s => !s.title.trim())) { setNotice('Vui lòng nhập tên quy trình và tiêu đề cho mọi bước.'); return; } try { setBusy(true); await api.saveProcedure(editor); await loadProcedures(); goPicker(); } catch (e) { setNotice(String(e)); } finally { setBusy(false); } };
  const openHistory = async () => { try { setRuns(await api.listRuns()); setView('history'); } catch (e) { setNotice(String(e)); } };
  const currentTitle = !session
    ? 'Đăng nhập SOP Widget'
    : session.must_change_password
      ? 'Đổi mật khẩu'
      : view === 'runner' ? details?.procedure.name
        : view === 'done' ? finished?.procedure.name
          : view === 'builder' ? 'Quản lý quy trình'
            : view === 'history' ? 'Lịch sử SOP'
              : view === 'new-account' ? 'Thêm tài khoản'
                : view === 'share-report' ? 'Gửi báo cáo'
                  : view === 'inbox' ? 'Báo cáo đã nhận'
                    : 'SOP Widget';

  const widgetStyle = { '--glass-transparency': `${transparency}%`, '--panel-color': backgroundColor } as CSSProperties;

  return <main className="widget-app" style={widgetStyle}>
    <header className="titlebar">
      <div className="drag-region" data-tauri-drag-region="true">
        <div className="app-icon">✓</div><span className="app-name">{currentTitle}</span>
      </div>
      <div className="win-btns">
        {session && <button type="button" className="win-btn account-btn" title="Tài khoản" aria-label="Tài khoản" aria-expanded={accountOpen} onClick={e => { e.stopPropagation(); setSettingsOpen(false); setAccountOpen(open => !open); }}>👤</button>}
        <button type="button" className="win-btn settings-btn" title="Cài đặt giao diện" aria-label="Cài đặt giao diện" onClick={e => { e.stopPropagation(); setAccountOpen(false); setSettingsOpen(open => !open); }}>⚙</button>
        <button type="button" className="win-btn" title="Thu gọn" aria-label="Thu gọn" onClick={e => { e.stopPropagation(); void minimizeWindow(); }}>–</button>
        <button type="button" className="win-btn close" title="Đóng" aria-label="Đóng" onClick={e => { e.stopPropagation(); void closeWindow(); }}>✕</button>
      </div>
    </header>
    {settingsOpen && <aside className="settings-panel" aria-label="Cài đặt giao diện">
      <div className="settings-heading"><b>Giao diện</b><button type="button" aria-label="Đóng cài đặt" onClick={() => setSettingsOpen(false)}>×</button></div>
      <label className="range-setting"><span>Độ trong suốt <b>{transparency}%</b></span><input type="range" min="15" max="85" value={transparency} onChange={e => setTransparency(Number(e.target.value))} /></label>
      <label className="color-setting"><span>Màu nền</span><input type="color" value={backgroundColor} onChange={e => setBackgroundColor(e.target.value)} /></label>
    </aside>}
    {accountOpen && session && <AccountPanel
      session={session}
      busy={busy}
      onClose={() => setAccountOpen(false)}
      onAddAccount={() => { setAccountOpen(false); setNotice(''); setView('new-account'); }}
      onOpenInbox={() => { setAccountOpen(false); setNotice(''); setView('inbox'); }}
      onSignOut={async () => { setAccountOpen(false); await signOut(); }}
    />}
    <div className="widget-body">
      {notice && <button className="notice" onClick={() => setNotice('')}>{notice} <b>×</b></button>}
      {!sessionReady && <p className="empty-state">Đang kiểm tra phiên đăng nhập…</p>}
      {sessionReady && !session && <Login busy={busy} setBusy={setBusy} onSignedIn={onSignedIn} onError={setNotice} />}
      {sessionReady && session?.must_change_password && <PasswordChange busy={busy} setBusy={setBusy} onChanged={onSignedIn} onError={setNotice} onSignOut={signOut} />}
      {sessionReady && session && !session.must_change_password && <>
      {view === 'picker' && <Picker procedures={procedures} busy={busy} onStart={start} onCreate={() => openEditor()} onHistory={openHistory} />}
      {view === 'runner' && details && <Runner details={details} busy={busy} setBusy={setBusy} onReload={async () => setDetails(await api.getRun(details.run.id))} onCancelRun={async () => { await api.setRunStatus(details.run.id, 'cancelled'); goPicker(); }} onFinished={(done) => { setFinished(done); setView('done'); }} onError={setNotice} onAskConfirm={askConfirm} />}
      {view === 'done' && finished && <Done details={finished} onPicker={goPicker} onExport={async () => { try { setNotice(`Đã xuất báo cáo: ${await api.exportReport(finished.run.id)}`); } catch (e) { setNotice(String(e)); } }} onShare={() => { setNotice(''); setShareRunId(finished.run.id); setView('share-report'); }} />}
      {view === 'builder' && <Builder value={editor} busy={busy} onChange={setEditor} onSave={save} onCancel={goPicker} onDelete={removeProcedure} />}
      {view === 'history' && <History runs={runs} onBack={goPicker} onExport={async id => { try { setNotice(`Đã xuất báo cáo: ${await api.exportReport(id)}`); } catch (e) { setNotice(String(e)); } }} onShare={id => { setNotice(''); setShareRunId(id); setView('share-report'); }} />}
      {view === 'share-report' && shareRunId && <ShareReport
        runId={shareRunId}
        busy={busy}
        setBusy={setBusy}
        onNotice={setNotice}
        onBack={() => { setShareRunId(null); setView(finished ? 'done' : 'history'); }}
        onDone={() => { setShareRunId(null); setNotice(''); goPicker(); }}
      />}
      {view === 'inbox' && <Inbox onNotice={setNotice} onBack={goPicker} />}
      {view === 'new-account' && <NewAccount busy={busy} setBusy={setBusy} onNotice={setNotice} onBack={() => { setNotice(''); setView('picker'); }} onCreated={member => { setNotice(`Đã tạo tài khoản "${member.username}" (${roleLabel(member.role)}). Người này phải đổi mật khẩu ở lần đăng nhập đầu.`); setView('picker'); }} />}
      </>}
    </div>
    {confirmState && <ConfirmDialog request={confirmState} onResolve={resolveConfirm} />}
  </main>;
}

const roleLabel = (role: AuthSession['role']) => (role === 'admin' ? 'Quản trị viên' : 'Thành viên');

function AccountPanel({ session, busy, onClose, onAddAccount, onOpenInbox, onSignOut }: { session: AuthSession; busy: boolean; onClose: () => void; onAddAccount: () => void; onOpenInbox: () => void; onSignOut: () => Promise<void> }) {
  const expiresLabel = (() => {
    const at = new Date(session.expires_at);
    return Number.isNaN(at.getTime()) ? session.expires_at : at.toLocaleDateString('vi-VN');
  })();

  return <aside className="account-panel" aria-label="Tài khoản">
    <div className="settings-heading"><b>Tài khoản</b><button type="button" aria-label="Đóng" onClick={onClose}>×</button></div>
    <div className="account-card">
      <b className="account-name">{session.display_name}</b>
      <span className="account-meta">{session.username} · {roleLabel(session.role)}</span>
      <span className="account-meta">Máy chủ: {session.server_url}</span>
      <span className="account-meta">Phiên hết hạn: {expiresLabel}</span>
    </div>

    {/* Chưa đổi mật khẩu bắt buộc thì server chặn mọi thao tác nghiệp vụ (403
        PASSWORD_CHANGE_REQUIRED), nên không hiện nút để không mời bấm vào lỗi. */}
    {session.role === 'admin' && session.must_change_password &&
      <p className="account-hint">Đổi mật khẩu trước, sau đó mới tạo được tài khoản cho người khác.</p>}

    {!session.must_change_password &&
      <button type="button" className="add-proc-btn" disabled={busy} onClick={onOpenInbox}>📥 Báo cáo đã nhận</button>}

    {session.role === 'admin' && !session.must_change_password &&
      <button type="button" className="add-proc-btn" disabled={busy} onClick={onAddAccount}>＋ Thêm tài khoản</button>}

    <button type="button" className="btn btn-ghost account-signout" disabled={busy} onClick={() => void onSignOut()}>Đăng xuất</button>
  </aside>;
}

function Inbox({ onNotice, onBack }: { onNotice: (message: string) => void; onBack: () => void }) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [opening, setOpening] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        setItems(await api.listInbox());
      } catch (e) {
        setItems([]);
        onNotice(String(e));
      }
    })();
  }, []);

  const open = async (item: InboxItem) => {
    try {
      setOpening(item.report_id);
      await api.openReportLink(item.report_id);
    } catch (e) {
      onNotice(String(e));
    } finally {
      setOpening('');
    }
  };

  const receivedAt = (value: string) => {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? value : at.toLocaleString('vi-VN');
  };

  return <div className="history-view">
    <p className="picker-label">Báo cáo người khác gửi cho bạn</p>
    <div className="history-list">
      {items === null && <p className="empty-state">Đang tải danh sách…</p>}
      {items !== null && !items.length && <p className="empty-state">Chưa có báo cáo nào được gửi cho bạn.</p>}
      {(items ?? []).map(item => <div className="history-item" key={item.report_id}>
        <b>{item.procedure_name}</b>
        <span>Từ: {item.sender_display_name} · {receivedAt(item.created_at)}</span>
        <span>Người thực hiện: {item.operator_display_name} · {(item.size_bytes / 1024 / 1024).toFixed(1)} MB{item.first_viewed_at ? ' · đã xem' : ''}</span>
        <div className="history-item-actions">
          <button className="btn btn-small" disabled={opening === item.report_id} onClick={() => void open(item)}>
            {opening === item.report_id ? 'Đang mở…' : 'Mở báo cáo'}
          </button>
        </div>
      </div>)}
    </div>
    <p className="account-hint">Link mở bằng trình duyệt và yêu cầu đăng nhập lại trên web — đây là phiên riêng, không dùng chung với phiên trong app.</p>
    <button className="btn" onClick={onBack}>‹ Về danh sách</button>
  </div>;
}

function NewAccount({ busy, setBusy, onNotice, onBack, onCreated }: { busy: boolean; setBusy: (busy: boolean) => void; onNotice: (message: string) => void; onBack: () => void; onCreated: (member: Member) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Member['role']>('member');
  const usernamePattern = /^[a-z0-9._-]{3,64}$/;
  const normalizedUsername = username.trim().toLowerCase();
  const usernameInvalid = normalizedUsername.length > 0 && !usernamePattern.test(normalizedUsername);

  const submit = async () => {
    try {
      setBusy(true);
      onCreated(await api.createMember(username, displayName, password, role));
    } catch (e) {
      onNotice(String(e));
    } finally {
      setBusy(false);
    }
  };

  return <form className="account-view" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="picker-label">Tạo tài khoản cho thành viên</p>
    <label>Tên đăng nhập<input value={username} autoFocus autoCapitalize="none" spellCheck={false} onChange={e => setUsername(e.target.value)} placeholder="vd: nguyenvana" /></label>
    {usernameInvalid && <p className="login-warn">Chỉ dùng chữ thường, số và các ký tự . _ - (3–64 ký tự).</p>}
    <label>Tên hiển thị<input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Tên sẽ in lên báo cáo" /></label>
    <label>Mật khẩu tạm<input type="password" value={password} autoComplete="new-password" onChange={e => setPassword(e.target.value)} /></label>
    <label>Quyền<select value={role} onChange={e => setRole(e.target.value as Member['role'])}>
      <option value="member">Thành viên</option>
      <option value="admin">Quản trị viên</option>
    </select></label>
    <p className="account-hint">Mật khẩu tạm cần ít nhất 8 ký tự. Người dùng sẽ bị buộc đổi mật khẩu ngay ở lần đăng nhập đầu, nên bạn chỉ cần gửi mật khẩu này cho họ một lần.</p>
    <div className="builder-actions">
      <button type="button" className="btn" disabled={busy} onClick={onBack}>Hủy</button>
      <button type="submit" className="btn btn-primary" disabled={busy || usernameInvalid || normalizedUsername.length < 3 || !displayName.trim() || password.length < 8}>Tạo tài khoản</button>
    </div>
  </form>;
}

function Login({ busy, setBusy, onSignedIn, onError }: { busy: boolean; setBusy: (busy: boolean) => void; onSignedIn: (session: AuthSession) => Promise<void>; onError: (message: string) => void }) {
  const [username, setUsername] = useState(() => localStorage.getItem('sop-widget-last-username') ?? '');
  const [password, setPassword] = useState('');
  // Chỉ để hiển thị: địa chỉ máy chủ do cấu hình phía Rust quyết định, không nhập ở đây.
  // Hiện ra để khi báo cáo lỗi kết nối, người dùng biết app đang trỏ vào đâu.
  const [target, setTarget] = useState('');

  useEffect(() => { void api.serverUrl().then(setTarget).catch(() => setTarget('')); }, []);

  const submit = async () => {
    try {
      setBusy(true);
      const session = await api.login(username, password);
      localStorage.setItem('sop-widget-last-username', username.trim());
      setPassword('');
      await onSignedIn(session);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return <form className="login-view" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="picker-label">Đăng nhập để chạy quy trình</p>
    <label>Tên đăng nhập<input value={username} autoFocus autoComplete="username" onChange={e => setUsername(e.target.value)} /></label>
    <label>Mật khẩu<input type="password" value={password} autoComplete="current-password" onChange={e => setPassword(e.target.value)} /></label>
    <button className="btn btn-primary" type="submit" disabled={busy || !username.trim() || !password}>Đăng nhập</button>
    {target && <p className="login-hint">Máy chủ: {target}</p>}
    <p className="login-hint">Cần kết nối tới máy chủ để đăng nhập. Sau khi đăng nhập, việc chạy quy trình và chụp bằng chứng vẫn hoạt động khi mất mạng.</p>
  </form>;
}

function PasswordChange({ busy, setBusy, onChanged, onError, onSignOut }: { busy: boolean; setBusy: (busy: boolean) => void; onChanged: (session: AuthSession) => Promise<void>; onError: (message: string) => void; onSignOut: () => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const mismatch = newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword;

  const submit = async () => {
    if (newPassword !== confirmPassword) { onError('Hai lần nhập mật khẩu mới không giống nhau.'); return; }
    try {
      setBusy(true);
      await onChanged(await api.changeOwnPassword(currentPassword, newPassword));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return <form className="login-view" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="picker-label">Đổi mật khẩu trước khi tiếp tục</p>
    <label>Mật khẩu hiện tại<input type="password" value={currentPassword} autoFocus autoComplete="current-password" onChange={e => setCurrentPassword(e.target.value)} /></label>
    <label>Mật khẩu mới<input type="password" value={newPassword} autoComplete="new-password" onChange={e => setNewPassword(e.target.value)} /></label>
    <label>Nhập lại mật khẩu mới<input type="password" value={confirmPassword} autoComplete="new-password" onChange={e => setConfirmPassword(e.target.value)} /></label>
    {mismatch && <p className="login-warn">Hai lần nhập mật khẩu mới không giống nhau.</p>}
    <button className="btn btn-primary" type="submit" disabled={busy || currentPassword.length === 0 || newPassword.length < 8 || mismatch}>Đổi mật khẩu</button>
    <p className="login-hint">Mật khẩu mới cần ít nhất 8 ký tự và khác mật khẩu hiện tại.</p>
    <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void onSignOut()}>Đăng xuất</button>
  </form>;
}

function Picker({ procedures, busy, onStart, onCreate, onHistory }: { procedures: Procedure[]; busy: boolean; onStart: (id: number) => void; onCreate: () => void; onHistory: () => void }) {
  const [search, setSearch] = useState('');
  const normalizedSearch = search.trim().toLocaleLowerCase('vi');
  const filteredProcedures = procedures.filter(procedure => procedure.name.toLocaleLowerCase('vi').includes(normalizedSearch));

  return <div className="picker-view"><p className="picker-label">Chọn quy trình để bắt đầu</p><input className="procedure-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm tên quy trình..." aria-label="Tìm tên quy trình" /><div className="procedure-list">{filteredProcedures.map(p => { const look = appearance(p.category); return <button className="proc-item" key={p.id} disabled={busy} onClick={() => onStart(p.id)}><span className={`proc-icon ${look.color}`}>{look.icon}</span><span className="proc-info"><b className="proc-name">{p.name}</b><span className="proc-meta">{p.steps.length} bước</span></span><span className="proc-chevron">›</span></button>; })}{!procedures.length && <p className="empty-state">Chưa có quy trình nào.</p>}{procedures.length > 0 && !filteredProcedures.length && <p className="empty-state">Không tìm thấy quy trình phù hợp.</p>}</div><button className="add-proc-btn" onClick={onCreate}>＋ Tạo quy trình mới</button><button className="history-link" onClick={onHistory}>◷ Xem lịch sử thực hiện</button></div>;
}

function Runner({ details, busy, setBusy, onReload, onCancelRun, onFinished, onError, onAskConfirm }: { details: RunDetails; busy: boolean; setBusy: (busy: boolean) => void; onReload: () => Promise<void>; onCancelRun: () => Promise<void>; onFinished: (details: RunDetails) => void; onError: (message: string) => void; onAskConfirm: AskConfirm }) {
  const [notes, setNotes] = useState('');
  const confirmed = useMemo(() => new Set(details.executions.filter(e => e.confirmed_at).map(e => e.step_id)), [details]);
  const index = details.procedure.steps.findIndex(step => !confirmed.has(step.id));
  const step = details.procedure.steps[index];
  const execution = details.executions.find(item => item.step_id === step?.id);
  const percent = Math.round((confirmed.size / details.procedure.steps.length) * 100);
  useEffect(() => setNotes(''), [step?.id]);
  if (!step) return null;
  const capture = async () => { try { setBusy(true); await api.captureEvidence(details.run.id, step.id); await onReload(); } catch (e) { onError(String(e)); } finally { setBusy(false); } };
  const complete = async () => { try { setBusy(true); await api.confirmStep(details.run.id, step.id, notes); if (index + 1 === details.procedure.steps.length) { await api.setRunStatus(details.run.id, 'completed'); onFinished(await api.getRun(details.run.id)); } else await onReload(); } catch (e) { onError(String(e)); } finally { setBusy(false); } };
  const needsEvidence = step.requires_evidence;
  return <><div className="progress-row"><span>Bước {index + 1} / {details.procedure.steps.length}</span><span>{percent}%</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>
    {details.procedure.category?.toLowerCase().includes('backup') && index === details.procedure.steps.length - 1 && <div className="warn-box">⚠️ Bước xác nhận rủi ro — đọc kỹ trước khi tiếp tục.</div>}
    <h1 className="step-title">{step.title}</h1><p className="step-desc">{step.description}</p>{step.command && <pre className="code-block">{step.command}</pre>}
    {needsEvidence && <><p className="evidence-hint">📷 Bước này yêu cầu bằng chứng</p><button className={`btn ${execution?.evidence_path ? 'btn-captured' : ''}`} disabled={busy} onClick={capture}>{execution?.evidence_path ? '✓ Đã chụp bằng chứng' : '📷 Chụp bằng chứng'}</button>{execution?.evidence_path ? <div className="evidence-row"><span className="evidence-thumb">🖼️</span><span>Ảnh bằng chứng đã lưu</span></div> : <div className="evidence-space" />}</>}
    <label className="note-label">Ghi chú (tùy chọn)<textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Thêm ghi chú cho bước này" /></label><button className="btn btn-primary" disabled={busy || (needsEvidence && !execution?.evidence_path)} onClick={complete}>✓ Xác nhận hoàn thành</button><div className="nav-row"><button className="btn btn-ghost" disabled={busy} onClick={() => { void (async () => { if (await onAskConfirm({ title: 'Hủy lần chạy này?', message: 'Các bước đã xác nhận vẫn được giữ trong lịch sử, nhưng lần chạy này sẽ không tiếp tục được nữa.', confirmLabel: 'Hủy lần chạy', cancelLabel: 'Tiếp tục chạy', tone: 'danger' })) await onCancelRun(); })(); }}>✕ Hủy lần chạy</button></div></>;
}

function Done({ details, onPicker, onExport, onShare }: { details: RunDetails; onPicker: () => void; onExport: () => void; onShare: () => void }) { const evidence = details.executions.filter(e => e.evidence_path).length; return <div className="done-wrap"><div className="done-icon">✓</div><div className="done-title">Hoàn thành quy trình</div><div className="done-sub">{details.procedure.name}</div><div className="done-stats"><div><b className="done-stat-num">{details.procedure.steps.length}</b><span className="done-stat-label">bước</span></div><div><b className="done-stat-num">{evidence}</b><span className="done-stat-label">bằng chứng</span></div></div><button className="btn btn-primary done-share" onClick={onShare}>📤 Gửi báo cáo cho thành viên</button><div className="done-actions"><button className="btn" onClick={onExport}>📄 Xuất ra máy</button><button className="btn" onClick={onPicker}>Về danh sách</button></div></div>; }

function ShareReport({ runId, busy, setBusy, onNotice, onBack, onDone }: { runId: string; busy: boolean; setBusy: (busy: boolean) => void; onNotice: (message: string) => void; onBack: () => void; onDone: () => void }) {
  const [members, setMembers] = useState<Recipient[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [sent, setSent] = useState<SharedReport | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setMembers(await api.listMembers());
      } catch (e) {
        // Không có mạng thì không lấy được danh sách — nói rõ để người dùng biết vẫn còn
        // đường xuất file ra máy rồi gửi tay (BR-21).
        setMembers([]);
        onNotice(String(e));
      }
    })();
  }, []);

  const toggle = (id: number) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const normalizedSearch = search.trim().toLocaleLowerCase('vi');
  const visible = (members ?? []).filter(member => member.display_name.toLocaleLowerCase('vi').includes(normalizedSearch));

  const submit = async () => {
    try {
      setBusy(true);
      setSent(await api.shareReport(runId, selected));
    } catch (e) {
      onNotice(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!sent) return;
    try {
      await navigator.clipboard.writeText(sent.share_url);
      setCopied(true);
    } catch {
      onNotice(`Không sao chép được. Link: ${sent.share_url}`);
    }
  };

  if (sent) return <div className="share-view">
    <div className="done-icon">📤</div>
    <p className="share-sent-title">Đã gửi báo cáo</p>
    <p className="account-hint">Đã gửi cho {sent.recipients.length} người: {sent.recipients.map(r => r.display_name).join(', ')}. Kích thước {(sent.size_bytes / 1024 / 1024).toFixed(1)} MB.</p>
    <p className="share-link">{sent.share_url}</p>
    <p className="account-hint">Người nhận phải đăng nhập mới xem được link này. Bản lưu trên máy: {sent.local_path}</p>
    <div className="builder-actions">
      <button type="button" className="btn" disabled={busy} onClick={() => void copyLink()}>{copied ? '✓ Đã sao chép' : 'Sao chép link'}</button>
      <button type="button" className="btn btn-primary" onClick={onDone}>Xong</button>
    </div>
  </div>;

  return <div className="share-view">
    <p className="picker-label">Chọn người nhận báo cáo</p>
    {members === null && <p className="empty-state">Đang tải danh sách thành viên…</p>}
    {members !== null && members.length === 0 && <p className="empty-state">Chưa lấy được danh sách thành viên. Kiểm tra kết nối tới máy chủ, hoặc xuất báo cáo ra máy rồi gửi tay.</p>}
    {members !== null && members.length > 0 && <>
      <input className="procedure-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm tên thành viên..." aria-label="Tìm tên thành viên" />
      <div className="member-list">
        {visible.map(member => <label className="member-item" key={member.id}>
          <input type="checkbox" checked={selected.includes(member.id)} onChange={() => toggle(member.id)} />
          <span>{member.display_name}</span>
        </label>)}
        {!visible.length && <p className="empty-state">Không tìm thấy thành viên phù hợp.</p>}
      </div>
    </>}
    <p className="account-hint">Báo cáo được xuất ra máy trước, sau đó mới tải lên máy chủ. Nếu tải lên lỗi, tệp vẫn còn trên máy bạn.</p>
    <div className="builder-actions">
      <button type="button" className="btn" disabled={busy} onClick={onBack}>Hủy</button>
      <button type="button" className="btn btn-primary" disabled={busy || selected.length === 0} onClick={() => void submit()}>Gửi{selected.length > 0 ? ` (${selected.length})` : ''}</button>
    </div>
  </div>;
}

function Builder({ value, onChange, onSave, onCancel, onDelete, busy }: { value: ProcedureInput; onChange: (value: ProcedureInput) => void; onSave: () => void; onCancel: () => void; onDelete: () => void; busy: boolean }) {
  const patch = (values: Partial<ProcedureInput>) => onChange({ ...value, ...values }); const patchStep = (i: number, values: Partial<StepInput>) => patch({ steps: value.steps.map((step, index) => index === i ? { ...step, ...values } : step) });
  return <div className="builder-view"><p className="picker-label">Tạo hoặc chỉnh sửa quy trình</p><label>Tên quy trình<input value={value.name} onChange={e => patch({ name: e.target.value })} /></label><label>Danh mục<input value={value.category ?? ''} onChange={e => patch({ category: e.target.value })} placeholder="Deploy, Backup…" /></label><label>Mô tả<textarea value={value.description} onChange={e => patch({ description: e.target.value })} /></label><div className="builder-steps">{value.steps.map((step, i) => <div className="mini-step" key={i}><b>Bước {i + 1}</b><input value={step.title} onChange={e => patchStep(i, { title: e.target.value })} placeholder="Tiêu đề" /><textarea value={step.description} onChange={e => patchStep(i, { description: e.target.value })} placeholder="Mô tả" /><input value={step.command ?? ''} onChange={e => patchStep(i, { command: e.target.value })} placeholder="Lệnh (tùy chọn)" /><label className="check"><input type="checkbox" checked={step.requires_evidence} onChange={e => patchStep(i, { requires_evidence: e.target.checked })} /> Yêu cầu bằng chứng</label>{value.steps.length > 1 && <button className="remove-step" onClick={() => patch({ steps: value.steps.filter((_, index) => index !== i) })}>Xóa bước</button>}</div>)}</div><button className="add-proc-btn" onClick={() => patch({ steps: [...value.steps, newStep()] })}>＋ Thêm bước</button><div className="builder-actions"><button className="btn" onClick={onCancel}>Hủy</button><button className="btn btn-primary" disabled={busy} onClick={onSave}>Lưu quy trình</button></div>{value.id ? <button className="remove-proc-btn" disabled={busy} onClick={onDelete}>🗑 Xóa quy trình</button> : null}</div>;
}

const runStatusLabel = (status: Run['status']) => status === 'completed' ? '✓ Hoàn thành' : status === 'cancelled' ? '✕ Đã hủy' : '▶ Đang chạy';

function ConfirmDialog({ request, onResolve }: { request: ConfirmRequest; onResolve: (ok: boolean) => void }) {
  const tone = request.tone ?? 'primary';
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onResolve(false); }
      else if (event.key === 'Enter') { event.preventDefault(); onResolve(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return <div className="dialog-backdrop" onClick={() => onResolve(false)}>
    <div className="dialog-card" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message" onClick={e => e.stopPropagation()}>
      <div className={`dialog-icon ${tone}`}>{tone === 'danger' ? '⚠️' : '?'}</div>
      <b className="dialog-title" id="dialog-title">{request.title}</b>
      <p className="dialog-message" id="dialog-message">{request.message}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => onResolve(false)}>{request.cancelLabel ?? 'Hủy bỏ'}</button>
        <button type="button" className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} autoFocus onClick={() => onResolve(true)}>{request.confirmLabel ?? 'Đồng ý'}</button>
      </div>
    </div>
  </div>;
}

function History({ runs, onBack, onExport, onShare }: { runs: Run[]; onBack: () => void; onExport: (id: string) => void; onShare: (id: string) => void }) { return <div className="history-view"><p className="picker-label">Lịch sử thực hiện</p><div className="history-list">{runs.map(run => <div className="history-item" key={run.id}><b>{run.procedure_name}</b><span>{runStatusLabel(run.status)} · {run.confirmed_count ?? 0} bước{run.operator_name ? ` · ${run.operator_name}` : ''}</span><div className="history-item-actions"><button className="btn btn-small" onClick={() => onExport(run.id)}>Xuất HTML</button><button className="btn btn-small" onClick={() => onShare(run.id)}>Gửi</button></div></div>)}{!runs.length && <p className="empty-state">Chưa có lần chạy nào.</p>}</div><button className="btn" onClick={onBack}>‹ Về danh sách</button></div>; }
