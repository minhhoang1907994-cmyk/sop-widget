import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from './api';
import type { Procedure, ProcedureInput, Run, RunDetails, StepInput } from './types';

type View = 'picker' | 'runner' | 'done' | 'builder' | 'history';
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
  const [transparency, setTransparency] = useState(() => Number(localStorage.getItem('sop-widget-transparency') ?? 20));
  const [backgroundColor, setBackgroundColor] = useState(() => localStorage.getItem('sop-widget-background-color') ?? '#abf1f2');
  const loadProcedures = async () => setProcedures(await api.listProcedures());
  useEffect(() => { void loadProcedures(); }, []);
  useEffect(() => {
    localStorage.setItem('sop-widget-transparency', String(transparency));
    localStorage.setItem('sop-widget-background-color', backgroundColor);
  }, [transparency, backgroundColor]);
  const goPicker = () => { setView('picker'); setDetails(null); setFinished(null); };
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
    </aside>}
    <div className="widget-body">
      {notice && <button className="notice" onClick={() => setNotice('')}>{notice} <b>×</b></button>}
      {view === 'picker' && <Picker procedures={procedures} busy={busy} onStart={start} onCreate={() => openEditor()} onHistory={openHistory} />}
      {view === 'runner' && details && <Runner details={details} busy={busy} setBusy={setBusy} onReload={async () => setDetails(await api.getRun(details.run.id))} onPause={async () => { await api.setRunStatus(details.run.id, 'paused'); goPicker(); }} onFinished={(done) => { setFinished(done); setView('done'); }} onError={setNotice} />}
      {view === 'done' && finished && <Done details={finished} onPicker={goPicker} onExport={async () => { try { setNotice(`Đã xuất báo cáo: ${await api.exportReport(finished.run.id)}`); } catch (e) { setNotice(String(e)); } }} />}
      {view === 'builder' && <Builder value={editor} busy={busy} onChange={setEditor} onSave={save} onCancel={goPicker} />}
      {view === 'history' && <History runs={runs} onBack={goPicker} onExport={async id => { try { setNotice(`Đã xuất báo cáo: ${await api.exportReport(id)}`); } catch (e) { setNotice(String(e)); } }} />}
    </div>
  </main>;
}

function Picker({ procedures, busy, onStart, onCreate, onHistory }: { procedures: Procedure[]; busy: boolean; onStart: (id: number) => void; onCreate: () => void; onHistory: () => void }) {
  const [search, setSearch] = useState('');
  const normalizedSearch = search.trim().toLocaleLowerCase('vi');
  const filteredProcedures = procedures.filter(procedure => procedure.name.toLocaleLowerCase('vi').includes(normalizedSearch));

  return <div className="picker-view"><p className="picker-label">Chọn quy trình để bắt đầu</p><input className="procedure-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm tên quy trình..." aria-label="Tìm tên quy trình" /><div className="procedure-list">{filteredProcedures.map(p => { const look = appearance(p.category); return <button className="proc-item" key={p.id} disabled={busy} onClick={() => onStart(p.id)}><span className={`proc-icon ${look.color}`}>{look.icon}</span><span className="proc-info"><b className="proc-name">{p.name}</b><span className="proc-meta">{p.steps.length} bước</span></span><span className="proc-chevron">›</span></button>; })}{!procedures.length && <p className="empty-state">Chưa có quy trình nào.</p>}{procedures.length > 0 && !filteredProcedures.length && <p className="empty-state">Không tìm thấy quy trình phù hợp.</p>}</div><button className="add-proc-btn" onClick={onCreate}>＋ Tạo quy trình mới</button><button className="history-link" onClick={onHistory}>◷ Xem lịch sử thực hiện</button></div>;
}

function Runner({ details, busy, setBusy, onReload, onPause, onFinished, onError }: { details: RunDetails; busy: boolean; setBusy: (busy: boolean) => void; onReload: () => Promise<void>; onPause: () => Promise<void>; onFinished: (details: RunDetails) => void; onError: (message: string) => void }) {
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
    <label className="note-label">Ghi chú (tùy chọn)<textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Thêm ghi chú cho bước này" /></label><button className="btn btn-primary" disabled={busy || (needsEvidence && !execution?.evidence_path)} onClick={complete}>✓ Xác nhận hoàn thành</button><div className="nav-row"><button className="btn btn-ghost" disabled={index === 0}>‹ Bước trước</button><button className="btn btn-ghost" onClick={() => void onPause()}>⏸ Tạm dừng</button></div></>;
}

function Done({ details, onPicker, onExport }: { details: RunDetails; onPicker: () => void; onExport: () => void }) { const evidence = details.executions.filter(e => e.evidence_path).length; return <div className="done-wrap"><div className="done-icon">✓</div><div className="done-title">Hoàn thành quy trình</div><div className="done-sub">{details.procedure.name}</div><div className="done-stats"><div><b className="done-stat-num">{details.procedure.steps.length}</b><span className="done-stat-label">bước</span></div><div><b className="done-stat-num">{evidence}</b><span className="done-stat-label">bằng chứng</span></div></div><div className="done-actions"><button className="btn" onClick={onExport}>📄 Xuất báo cáo</button><button className="btn btn-primary" onClick={onPicker}>Về danh sách</button></div></div>; }

function Builder({ value, onChange, onSave, onCancel, busy }: { value: ProcedureInput; onChange: (value: ProcedureInput) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  const patch = (values: Partial<ProcedureInput>) => onChange({ ...value, ...values }); const patchStep = (i: number, values: Partial<StepInput>) => patch({ steps: value.steps.map((step, index) => index === i ? { ...step, ...values } : step) });
  return <div className="builder-view"><p className="picker-label">Tạo hoặc chỉnh sửa quy trình</p><label>Tên quy trình<input value={value.name} onChange={e => patch({ name: e.target.value })} /></label><label>Danh mục<input value={value.category ?? ''} onChange={e => patch({ category: e.target.value })} placeholder="Deploy, Backup…" /></label><label>Mô tả<textarea value={value.description} onChange={e => patch({ description: e.target.value })} /></label><div className="builder-steps">{value.steps.map((step, i) => <div className="mini-step" key={i}><b>Bước {i + 1}</b><input value={step.title} onChange={e => patchStep(i, { title: e.target.value })} placeholder="Tiêu đề" /><textarea value={step.description} onChange={e => patchStep(i, { description: e.target.value })} placeholder="Mô tả" /><input value={step.command ?? ''} onChange={e => patchStep(i, { command: e.target.value })} placeholder="Lệnh (tùy chọn)" /><label className="check"><input type="checkbox" checked={step.requires_evidence} onChange={e => patchStep(i, { requires_evidence: e.target.checked })} /> Yêu cầu bằng chứng</label>{value.steps.length > 1 && <button className="remove-step" onClick={() => patch({ steps: value.steps.filter((_, index) => index !== i) })}>Xóa bước</button>}</div>)}</div><button className="add-proc-btn" onClick={() => patch({ steps: [...value.steps, newStep()] })}>＋ Thêm bước</button><div className="builder-actions"><button className="btn" onClick={onCancel}>Hủy</button><button className="btn btn-primary" disabled={busy} onClick={onSave}>Lưu quy trình</button></div></div>;
}

function History({ runs, onBack, onExport }: { runs: Run[]; onBack: () => void; onExport: (id: string) => void }) { return <div className="history-view"><p className="picker-label">Lịch sử thực hiện</p><div className="history-list">{runs.map(run => <div className="history-item" key={run.id}><b>{run.procedure_name}</b><span>{run.status === 'completed' ? '✓ Hoàn thành' : '⏸ Tạm dừng'} · {run.confirmed_count ?? 0} bước</span><button className="btn btn-small" onClick={() => onExport(run.id)}>Xuất HTML</button></div>)}{!runs.length && <p className="empty-state">Chưa có lần chạy nào.</p>}</div><button className="btn" onClick={onBack}>‹ Về danh sách</button></div>; }
