import type { FastifyReply } from 'fastify';

// Message nghiệp vụ viết tiếng Việt vì hiển thị thẳng cho người dùng cuối — cùng quy ước
// với phía Rust của app (xem CLAUDE.md, mục Error Handling).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    override readonly message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const errors = {
  validation: (message = 'Dữ liệu gửi lên không hợp lệ.') => new ApiError(400, 'VALIDATION_ERROR', message),
  noRecipient: () => new ApiError(400, 'NO_RECIPIENT', 'Vui lòng chọn ít nhất một người nhận.'),
  invalidCredentials: (message = 'Tên đăng nhập hoặc mật khẩu không đúng.') =>
    new ApiError(401, 'INVALID_CREDENTIALS', message),
  unauthenticated: () =>
    new ApiError(401, 'UNAUTHENTICATED', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'),
  forbidden: (message = 'Bạn không có quyền thực hiện thao tác này.') => new ApiError(403, 'FORBIDDEN', message),
  accountDisabled: () =>
    new ApiError(403, 'ACCOUNT_DISABLED', 'Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên.'),
  passwordChangeRequired: () =>
    new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Bạn cần đổi mật khẩu trước khi tiếp tục.'),
  notFound: (message = 'Không tìm thấy dữ liệu.') => new ApiError(404, 'NOT_FOUND', message),
  reportNotFound: () => new ApiError(404, 'NOT_FOUND', 'Không tìm thấy báo cáo.'),
  userNotFound: () => new ApiError(404, 'NOT_FOUND', 'Không tìm thấy tài khoản.'),
  recipientNotFound: () =>
    new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Người nhận không tồn tại hoặc đã bị vô hiệu hóa.'),
  usernameTaken: () => new ApiError(409, 'USERNAME_TAKEN', 'Tên đăng nhập đã tồn tại.'),
  lastAdmin: () =>
    new ApiError(409, 'LAST_ADMIN', 'Không thể vô hiệu hóa hoặc hạ quyền quản trị viên cuối cùng.'),
  fileTooLarge: (limitMb: number) =>
    new ApiError(413, 'FILE_TOO_LARGE', `Báo cáo vượt quá dung lượng cho phép (${limitMb} MB).`),
  unsupportedType: () => new ApiError(415, 'UNSUPPORTED_TYPE', 'Chỉ chấp nhận tệp báo cáo HTML.'),
  tooManyRequests: () =>
    new ApiError(429, 'TOO_MANY_REQUESTS', 'Bạn đã thử quá nhiều lần. Vui lòng đợi ít phút.'),
  storageFull: () => new ApiError(507, 'STORAGE_FULL', 'Máy chủ không còn dung lượng lưu báo cáo.')
};

export function sendError(reply: FastifyReply, error: ApiError): FastifyReply {
  return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
}
