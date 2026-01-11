import logger from '../utils/logger.js';

/**
 * Image optimization middleware
 * Sets proper caching headers for images
 */
export const imageOptimization = (req, res, next) => {
  const ext = req.path.split('.').pop().toLowerCase();
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico'];
  
  if (imageExtensions.includes(ext)) {
    // Cache images for 1 year
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Expires', new Date(Date.now() + 31536000000).toUTCString());
    
    logger.debug('[IMAGE] Serving optimized image', { path: req.path });
  }
  
  next();
};

/**
 * Compression headers for API responses
 */
export const compressionHeaders = (req, res, next) => {
  res.setHeader('Vary', 'Accept-Encoding');
  next();
};
