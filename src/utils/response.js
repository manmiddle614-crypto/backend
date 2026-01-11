export function successResponse(data = null, message = "Success") {
  return {
    success: true,
    data,
    error: null,
    message,
  }
}

export function errorResponse(message, code = "ERROR") {
  return {
    success: false,
    data: null,
    error: {
      message,
      code,
    },
  }
}
