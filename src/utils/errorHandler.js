export function errorHandler(error, req, res, next) {
  const statusCode = error.statusCode || 500;
  const message = error.message || "Internal server error";

  console.error('❌ Error:', {
    statusCode,
    message,
    code: error.code,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  });

  res.status(statusCode).json({
    success: false,
    data: null,
    error: {
      message,
      code: error.code || "INTERNAL_ERROR",
    },
  });
}

export class ApiError extends Error {
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = "ApiError";
  }
}
