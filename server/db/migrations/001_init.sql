-- Schema khởi tạo theo §4.2 của docs/spec/login-report-sharing.md.
-- Mọi cột thời gian lưu UTC; tiến trình MySQL và backend đều chạy TZ=UTC.

CREATE TABLE IF NOT EXISTS users (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username             VARCHAR(64)     NOT NULL,
  display_name         VARCHAR(128)    NOT NULL,
  password_hash        VARCHAR(255)    NOT NULL,
  role                 ENUM('admin','member') NOT NULL DEFAULT 'member',
  is_active            TINYINT(1)      NOT NULL DEFAULT 1,
  must_change_password TINYINT(1)      NOT NULL DEFAULT 0,
  created_at           DATETIME(3)     NOT NULL,
  updated_at           DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  token_hash   CHAR(64)        NOT NULL,
  client       ENUM('app','web') NOT NULL,
  expires_at   DATETIME(3)     NOT NULL,
  revoked_at   DATETIME(3)     NULL,
  created_at   DATETIME(3)     NOT NULL,
  last_used_at DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_user (user_id, revoked_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reports (
  id                    CHAR(36)        NOT NULL,
  run_id                CHAR(36)        NOT NULL,
  sender_id             BIGINT UNSIGNED NOT NULL,
  procedure_name        VARCHAR(255)    NOT NULL,
  operator_display_name VARCHAR(128)    NOT NULL,
  run_started_at        DATETIME(3)     NOT NULL,
  run_status            ENUM('running','completed','cancelled') NOT NULL,
  storage_path          VARCHAR(512)    NOT NULL,
  size_bytes            INT UNSIGNED    NOT NULL,
  sha256                CHAR(64)        NOT NULL,
  created_at            DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_reports_sender (sender_id, created_at),
  KEY idx_reports_run (run_id),
  CONSTRAINT fk_reports_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS report_recipients (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id       CHAR(36)        NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  first_viewed_at DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_report_recipient (report_id, user_id),
  KEY idx_recipient_user (user_id, created_at),
  CONSTRAINT fk_recipients_report FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE,
  CONSTRAINT fk_recipients_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
