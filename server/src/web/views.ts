/** Escape cùng bộ ký tự với hàm `html()` phía Rust (`src-tauri/src/lib.rs`). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  body { font: 15px "Segoe UI", Arial, sans-serif; color: #172b4d; background: #f4f6fa;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #d0d5dd; border-radius: 10px; padding: 28px 32px;
          width: 320px; box-shadow: 0 2px 8px rgba(16, 24, 40, .06); }
  h1 { font-size: 18px; color: #0f6cbd; margin: 0 0 18px; }
  label { display: block; font-size: 13px; margin-bottom: 12px; }
  input { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px 10px;
          border: 1px solid #d0d5dd; border-radius: 6px; font-size: 14px; }
  button { width: 100%; padding: 9px; border: 0; border-radius: 6px; background: #0f6cbd;
           color: #fff; font-size: 14px; cursor: pointer; }
  .error { background: #fceaea; border: 1px solid #e6b3b3; color: #a32d2d; border-radius: 6px;
           padding: 8px 10px; font-size: 13px; margin-bottom: 14px; }
  .note { font-size: 12px; color: #5e6c84; margin-top: 14px; }
`;

export function loginPage(options: { next: string; error?: string }): string {
  const error = options.error ? `<div class="error">${escapeHtml(options.error)}</div>` : '';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Đăng nhập — SOP Widget</title><style>${STYLE}</style></head><body>
<div class="card">
  <h1>Đăng nhập để xem báo cáo</h1>
  ${error}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${escapeHtml(options.next)}">
    <label>Tên đăng nhập<input name="username" autocomplete="username" autofocus required></label>
    <label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Đăng nhập</button>
  </form>
  <p class="note">Dùng đúng tài khoản đã được cấp trong SOP Widget.</p>
</div></body></html>`;
}

export function messagePage(title: string, message: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — SOP Widget</title><style>${STYLE}</style></head><body>
<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>
</body></html>`;
}
