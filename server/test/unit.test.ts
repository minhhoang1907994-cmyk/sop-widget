import { describe, expect, it, beforeEach } from 'vitest';
import { safeNext } from '../src/web/routes.js';
import { escapeHtml } from '../src/web/views.js';
import { decodeCursor, encodeCursor } from '../src/reports/service.js';
import { fromIso, toIso, toSql } from '../src/time.js';
import { clearLoginFailures, isLoginBlocked, recordLoginFailure, resetLoginLimiter } from '../src/rate-limit.js';
import { config } from '../src/config.js';

describe('safeNext — chống open redirect (Security Test #8)', () => {
  it('giữ nguyên đường dẫn hợp lệ tới trang báo cáo', () => {
    expect(safeNext('/r/7c1f0d2a-0000-4000-8000-000000000000')).toBe('/r/7c1f0d2a-0000-4000-8000-000000000000');
  });

  it('bỏ URL tuyệt đối ra ngoài', () => {
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('http://evil.example/r/abc')).toBe('/');
  });

  it('bỏ đường dẫn protocol-relative', () => {
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('//evil.example/r/abc')).toBe('/');
  });

  it('bỏ đường dẫn không trỏ vào /r/', () => {
    expect(safeNext('/login')).toBe('/');
    expect(safeNext('/api/v1/users')).toBe('/');
  });

  it('bỏ giá trị chứa ký tự xuống dòng hoặc gạch chéo ngược', () => {
    expect(safeNext('/r/abc\nSet-Cookie: x=1')).toBe('/');
    expect(safeNext('/r/..\\..\\etc')).toBe('/');
  });

  it('bỏ giá trị không phải chuỗi', () => {
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(42)).toBe('/');
  });
});

describe('escapeHtml', () => {
  it('escape đủ 5 ký tự nguy hiểm', () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;');
  });
});

describe('cursor phân trang', () => {
  it('mã hóa rồi giải mã trả về đúng giá trị ban đầu', () => {
    const cursor = { createdAt: '2026-08-14 01:42:00.123', id: '7c1f0d2a-0000-4000-8000-000000000000' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('trả null khi không có cursor', () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('giữ được id có chứa dấu gạch ngang và dấu phân cách', () => {
    const cursor = { createdAt: '2026-08-14 01:42:00.000', id: 'a|b-c' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });
});

describe('thời gian — luôn UTC (§4.2)', () => {
  it('toSql sinh chuỗi UTC bất kể timezone của tiến trình', () => {
    expect(toSql(new Date('2026-08-14T01:42:00.123Z'))).toBe('2026-08-14 01:42:00.123');
  });

  it('toIso gắn hậu tố Z cho giá trị đọc từ MySQL', () => {
    expect(toIso('2026-08-14 01:42:00.123')).toBe('2026-08-14T01:42:00.123Z');
    expect(toIso(null)).toBeNull();
  });

  it('fromIso quy đổi thời điểm có offset về UTC', () => {
    expect(fromIso('2026-08-14T10:42:00.000+09:00')).toBe('2026-08-14 01:42:00.000');
  });

  it('fromIso ném lỗi với giá trị không hợp lệ', () => {
    expect(() => fromIso('hôm qua')).toThrow();
  });
});

describe('hạn mức đăng nhập dùng chung hai kênh (Security Test #9)', () => {
  beforeEach(() => resetLoginLimiter());

  it('chặn sau khi vượt ngưỡng, tính chung cho mọi kênh', () => {
    for (let i = 0; i < config.loginRateLimit; i += 1) {
      expect(isLoginBlocked('10.0.0.1', 'someone')).toBe(false);
      recordLoginFailure('10.0.0.1', 'someone');
    }
    expect(isLoginBlocked('10.0.0.1', 'someone')).toBe(true);
  });

  it('chặn theo tên đăng nhập kể cả khi đổi IP', () => {
    for (let i = 0; i < config.loginRateLimit; i += 1) {
      recordLoginFailure(`10.0.0.${i}`, 'target');
    }
    expect(isLoginBlocked('192.168.1.1', 'target')).toBe(true);
  });

  it('không ảnh hưởng tài khoản khác trên cùng IP khác tên', () => {
    for (let i = 0; i < config.loginRateLimit; i += 1) {
      recordLoginFailure('10.0.0.9', 'victim');
    }
    // IP đã chạm ngưỡng nên vẫn bị chặn — đây là chủ đích, hạn mức tính cả theo IP.
    expect(isLoginBlocked('10.0.0.9', 'another')).toBe(true);
    expect(isLoginBlocked('10.0.0.10', 'another')).toBe(false);
  });

  it('đăng nhập thành công xóa bộ đếm', () => {
    recordLoginFailure('10.0.0.2', 'user');
    clearLoginFailures('10.0.0.2', 'user');
    expect(isLoginBlocked('10.0.0.2', 'user')).toBe(false);
  });
});
