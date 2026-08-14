import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/service.js';
import { execute, pool, queryOne } from '../src/db.js';
import { resetLoginLimiter } from '../src/rate-limit.js';
import { now, toSql } from '../src/time.js';
import type { Role } from '../src/types.js';

/**
 * Test tích hợp — cần MySQL đang chạy (docker compose up -d db).
 * Chạy: npm test
 */
let app: FastifyInstance;

async function createUser(
  username: string,
  role: Role,
  options: { password?: string; mustChange?: boolean; active?: boolean } = {}
): Promise<number> {
  const stamp = toSql(now());
  const result = await execute(
    `INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      username,
      `Người dùng ${username}`,
      await hashPassword(options.password ?? 'password-1234'),
      role,
      options.active === false ? 0 : 1,
      options.mustChange ? 1 : 0,
      stamp,
      stamp
    ]
  );
  return result.insertId;
}

async function login(username: string, password = 'password-1234'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password }
  });
  expect(response.statusCode, `đăng nhập ${username} thất bại: ${response.body}`).toBe(200);
  return response.json().data.token as string;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const REPORT_HTML = Buffer.from('<!doctype html><h1>Báo cáo</h1>', 'utf8');

function multipartBody(fields: Record<string, string | string[]>, filename = 'report.html'): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----sopwidgettest';
  const chunks: Buffer[] = [];
  for (const [name, raw] of Object.entries(fields)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      );
    }
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/html\r\n\r\n'
    ),
    REPORT_HTML,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
}

async function uploadReport(
  token: string,
  recipientIds: number[]
): Promise<{ statusCode: number; body: string; json: () => any }> {
  const { payload, headers } = multipartBody({
    run_id: '7c1f0d2a-0000-4000-8000-000000000000',
    procedure_name: 'Deploy Rails lên EC2',
    operator_display_name: 'Nguyễn Văn A',
    run_started_at: '2026-08-14T01:10:00.000Z',
    run_status: 'completed',
    recipient_ids: recipientIds.map(String)
  });
  return app.inject({
    method: 'POST',
    url: '/api/v1/reports',
    payload,
    headers: { ...headers, ...bearer(token) }
  });
}

beforeAll(async () => {
  await runMigrations();
  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
});

beforeEach(async () => {
  resetLoginLimiter();
  await execute('DELETE FROM report_recipients');
  await execute('DELETE FROM reports');
  await execute('DELETE FROM sessions');
  await execute('DELETE FROM users');
});

describe('BR-16 — mọi endpoint đều cần phiên hợp lệ', () => {
  const guarded: [string, string][] = [
    ['GET', '/api/v1/auth/me'],
    ['POST', '/api/v1/auth/logout'],
    ['POST', '/api/v1/auth/password'],
    ['GET', '/api/v1/users'],
    ['POST', '/api/v1/users'],
    ['PATCH', '/api/v1/users/1'],
    ['POST', '/api/v1/users/1/password-reset'],
    ['POST', '/api/v1/reports'],
    ['GET', '/api/v1/reports/inbox'],
    ['GET', '/api/v1/reports/sent'],
    ['GET', '/api/v1/reports/abc'],
    ['GET', '/api/v1/reports/abc/content']
  ];

  it.each(guarded)('%s %s trả 401 khi không có token', async (method, url) => {
    const response = await app.inject({ method: method as 'GET', url, payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('token đã thu hồi không dùng được nữa', async () => {
    await createUser('u1', 'member');
    const token = await login('u1');
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(token) });
    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(token) });
    expect(after.statusCode).toBe(401);
  });
});

describe('BR-17 — chỉ admin quản lý tài khoản', () => {
  it('member tạo tài khoản → 403 (Security Test #2)', async () => {
    await createUser('member1', 'member');
    const token = await login('member1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(token),
      payload: { username: 'hacker', display_name: 'Hacker', password: 'password-1234' }
    });
    expect(response.statusCode).toBe(403);
  });

  it('member tự nâng quyền mình lên admin → 403 (Security Test #3)', async () => {
    const id = await createUser('member2', 'member');
    const token = await login('member2');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: bearer(token),
      payload: { role: 'admin' }
    });
    expect(response.statusCode).toBe(403);
    const fresh = await queryOne<{ role: string }>('SELECT role FROM users WHERE id = ?', [id]);
    expect(fresh?.role).toBe('member');
  });

  it('admin tạo tài khoản mới, tài khoản đó bị buộc đổi mật khẩu lần đầu', async () => {
    await createUser('admin1', 'admin');
    const token = await login('admin1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(token),
      payload: { username: 'newbie', display_name: 'Người mới', password: 'password-1234' }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.must_change_password).toBe(true);
  });

  it('username trùng → 409 USERNAME_TAKEN', async () => {
    await createUser('admin1', 'admin');
    await createUser('taken', 'member');
    const token = await login('admin1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(token),
      payload: { username: 'taken', display_name: 'Trùng', password: 'password-1234' }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('USERNAME_TAKEN');
  });
});

describe('409 LAST_ADMIN — không tự khóa hệ thống (Edge #17)', () => {
  it('admin cuối cùng không tự hạ quyền được', async () => {
    const id = await createUser('onlyadmin', 'admin');
    const token = await login('onlyadmin');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: bearer(token),
      payload: { role: 'member' }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LAST_ADMIN');
  });

  it('admin cuối cùng không bị vô hiệu hóa được', async () => {
    const id = await createUser('onlyadmin', 'admin');
    const token = await login('onlyadmin');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: bearer(token),
      payload: { is_active: false }
    });
    expect(response.statusCode).toBe(409);
  });

  it('còn admin khác thì hạ quyền được', async () => {
    const first = await createUser('admin1', 'admin');
    await createUser('admin2', 'admin');
    const token = await login('admin2');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${first}`,
      headers: bearer(token),
      payload: { role: 'member' }
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('BR-26 — đặt lại và đổi mật khẩu thu hồi phiên', () => {
  it('admin reset mật khẩu → phiên của member hết hiệu lực (Edge #7)', async () => {
    await createUser('admin1', 'admin');
    const memberId = await createUser('member1', 'member');
    const adminToken = await login('admin1');
    const memberToken = await login('member1');

    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${memberId}/password-reset`,
      headers: bearer(adminToken),
      payload: { new_password: 'brand-new-9999' }
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().data.revoked_sessions).toBeGreaterThanOrEqual(1);

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(memberToken) });
    expect(after.statusCode).toBe(401);
  });

  it('tự đổi mật khẩu giữ phiên hiện tại, thu hồi phiên khác (Edge #18)', async () => {
    await createUser('member1', 'member');
    const first = await login('member1');
    const second = await login('member1');

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: bearer(second),
      payload: { current_password: 'password-1234', new_password: 'another-pass-1' }
    });
    expect(changed.statusCode).toBe(204);

    const keptAlive = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(second) });
    expect(keptAlive.statusCode).toBe(200);
    const revoked = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(first) });
    expect(revoked.statusCode).toBe(401);
  });

  it('mật khẩu mới trùng mật khẩu cũ → 400', async () => {
    await createUser('member1', 'member');
    const token = await login('member1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: bearer(token),
      payload: { current_password: 'password-1234', new_password: 'password-1234' }
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('Q15 — must_change_password chặn ở server', () => {
  it('chặn endpoint nghiệp vụ nhưng vẫn cho đổi mật khẩu', async () => {
    await createUser('fresh', 'member', { mustChange: true });
    const token = await login('fresh');

    const blocked = await app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(token) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const allowed = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(token) });
    expect(allowed.statusCode).toBe(200);

    const change = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: bearer(token),
      payload: { current_password: 'password-1234', new_password: 'changed-pass-1' }
    });
    expect(change.statusCode).toBe(204);
  });
});

describe('Đăng nhập', () => {
  it('sai tên và sai mật khẩu trả kết quả giống hệt nhau (Security Test #4)', async () => {
    await createUser('realuser', 'member');
    const wrongUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ghost', password: 'password-1234' }
    });
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'realuser', password: 'sai-mat-khau' }
    });
    expect(wrongUser.statusCode).toBe(wrongPassword.statusCode);
    expect(wrongUser.json()).toEqual(wrongPassword.json());
  });

  it('tài khoản bị vô hiệu hóa → 403 ACCOUNT_DISABLED', async () => {
    await createUser('disabled', 'member', { active: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'disabled', password: 'password-1234' }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCOUNT_DISABLED');
  });

  it('vô hiệu hóa tài khoản đang đăng nhập → phiên mất hiệu lực (Edge #12)', async () => {
    await createUser('admin1', 'admin');
    const memberId = await createUser('member1', 'member');
    const adminToken = await login('admin1');
    const memberToken = await login('member1');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${memberId}`,
      headers: bearer(adminToken),
      payload: { is_active: false }
    });
    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(memberToken) });
    expect(after.statusCode).toBe(401);
  });
});

describe('GET /api/v1/users — hình dạng theo quyền', () => {
  it('member chỉ nhận id + display_name và không thấy chính mình', async () => {
    await createUser('member1', 'member');
    await createUser('member2', 'member');
    const token = await login('member1');
    const response = await app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(token) });
    expect(response.statusCode).toBe(200);
    const data = response.json().data as Record<string, unknown>[];
    expect(data.every(item => Object.keys(item).sort().join(',') === 'display_name,id')).toBe(true);
    expect(data.some(item => item['display_name'] === 'Người dùng member1')).toBe(false);
  });

  it('admin nhận đủ trường quản lý', async () => {
    await createUser('admin1', 'admin');
    const token = await login('admin1');
    const response = await app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(token) });
    const first = response.json().data[0];
    expect(first).toHaveProperty('username');
    expect(first).toHaveProperty('is_active');
  });
});

describe('Gửi báo cáo', () => {
  it('gửi thành công, trả share_url và sha256', async () => {
    await createUser('sender', 'member');
    const recipient = await createUser('recipient', 'member');
    const token = await login('sender');

    const response = await uploadReport(token, [recipient]);
    expect(response.statusCode, response.body).toBe(201);
    const data = response.json().data;
    expect(data.share_url).toContain(`/r/${data.id}`);
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.recipients).toHaveLength(1);
  });

  it('chỉ chọn chính mình → 400 NO_RECIPIENT (Edge #20)', async () => {
    const senderId = await createUser('sender', 'member');
    const token = await login('sender');
    const response = await uploadReport(token, [senderId]);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('NO_RECIPIENT');
  });

  it('id trùng lặp bị loại âm thầm (Edge #21)', async () => {
    await createUser('sender', 'member');
    const recipient = await createUser('recipient', 'member');
    const token = await login('sender');
    const response = await uploadReport(token, [recipient, recipient, recipient]);
    expect(response.statusCode).toBe(201);
    expect(response.json().data.recipients).toHaveLength(1);
  });

  it('người nhận không tồn tại → 404 RECIPIENT_NOT_FOUND', async () => {
    await createUser('sender', 'member');
    const token = await login('sender');
    const response = await uploadReport(token, [999999]);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('RECIPIENT_NOT_FOUND');
  });

  it('người nhận đã bị vô hiệu hóa → 404 RECIPIENT_NOT_FOUND', async () => {
    await createUser('sender', 'member');
    const inactive = await createUser('gone', 'member', { active: false });
    const token = await login('sender');
    const response = await uploadReport(token, [inactive]);
    expect(response.statusCode).toBe(404);
  });
});

describe('BR-18 / BR-31 — quyền xem báo cáo', () => {
  async function seedReport(): Promise<{ id: string; senderToken: string; recipientToken: string }> {
    await createUser('sender', 'member');
    const recipientId = await createUser('recipient', 'member');
    const senderToken = await login('sender');
    const created = await uploadReport(senderToken, [recipientId]);
    expect(created.statusCode).toBe(201);
    return { id: created.json().data.id, senderToken, recipientToken: await login('recipient') };
  }

  it('người ngoài nhận 404, không phải 403 (Security Test #5)', async () => {
    const { id } = await seedReport();
    await createUser('outsider', 'member');
    const outsiderToken = await login('outsider');

    const meta = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${id}`,
      headers: bearer(outsiderToken)
    });
    const content = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${id}/content`,
      headers: bearer(outsiderToken)
    });
    expect(meta.statusCode).toBe(404);
    expect(content.statusCode).toBe(404);
  });

  it('admin đọc được báo cáo của người khác', async () => {
    const { id } = await seedReport();
    await createUser('admin1', 'admin');
    const adminToken = await login('admin1');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${id}`,
      headers: bearer(adminToken)
    });
    expect(response.statusCode).toBe(200);
  });

  it('người nhận đọc được và được ghi mốc đã xem; người gửi thì không', async () => {
    const { id, senderToken, recipientToken } = await seedReport();

    const bySender = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${id}/content`,
      headers: bearer(senderToken)
    });
    expect(bySender.statusCode).toBe(200);

    const byRecipient = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${id}/content`,
      headers: bearer(recipientToken)
    });
    expect(byRecipient.statusCode).toBe(200);
    expect(byRecipient.headers['content-security-policy']).toContain("default-src 'none'");

    const viewed = await queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM report_recipients WHERE report_id = ? AND first_viewed_at IS NOT NULL',
      [id]
    );
    expect(Number(viewed?.total)).toBe(1);
  });

  it('Q18 — người nhận không thấy danh sách người nhận khác, người gửi thì thấy', async () => {
    const { id, senderToken, recipientToken } = await seedReport();

    const asSender = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${id}`,
      headers: bearer(senderToken)
    });
    expect(asSender.json().data.recipients).toHaveLength(1);

    const asRecipient = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${id}`,
      headers: bearer(recipientToken)
    });
    expect(asRecipient.json().data.recipients).toBeUndefined();
  });

  it('inbox và sent chỉ trả báo cáo của chính người gọi', async () => {
    const { senderToken, recipientToken } = await seedReport();

    const senderInbox = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/inbox',
      headers: bearer(senderToken)
    });
    expect(senderInbox.json().data).toHaveLength(0);

    const recipientInbox = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/inbox',
      headers: bearer(recipientToken)
    });
    expect(recipientInbox.json().data).toHaveLength(1);
    expect(recipientInbox.json().data[0].recipients).toBeUndefined();

    const senderSent = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/sent',
      headers: bearer(senderToken)
    });
    expect(senderSent.json().data).toHaveLength(1);
    expect(senderSent.json().data[0].recipients).toHaveLength(1);
  });

  it('admin duyệt inbox chỉ thấy của mình, không thấy của người khác', async () => {
    await seedReport();
    await createUser('admin1', 'admin');
    const adminToken = await login('admin1');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/inbox',
      headers: bearer(adminToken)
    });
    expect(response.json().data).toHaveLength(0);
  });
});

describe('Kênh web (§5.2b)', () => {
  it('mở /r/{id} chưa đăng nhập → chuyển tới /login?next= đúng báo cáo (Edge #13)', async () => {
    const response = await app.inject({ method: 'GET', url: '/r/some-report-id' });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(`/login?next=${encodeURIComponent('/r/some-report-id')}`);
  });

  it('POST /login đặt cookie HttpOnly và chuyển về next (Edge #13, Security Test #10)', async () => {
    await createUser('webuser', 'member');
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'username=webuser&password=password-1234&next=%2Fr%2Fabc',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/r/abc');
    const cookie = response.cookies[0];
    expect(cookie?.name).toBe('sop_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
  });

  it('next trỏ ra ngoài bị bỏ (Security Test #8)', async () => {
    await createUser('webuser', 'member');
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'username=webuser&password=password-1234&next=https%3A%2F%2Fevil.example',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/');
  });

  it('đăng nhập app không tạo phiên web (Edge #14)', async () => {
    await createUser('member1', 'member');
    const token = await login('member1');
    const session = await queryOne<{ client: string }>(
      'SELECT client FROM sessions ORDER BY id DESC LIMIT 1'
    );
    expect(session?.client).toBe('app');

    const web = await app.inject({ method: 'GET', url: '/r/anything' });
    expect(web.statusCode).toBe(302);
    expect(token).toBeTruthy();
  });

  it('đăng xuất web không ảnh hưởng phiên app (Edge #15)', async () => {
    await createUser('member1', 'member');
    const appToken = await login('member1');
    const webLogin = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'username=member1&password=password-1234',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const cookie = webLogin.cookies[0]?.value ?? '';

    await app.inject({ method: 'POST', url: '/logout', cookies: { sop_session: cookie } });

    const stillValid = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(appToken) });
    expect(stillValid.statusCode).toBe(200);
  });

  it('admin reset mật khẩu thu hồi cả phiên web lẫn phiên app (Edge #16)', async () => {
    await createUser('admin1', 'admin');
    const memberId = await createUser('member1', 'member');
    const adminToken = await login('admin1');
    const appToken = await login('member1');
    const webLogin = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'username=member1&password=password-1234&next=%2Fr%2Fabc',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const cookie = webLogin.cookies[0]?.value ?? '';

    await app.inject({
      method: 'POST',
      url: `/api/v1/users/${memberId}/password-reset`,
      headers: bearer(adminToken),
      payload: { new_password: 'reset-pass-1234' }
    });

    const appAfter = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(appToken) });
    expect(appAfter.statusCode).toBe(401);

    const webAfter = await app.inject({
      method: 'GET',
      url: '/r/abc',
      cookies: { sop_session: cookie }
    });
    expect(webAfter.statusCode).toBe(302);
  });

  it('người ngoài mở link chia sẻ nhận 404 (Edge #6)', async () => {
    await createUser('sender', 'member');
    const recipientId = await createUser('recipient', 'member');
    const senderToken = await login('sender');
    const created = await uploadReport(senderToken, [recipientId]);
    const reportId = created.json().data.id;

    await createUser('outsider', 'member');
    const webLogin = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'username=outsider&password=password-1234',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const cookie = webLogin.cookies[0]?.value ?? '';

    const response = await app.inject({
      method: 'GET',
      url: `/r/${reportId}`,
      cookies: { sop_session: cookie }
    });
    expect(response.statusCode).toBe(404);
  });

  it('người nhận mở link chia sẻ xem được và có CSP chặn script', async () => {
    await createUser('sender', 'member');
    const recipientId = await createUser('recipient', 'member');
    const senderToken = await login('sender');
    const created = await uploadReport(senderToken, [recipientId]);
    const reportId = created.json().data.id;

    const webLogin = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'username=recipient&password=password-1234',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const cookie = webLogin.cookies[0]?.value ?? '';

    const response = await app.inject({
      method: 'GET',
      url: `/r/${reportId}`,
      cookies: { sop_session: cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).not.toContain('script-src');
  });
});

describe('Phân trang inbox (Edge #19)', () => {
  it('trả đúng limit và cursor dùng được cho trang kế', async () => {
    await createUser('sender', 'member');
    const recipientId = await createUser('recipient', 'member');
    const senderToken = await login('sender');
    for (let i = 0; i < 3; i += 1) {
      const response = await uploadReport(senderToken, [recipientId]);
      expect(response.statusCode).toBe(201);
    }
    const recipientToken = await login('recipient');

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/inbox?limit=2',
      headers: bearer(recipientToken)
    });
    expect(first.json().data).toHaveLength(2);
    expect(first.json().next_cursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/inbox?limit=2&cursor=${encodeURIComponent(first.json().next_cursor)}`,
      headers: bearer(recipientToken)
    });
    expect(second.json().data).toHaveLength(1);
    expect(second.json().next_cursor).toBeNull();

    const firstIds = first.json().data.map((item: { id: string }) => item.id);
    const secondIds = second.json().data.map((item: { id: string }) => item.id);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toHaveLength(0);
  });
});
