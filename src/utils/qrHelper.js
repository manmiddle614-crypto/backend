import crypto from "crypto"

export function generateQrToken(qrCodeId, secret) {
  const payload = Buffer.from(
    JSON.stringify({
      qrCodeId,
      issuedAt: new Date().toISOString(),
    }),
  ).toString("base64")

  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex")

  return `${payload}.${signature}`
}

export function verifyQrToken(token, secret) {
  try {
    const [payload, signature] = token.split(".")

    if (!payload || !signature) {
      return { valid: false }
    }

    const expectedSignature = crypto.createHmac("sha256", secret).update(payload).digest("hex")

    if (signature !== expectedSignature) {
      return { valid: false }
    }

    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"))
    return { valid: true, qrCodeId: decoded.qrCodeId, issuedAt: decoded.issuedAt }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}
