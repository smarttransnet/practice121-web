/**
 * FavoritesService.js
 *
 * Fetches doctor's favourite medicines from backend API /api/favorites.
 * Provides fallback dataset if API is unreachable.
 */

const baseUrl = import.meta.env.DEV
  ? 'https://localhost:44324'
  : 'https://practice121-api-687271578749.asia-southeast1.run.app';

export const DEFAULT_FALLBACK_FAVORITES = [
  {
    id: '1',
    genericName: 'Metformin',
    brandName: 'Glucophage',
    dose: '500 mg',
    frequency: 'BD',
    duration: '30 days',
  },
  {
    id: '2',
    genericName: 'Paracetamol',
    brandName: 'Panadol',
    dose: '500 mg',
    frequency: 'TDS',
    duration: '5 days',
  },
  {
    id: '3',
    genericName: 'Amoxicillin',
    brandName: 'Amoxil',
    dose: '500 mg',
    frequency: 'TDS',
    duration: '7 days',
  },
  {
    id: '4',
    genericName: 'Omeprazole',
    brandName: 'Losec',
    dose: '20 mg',
    frequency: 'Daily',
    duration: '14 days',
  },
  {
    id: '5',
    genericName: 'Cetirizine',
    brandName: 'Zyrtec',
    dose: '10 mg',
    frequency: 'Nightly',
    duration: '10 days',
  },
  {
    id: '6',
    genericName: 'Salbutamol',
    brandName: 'Ventolin',
    dose: '100 mcg',
    frequency: 'PRN',
    duration: 'As needed',
  },
];

export async function fetchFavorites() {
  try {
    const response = await fetch(`${baseUrl}/api/favorites`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.map((item) => ({
          id: item.id || String(Math.random()),
          genericName: item.genericName || item.GenericName || '',
          brandName: item.brandName || item.BrandName || '',
          dose: item.dose || item.Dose || '',
          frequency: item.frequency || item.Frequency || '',
          duration: item.duration || item.Duration || '',
        }));
      }
    }
  } catch (err) {
    console.warn('Failed to fetch favorites from API, using fallback:', err);
  }
  return DEFAULT_FALLBACK_FAVORITES;
}
