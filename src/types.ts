export type Step = {
  id: number;
  procedure_id: number;
  order_index: number;
  title: string;
  description: string;
  command?: string | null;
  requires_evidence: boolean;
};

export type Procedure = {
  id: number;
  name: string;
  description: string;
  category?: string | null;
  created_at: string;
  updated_at: string;
  steps: Step[];
};

export type StepInput = Omit<Step, 'id' | 'procedure_id' | 'order_index'> & { id?: number };
export type ProcedureInput = {
  id?: number;
  name: string;
  description: string;
  category?: string;
  steps: StepInput[];
};

export type Execution = {
  id: number;
  run_id: string;
  step_id: number;
  confirmed_at?: string | null;
  notes?: string | null;
  evidence_path?: string | null;
  captured_at?: string | null;
  evidence_hash?: string | null;
};

export type Run = {
  id: string;
  procedure_id: number;
  status: 'running' | 'completed' | 'cancelled';
  started_at: string;
  completed_at?: string | null;
  operator_name?: string | null;
  procedure_name?: string;
  confirmed_count?: number;
  evidence_count?: number;
};

export type RunDetails = { run: Run; procedure: Procedure; executions: Execution[] };

/**
 * Phiên đăng nhập. Cố ý KHÔNG có `token` — token thô chỉ nằm ở phía Rust và trong SQLite
 * local, frontend không bao giờ giữ nó (§13 của docs/spec/login-report-sharing.md).
 */
export type AuthSession = {
  user_id: number;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  expires_at: string;
  server_url: string;
  must_change_password: boolean;
};

export type Member = {
  id: number;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  is_active: boolean;
  must_change_password: boolean;
};

/** Người nhận trong bộ chọn — server trả cho member đúng hai field này. */
export type Recipient = { id: number; display_name: string };

export type SharedReport = {
  report_id: string;
  share_url: string;
  local_path: string;
  size_bytes: number;
  recipients: Recipient[];
};

export type InboxItem = {
  report_id: string;
  run_id: string;
  procedure_name: string;
  operator_display_name: string;
  sender_display_name: string;
  run_status: Run['status'];
  created_at: string;
  size_bytes: number;
  first_viewed_at?: string | null;
  share_url: string;
};
