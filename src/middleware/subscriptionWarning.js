/**
 * Middleware to inject subscription warnings into responses
 */
export const injectSubscriptionWarning = (req, res, next) => {
  if (req.subscriptionWarning) {
    const originalJson = res.json.bind(res);
    
    res.json = function(data) {
      if (data && typeof data === 'object') {
        data.subscriptionWarning = req.subscriptionWarning;
      }
      return originalJson(data);
    };
  }
  next();
};
