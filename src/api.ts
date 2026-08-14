import { invoke } from '@tauri-apps/api/core';
import type { AuthSession, InboxItem, Member, Procedure, ProcedureInput, Recipient, Run, RunDetails, SharedReport } from './types';

export const api = {
  // Địa chỉ máy chủ đọc từ cấu hình phía Rust (biến môi trường SOP_SERVER_URL hoặc
  // file server.env trong thư mục dữ liệu app) — người dùng không nhập ở màn hình đăng nhập.
  serverUrl: () => invoke<string>('server_url'),
  login: (username: string, password: string) => invoke<AuthSession>('login', { username, password }),
  logout: () => invoke<void>('logout'),
  currentSession: () => invoke<AuthSession | null>('current_session'),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    invoke<AuthSession>('change_own_password', { currentPassword, newPassword }),
  createMember: (username: string, displayName: string, password: string, role: Member['role']) =>
    invoke<Member>('create_member', { username, displayName, password, role }),
  listMembers: () => invoke<Recipient[]>('list_members'),
  shareReport: (runId: string, recipientIds: number[]) =>
    invoke<SharedReport>('share_report', { runId, recipientIds }),
  listInbox: () => invoke<InboxItem[]>('list_inbox'),
  // Chỉ truyền report_id: URL do phía Rust dựng từ máy chủ của phiên hiện tại.
  openReportLink: (reportId: string) => invoke<string>('open_report_link', { reportId }),
  listProcedures: () => invoke<Procedure[]>('list_procedures'),
  saveProcedure: (procedure: ProcedureInput) => invoke<Procedure>('save_procedure', { input: procedure }),
  deleteProcedure: (id: number) => invoke<void>('delete_procedure', { id }),
  // Không nhận tên người thực hiện: backend lấy từ tài khoản đang đăng nhập (BR-23).
  startRun: (procedureId: number) => invoke<Run>('start_run', { procedureId }),
  getRun: (runId: string) => invoke<RunDetails>('get_run', { runId }),
  listRuns: () => invoke<Run[]>('list_runs'),
  confirmStep: (runId: string, stepId: number, notes: string) => invoke<void>('confirm_step', { runId, stepId, notes }),
  captureEvidence: (runId: string, stepId: number) => invoke<string>('capture_evidence', { runId, stepId }),
  setRunStatus: (runId: string, status: string) => invoke<void>('set_run_status', { runId, status }),
  exportReport: (runId: string) => invoke<string>('export_report', { runId })
};
