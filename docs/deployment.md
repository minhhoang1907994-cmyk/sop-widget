# Triển khai server SOP Widget

Hướng dẫn cho môi trường server dùng chung (`54.178.76.191` hoặc máy tương đương).
Phần đặc tả đầy đủ: [`spec/login-report-sharing.md`](spec/login-report-sharing.md).

---

## ⚠️ Điều kiện chặn trước khi cho người thật dùng

**Máy chủ đang phục vụ qua `http://` trên IP công cộng.** Những thứ sau sẽ truyền không mã hóa:

- Mật khẩu lúc đăng nhập
- Token phiên (dùng được 30 ngày)
- Toàn bộ file báo cáo HTML — trong đó **ảnh chụp màn hình có thể chứa credential, token,
  dữ liệu khách hàng** (xem §12 của `spec/sop-widget.md`)

Bất kỳ ai trên đường truyền đọc được những thứ này. Đây là lý do quy tắc #10 của `CLAUDE.md`
ghi "chưa deploy lên server thật khi chưa có HTTPS".

Ba cách xử lý, chọn một trước khi phát tài khoản cho người dùng:

| Cách | Việc cần làm | Ghi chú |
|---|---|---|
| Domain + HTTPS | Trỏ một domain về IP, dựng Caddy hoặc nginx làm reverse proxy, lấy chứng chỉ Let's Encrypt | Cách chuẩn. Caddy tự xin và tự gia hạn chứng chỉ |
| Đặt sau VPN | Chỉ mở cổng cho dải IP nội bộ / VPN, không mở ra Internet | Không cần domain, nhưng người dùng phải vào VPN |
| Chấp nhận rủi ro | Cần **văn bản xác nhận của PM** | Chỉ dùng cho giai đoạn thử nội bộ, không dùng với dữ liệu thật |

Nếu chỉ để thử nghiệm nội bộ: giới hạn Security Group của EC2 chỉ cho IP của team, đừng mở `0.0.0.0/0`.

---

## Bước 0 — Đưa code lên remote (làm ở máy dev, trước khi ra server)

Server `git pull` chỉ lấy được thứ đã push. Kiểm tra trước:

```bash
git status --short          # phải sạch
git log --oneline -1        # commit mới nhất phải chứa server/
git push origin <branch>
```

---

## Bước 1 — Chuẩn bị máy chủ

Cần Docker và Docker Compose. Trên Ubuntu:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER   # đăng nhập lại để có hiệu lực
docker --version && docker compose version
```

Mở cổng cho ứng dụng — chỉ cổng của app, **không mở 3306**:

```bash
sudo ufw allow 8080/tcp    # hoặc 80/443 nếu dùng reverse proxy
```

Trên EC2 phải mở cả Security Group tương ứng trong AWS Console.

---

## Bước 2 — Lấy code

```bash
git clone <repo-url> sop-widget      # lần đầu
# hoặc
cd sop-widget && git pull
```

---

## Bước 3 — File cần sửa: `server/.env`

Đây là **file duy nhất** cần sửa để kết nối DB. Không commit file này.

```bash
cd sop-widget/server
cp .env.example .env
nano .env
```

Giá trị cho môi trường server:

```ini
TZ=UTC
PORT=8080
HOST=0.0.0.0

# Địa chỉ người dùng và app truy cập vào. Dùng để dựng link chia sẻ báo cáo,
# nên phải là địa chỉ nhìn từ bên ngoài, không phải localhost.
PUBLIC_BASE_URL=http://54.178.76.191:8080

# MySQL — "db" là tên service trong docker-compose, không phải 127.0.0.1
DB_HOST=db
DB_PORT=3306
DB_USER=sop
DB_PASSWORD=<mật khẩu mạnh, không dùng lại của môi trường dev>
DB_NAME=sop_widget
DB_ROOT_PASSWORD=<mật khẩu root mạnh, khác mật khẩu trên>

STORAGE_DIR=/data/reports

SESSION_TTL_DAYS=30
MAX_UPLOAD_MB=25
LOGIN_RATE_LIMIT=10
LOGIN_RATE_WINDOW_MINUTES=15

# Tài khoản admin đầu tiên. Đổi mật khẩu ngay ở lần đăng nhập đầu (app tự ép).
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_DISPLAY_NAME=Quản trị viên
SEED_ADMIN_PASSWORD=<mật khẩu tạm mạnh>
```

Ba điểm dễ sai:

1. **`DB_HOST=db`**, không phải `127.0.0.1` — khi chạy bằng Docker Compose thì `api` gọi `db`
   qua tên service. Để `127.0.0.1` là container tự gọi chính nó và báo `ECONNREFUSED`.
2. **`STORAGE_DIR=/data/reports`** — đường dẫn *bên trong* container, đã map sang volume
   `report-data`. Đừng đổi thành đường dẫn của host.
3. **`PUBLIC_BASE_URL`** phải là địa chỉ nhìn từ bên ngoài. Nếu để `localhost` thì link chia sẻ
   gửi cho người khác sẽ trỏ về máy của chính họ.

---

## Bước 4 — Khởi động

```bash
cd sop-widget/server
docker compose up -d --build
docker compose ps            # cả db và api phải Up, db phải healthy
docker compose logs -f api   # xem log khởi động
```

Migration **tự chạy** khi `api` khởi động (`src/index.ts` gọi `runMigrations()`), ghi tên file đã
chạy vào bảng `schema_migrations` nên khởi động lại nhiều lần không sao.

Kiểm tra server đã sống:

```bash
curl -s http://localhost:8080/healthz     # {"status":"ok"}
```

---

## Bước 5 — Tạo tài khoản admin đầu tiên

Không tự động — phải chạy một lần:

```bash
docker compose exec api node dist/db/seed-admin.js
```

Dùng `node dist/db/seed-admin.js`, **không** dùng `npm run seed:admin`: script đó gọi `tsx`,
là devDependency và không có trong image production.

Chạy lại nhiều lần cũng an toàn — nếu tài khoản đã tồn tại thì không ghi đè mật khẩu.

Xác nhận đăng nhập được:

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<SEED_ADMIN_PASSWORD>"}'
```

Phải trả về `token` và `must_change_password: true`.

---

## Bước 6 — Trỏ app trên máy người dùng về server

Trên **từng máy** cài SOP Widget, sửa file:

```
%APPDATA%\NTA\SOP Widget\server.env
```

```ini
SOP_SERVER_URL=http://54.178.76.191:8080
```

File này được app tự tạo ở lần chạy đầu. Sửa xong **mở lại app**.

Cách khác: đặt biến môi trường `SOP_SERVER_URL` ở cấp hệ thống — biến môi trường được ưu tiên
hơn file. Xem §4.4 của `spec/login-report-sharing.md`.

---

## Vận hành

```bash
docker compose logs -f api          # xem log
docker compose restart api          # khởi động lại app
docker compose down                 # dừng (giữ dữ liệu trong volume)
docker compose up -d --build        # cập nhật sau khi git pull
```

Sau `git pull` có thay đổi code thì phải `--build`, nếu không container vẫn chạy image cũ.

### Sao lưu

Hai thứ cần backup, thiếu một trong hai là báo cáo mất giá trị:

```bash
# 1. Database
docker compose exec db mysqldump -u root -p"$DB_ROOT_PASSWORD" sop_widget > backup-$(date +%F).sql

# 2. File báo cáo HTML (volume report-data)
docker run --rm -v server_report-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/reports-$(date +%F).tar.gz -C /data .
```

Bảng `reports` chỉ giữ **đường dẫn tương đối** tới file; backup DB mà không backup volume thì
mọi báo cáo cũ trở thành bản ghi trỏ vào chỗ trống.

### Admin quên mật khẩu

Chưa có chức năng này trong app (xem §18.3 của spec). Người phụ trách server phải sửa trực tiếp:

```bash
docker compose exec db mysql -u root -p"$DB_ROOT_PASSWORD" sop_widget
```

```sql
-- Buộc đổi mật khẩu ở lần đăng nhập tới và thu hồi mọi phiên hiện có
UPDATE users SET password_hash = '<hash Argon2id sinh sẵn>', must_change_password = 1 WHERE username = 'admin';
UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = (SELECT id FROM users WHERE username = 'admin');
```

Hash Argon2id sinh bằng:

```bash
docker compose exec api node -e "import('@node-rs/argon2').then(a=>a.hash('<mật khẩu mới>',{memoryCost:19456,timeCost:2,parallelism:1}).then(console.log))"
```

---

## Chưa kiểm chứng

- **Image `api` chưa từng được build.** `docker compose up -d --build` là lần đầu — nếu lỗi,
  khả năng cao nằm ở bước `npm install` của `@node-rs/argon2` trong image `node:24-slim`.
- Toàn bộ hướng dẫn này viết từ cấu hình trong repo, **chưa chạy thật trên `54.178.76.191`**.
