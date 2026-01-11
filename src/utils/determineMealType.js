export const determineMealType = () => {
  const hour = new Date().getHours();
  
  if (hour >= 6 && hour < 11) {
    return 'breakfast';
  } else if (hour >= 11 && hour < 16) {
    return 'lunch';
  } else if (hour >= 16 && hour < 22) {
    return 'dinner';
  }
  
  return null;
};
