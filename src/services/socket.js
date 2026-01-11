import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger.js';

export const setupSocketIO = (server) => {
  const allowedOrigins = process.env.NODE_ENV === 'production'
    ? [process.env.FRONTEND_URL, 'https://messtracker.online', 'https://www.messtracker.online']
    : ['http://localhost:5173', 'http://localhost:3000'];

  logger.info('[SOCKET.IO] Initializing with CORS origins:', allowedOrigins);

  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        
        // Allow ngrok in development
        if (process.env.NODE_ENV !== 'production' && origin.match(/^https:\/\/.*\.ngrok-free\.dev$/)) {
          return callback(null, true);
        }
        
        logger.warn('[SOCKET.IO] CORS blocked origin:', origin);
        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
  });

  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    logger.info('[SOCKET.IO] Connection attempt', { 
      hasToken: !!token,
      origin: socket.handshake.headers.origin 
    });
    
    if (!token) {
      logger.warn('[SOCKET.IO] No token provided');
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      logger.info('[SOCKET.IO] Token verified', { userId: decoded.sub || decoded.id, role: decoded.role });
      next();
    } catch (err) {
      logger.error('[SOCKET.IO] Invalid token', { error: err.message });
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.sub || socket.user.id || socket.user._id;
    const userRole = socket.user.role;
    const messId = socket.user.messId;

    logger.info('[SOCKET.IO] Client connected', { userId, userRole, messId, socketId: socket.id });

    // Admin/Staff joins their mess room
    if (['admin', 'staff'].includes(userRole)) {
      const messRoom = `mess_${messId}`;
      socket.join(messRoom);
      logger.info('[SOCKET.IO] Joined mess room', { messRoom, userId });
    }

    // Customer joins their personal room
    if (userRole === 'customer') {
      const customerRoom = `customer_${userId}`;
      socket.join(customerRoom);
      logger.info('[SOCKET.IO] Joined customer room', { customerRoom, userId });
    }

    // Handle custom join events
    socket.on('join_customer_room', (customerId) => {
      socket.join(`customer_${customerId}`);
      logger.info('[SOCKET.IO] Manually joined customer room', { customerId });
    });

    socket.on('disconnect', () => {
      logger.info('[SOCKET.IO] Client disconnected', { userId, socketId: socket.id });
    });
  });

  return io;
};
