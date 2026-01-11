import jwt from "jsonwebtoken";
import { ApiError } from "../utils/errorHandler.js";

export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return next(new ApiError("Unauthorized", 401, "UNAUTHORIZED"));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    
    // If messId not in token, fetch from database
    if (!decoded.messId && decoded.sub) {
      const { User } = await import('../models/User.js');
      const user = await User.findById(decoded.sub).select('messId').lean();
      if (user?.messId) {
        req.messId = user.messId;
        req.user.messId = user.messId;
      }
    } else if (decoded.messId) {
      req.messId = decoded.messId;
    }
    
    next();
  } catch (err) {
    return next(new ApiError("Unauthorized", 401, "UNAUTHORIZED"));
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    // User should already be set by requireAuth middleware
    if (!req.user) {
      return next(new ApiError("Unauthorized", 401, "UNAUTHORIZED"));
    }

    // Flatten roles array (handles both ['admin', 'staff'] and 'admin', 'staff')
    const allowedRoles = roles.flat();
    
    if (!allowedRoles.includes(req.user.role)) {
      return next(new ApiError(
        `Access denied. Required role: ${allowedRoles.join(' or ')}`,
        403,
        "FORBIDDEN"
      ));
    }
    
    next();
  };
}

export const requireAdmin = requireRole('admin', 'SUPER_ADMIN');
export const requireSuperAdmin = requireRole('SUPER_ADMIN');