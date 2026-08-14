import { config } from './config.js';

/**
 * Bộ đếm đăng nhập sai dùng chung cho `POST /api/v1/auth/login` và `POST /login` (§12) —
 * hai kênh không được phép luân phiên để nhân đôi hạn mức.
 *
 * Lưu trong bộ nhớ tiến trình: đủ cho quy mô một instance mà §15 đặt ra. Nếu sau này
 * chạy nhiều instance thì phải chuyển sang kho dùng chung, nếu không mỗi instance đếm riêng.
 */
interface Attempt {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, Attempt>();

function windowMs(): number {
  return config.loginRateWindowMinutes * 60 * 1000;
}

function keysFor(ip: string, username: string): string[] {
  return [`ip:${ip}`, `user:${username.toLowerCase()}`];
}

export function isLoginBlocked(ip: string, username: string): boolean {
  const nowMs = Date.now();
  return keysFor(ip, username).some(key => {
    const entry = attempts.get(key);
    if (!entry) return false;
    if (entry.resetAt <= nowMs) {
      attempts.delete(key);
      return false;
    }
    return entry.count >= config.loginRateLimit;
  });
}

export function recordLoginFailure(ip: string, username: string): void {
  const nowMs = Date.now();
  for (const key of keysFor(ip, username)) {
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      attempts.set(key, { count: 1, resetAt: nowMs + windowMs() });
    } else {
      entry.count += 1;
    }
  }
}

export function clearLoginFailures(ip: string, username: string): void {
  for (const key of keysFor(ip, username)) attempts.delete(key);
}

/** Chỉ dùng trong test để cô lập từng case. */
export function resetLoginLimiter(): void {
  attempts.clear();
}
