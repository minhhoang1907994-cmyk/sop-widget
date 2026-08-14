export type Role = 'admin' | 'member';
export type SessionClient = 'app' | 'web';
export type RunStatus = 'running' | 'completed' | 'cancelled';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  is_active: number;
  must_change_password: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  client: SessionClient;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface AuthContext {
  user: UserRow;
  sessionId: number;
  client: SessionClient;
  expiresAt: string;
}

/** Hình dạng tài khoản trả cho admin (§5.2 GET /users). */
export interface AdminUserView {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string | null;
}

/** Hình dạng tài khoản trả cho member — chỉ đủ để chọn người nhận. */
export interface MemberUserView {
  id: number;
  display_name: string;
}

export interface ReportRow {
  id: string;
  run_id: string;
  sender_id: number;
  procedure_name: string;
  operator_display_name: string;
  run_started_at: string;
  run_status: RunStatus;
  storage_path: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export interface RecipientView {
  id: number;
  display_name: string;
  first_viewed_at: string | null;
}

export interface ReportSummary {
  id: string;
  run_id: string;
  procedure_name: string;
  operator_display_name: string;
  run_started_at: string | null;
  run_status: RunStatus;
  size_bytes: number;
  created_at: string | null;
  sender: { id: number; display_name: string };
  first_viewed_at?: string | null;
  recipients?: RecipientView[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
