import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
	...base,
	projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
	// The fixture API mocks must receive requests instead of the service worker.
	use: { ...base.use, serviceWorkers: 'block' },
});
