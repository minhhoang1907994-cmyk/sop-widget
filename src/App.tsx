import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from './api';
import type { Procedure, ProcedureInput, Run, RunDetails, StepInput } from './types';

type View = 'picker' | 'runner' | 'done' | 'builder' | 'history';
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
  const [confirmState, setConfirmState] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);
  const [transparency, setTransparency] = useState(() => Number(localStorage.getItem('sop-widget-transparency') ?? 20));
  const [backgroundColor, setBackgroundColor] = useState(() => localStorage.getItem('sop-widget-background-color') ?? '#abf1f2');
  const [operatorName, setOperatorName] = useState(() => localStorage.getItem('sop-widget-operator-name') ?? '');
  const loadProcedures = async () => setProcedures(await api.listProcedures());
  useEffect(() => { void loadProcedures(); }, []);
  useEffect(() => {
    localStorage.setItem('sop-widget-transparency', String(transparency));
    localStorage.setItem('sop-widget-background-color', backgroundColor);
    localStorage.setItem('sop-widget-operator-name', operatorName);
  }, [transparency, backgroundColor, operatorName]);
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
  const start = async (id: number) => { try { setBusy(true); const run = await api.startRun(id, operatorName); setDetails(await api.getRun(run.id)); setView('runner'); } catch (e) { setNotice(String(e)); } finally { setBusy(false); } };
  const removeProcedure = async () => { if (!editor.id) return; if (!await askConfirm({ title: 'Xóa quy trình này khỏi danh sách?', message: 'Lịch sử và ảnh bằng chứng của các lần đã chạy vẫn được giữ nguyên và xem lại được trong Lịch sử.', confirmLabel: 'Xóa quy trình', cancelLabel: 'Giữ lại', tone: 'danger' })) return; try { setBusy(true); await api.deleteProcedure(editor.id); await loadProcedures(); goPicker(); } catch (e) { setNotice(String(e)); } finally { setBusy(false); } };
  const openEditor = (procedure?: Procedure) => { setEditor(procedure ? { id: procedure.id, name: procedure.name, description: procedure.description, category: procedure.category ?? '', steps: procedure.steps.map(s => ({ id: s.id, title: s.title, description: s.description, command: s.command, requires_evidence: s.requires_evidence })) } : newProcedure()); setView('builder'); };
  const save = async () => { if (!editor.name.trim() || editor.steps.some(s => !s.title.trim())) { setNotice('Vui lòng nhập tên quy trình và tiêu đề cho mọi bước.'); return; } try { setBusy(true); await api.saveProcedure(editor); await loadProcedures(); goPicker(); } catch (e) { setNotice(String(e)); } finally { setBusy(false); } };
  const openHistory = async () => { try { setRuns(await api.listRuns()); setView('history'); } catch (e) { setNotice(String(e)); } };
  const currentTitle = view === 'runner' ? details?.procedure.name : view === 'done' ? finished?.procedure.name : view === 'builder' ? 'Quản lý quy trình' : view === 'history' ? 'Lịch sử SOP' : 'SOP Widget';

  const widgetStyle = { '--glass-transparency': `${transparency}%`, '--panel-color': backgroundColor } as CSSProperties;

  return <main className="widget-app" style={widgetStyle}>
    <header className="titlebar">
      <div className="drag-region" data-tauri-drag-region="true">
        <div className="app-icon">✓</div><span className="app-name">{currentTitle}</span>
      </div>
      <div className="win-btns">
        <button type="button" className="win-btn settings-btn" title="Cài đặt giao diện" aria-label="Cài đặt giao diện" onClick={e => { e.stopPropagation(); setSettingsOpen(open => !open); }}>⚙</button>
        <button type="button" className="win-btn" title="Thu gọn" aria-label="Thu gọn" onClick={e => { e.stopPropagation(); void minimizeWindow(); }}>–</button>
        <button type="button" className="win-btn close" title="Đóng" aria-label="Đóng" onClick={e => { e.stopPropagation(); void closeWindow(); }}>✕</button>
      </div>
    </header>
    {settingsOpen && <aside className="settings-panel" aria-label="Cài đặt giao diện">
      <div className="settings-heading"><b>Giao diện</b><button type="button" aria-label="Đóng cài đặt" onClick={() => setSettingsOpen(false)}>×</button></div>
      <label className="range-setting"><span>Độ trong suốt <b>{transparency}%</b></span><input type="range" min="15" max="85" value={transparency} onChange={e => setTransparency(Number(e.target.value))} /></label>
      <label className="color-setting"><span>Màu nền</span><input type="color" value={backgroundColor} onChange={e => setBackgroundColor(e.target.value)} /></label>
      <label className="name-setting"><span>Tên người thực hiện</span><input type="text" value={operatorName} onChange={e => setOperatorName(e.target.value)} placeholder="Nhập tên để in lên báo cáo" /></label>
    </aside>}
    <div className="widget-body">
      {notice && <button className="notice" onClick={() => setNotice('')}>{notice} <b>×</b></button>}
      {view === 'picker' && <Picker procedures={procedures} busy={busy} onStart={start} onCreate={() => openEditor()} onHistory={openHistory} />}
      {view === 'runner' && details && <Runner details={details} busy={busy} setBusy={setBusy} onReload={async () => setDetails(await api.getRun(details.run.id))} onCancelRun={async () => { await api.setRunStatus(details.run.id, 'cancelled'); goPicker(); }} onFinished={(done) => { setFinished(done); setView('done'); }} onError={setNotice} onAskConfirm={askConfirm} />}
      {view === 'done' && finished && <Done details={finished} onPicker={goPicker} onExport={async () => { try { setNotice(`Đã xuất báo cáo: ${await api.exportReport(finished.run.id)}`); } catch (e) { setNotice(String(e)); } }} />}
      {view === 'builder' && <Builder value={editor} busy={busy} onChange={setEditor} onSave={save} onCancel={goPicker} onDelete={removeProcedure} />}
      {view === 'history' && <History runs={runs} onBack={goPicker} onExport={async id => { try { setNotice(`Đã xuất báo cáo: ${await api.exportReport(id)}`); } catch (e) { setNotice(String(e)); } }} />}
    </div>
    {confirmState && <ConfirmDialog request={confirmState} onResolve={resolveConfirm} />}
  </main>;
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

function Done({ details, onPicker, onExport }: { details: RunDetails; onPicker: () => void; onExport: () => void }) { const evidence = details.executions.filter(e => e.evidence_path).length; return <div className="done-wrap"><div className="done-icon">✓</div><div className="done-title">Hoàn thành quy trình</div><div className="done-sub">{details.procedure.name}</div><div className="done-stats"><div><b className="done-stat-num">{details.procedure.steps.length}</b><span className="done-stat-label">bước</span></div><div><b className="done-stat-num">{evidence}</b><span className="done-stat-label">bằng chứng</span></div></div><div className="done-actions"><button className="btn" onClick={onExport}>📄 Xuất báo cáo</button><button className="btn btn-primary" onClick={onPicker}>Về danh sách</button></div></div>; }

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

function History({ runs, onBack, onExport }: { runs: Run[]; onBack: () => void; onExport: (id: string) => void }) { return <div className="history-view"><p className="picker-label">Lịch sử thực hiện</p><div className="history-list">{runs.map(run => <div className="history-item" key={run.id}><b>{run.procedure_name}</b><span>{runStatusLabel(run.status)} · {run.confirmed_count ?? 0} bước{run.operator_name ? ` · ${run.operator_name}` : ''}</span><button className="btn btn-small" onClick={() => onExport(run.id)}>Xuất HTML</button></div>)}{!runs.length && <p className="empty-state">Chưa có lần chạy nào.</p>}</div><button className="btn" onClick={onBack}>‹ Về danh sách</button></div>; }
