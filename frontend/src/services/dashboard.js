import api from './api';

export const getDashboard = (token, locationId) => api.get('/dashboard', {
  params: locationId && locationId !== 'all' ? { locationId } : undefined,
  headers: { Authorization: `Bearer ${token}` },
});

export const getDashboardLocations = (token) => api.get('/locations', {
  headers: { Authorization: `Bearer ${token}` },
});
